/**
 * Global problem-solving ledger.
 *
 * Two tools and one hook:
 * - `solution_log` writes an entry (troubleshooting or decision).
 * - `solution_search` reads the ledger back.
 * - `tools/post-execute` pushes a matching confirmed entry onto a failed tool
 *   result, so a known problem is surfaced in the same step it is hit instead
 *   of waiting for the model to remember that a ledger exists.
 *
 * The plugin imports nothing from the Harness: a locally linked package cannot
 * resolve `@deepseek-ai/*` from its own directory, so every integration point
 * goes through `ctx` and the standard tool/hook contracts.
 */
import { Ledger, resolveStatePath } from './store.js'
import { searchEntries } from './search.js'
import {
  DEFAULT_MIRROR,
  DEFAULT_REGISTRY,
  PACKAGE_NAME,
  checkForUpdate,
  readOwnVersion,
} from './update.js'
import {
  checkAvailability,
  createBackup,
  listBackups,
  resolveBackupsRoot,
  resolvePackageDir,
} from './backup.js'
import { createGuard } from './guard.js'

export const name = 'solution-ledger'

/** Activation gate: the ledger is pointless without the tool registry. */
export const inject = ['tools']

const KINDS = ['troubleshoot', 'decision']
const DOMAINS = ['environment', 'tooling', 'code', 'config', 'process', 'other']
const SCOPES = ['machine', 'project', 'general']
const STATUSES = ['draft', 'confirmed', 'deprecated']
const PLATFORMS = ['win32', 'darwin', 'linux']

const DAY_MS = 86_400_000

/** Defaults mirror cordis.patch.yml; the config there is what users edit. */
const DEFAULTS = {
  pushOnToolError: true,
  // Kept in step with the weight scale in search.js: one verbatim `problem`
  // (2/token, cap 8) plus `confirmed` is exactly 10, and one accurate `signal`
  // plus a verbatim problem clears it too. At 12 a single correct signal scored
  // 11 and never surfaced, which made the written guidance ("copy the error into
  // signals") insufficient to actually get pushed.
  pushMinScore: 10,
  maxEntries: 2000,
  archiveAfterDays: 90,
  draftArchiveAfterDays: 30,
  statePath: '',
  updateCheck: true,
  updateCheckTtlMs: 300_000,
  updateCheckTimeoutMs: 8000,
  updateCheckPackage: PACKAGE_NAME,
  updateCheckRegistry: DEFAULT_REGISTRY,
  updateCheckMirror: DEFAULT_MIRROR,
  backupOnUpdate: true,
  backupPath: '',
}

/**
 * Coerce the Loader row config onto the known shape. A hand-edited patch with a
 * typo falls back per field instead of disabling the plugin.
 * @param raw - the Loader row config.
 * @returns a complete, range-checked config.
 */
function normalizeConfig(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const bool = (value, fallback) => (typeof value === 'boolean' ? value : fallback)
  const int = (value, fallback, min, max) => {
    const parsed = typeof value === 'number' ? value : Number(value)
    if (!Number.isFinite(parsed)) return fallback
    return Math.min(max, Math.max(min, Math.round(parsed)))
  }
  return {
    pushOnToolError: bool(source.pushOnToolError, DEFAULTS.pushOnToolError),
    pushMinScore: int(source.pushMinScore, DEFAULTS.pushMinScore, 1, 100),
    maxEntries: int(source.maxEntries, DEFAULTS.maxEntries, 10, 100_000),
    archiveAfterDays: int(source.archiveAfterDays, DEFAULTS.archiveAfterDays, 1, 3650),
    draftArchiveAfterDays: int(source.draftArchiveAfterDays, DEFAULTS.draftArchiveAfterDays, 1, 3650),
    statePath: typeof source.statePath === 'string' ? source.statePath : DEFAULTS.statePath,
    updateCheck: bool(source.updateCheck, DEFAULTS.updateCheck),
    // A short ceiling: a check that reuses an hour-old answer would reproduce
    // the very "already up to date" lie this feature exists to avoid.
    updateCheckTtlMs: int(source.updateCheckTtlMs, DEFAULTS.updateCheckTtlMs, 0, 3_600_000),
    updateCheckTimeoutMs: int(source.updateCheckTimeoutMs, DEFAULTS.updateCheckTimeoutMs, 1000, 30_000),
    updateCheckPackage:
      typeof source.updateCheckPackage === 'string' && source.updateCheckPackage.trim() !== ''
        ? source.updateCheckPackage.trim()
        : DEFAULTS.updateCheckPackage,
    updateCheckRegistry:
      typeof source.updateCheckRegistry === 'string' && source.updateCheckRegistry.trim() !== ''
        ? source.updateCheckRegistry.trim()
        : DEFAULTS.updateCheckRegistry,
    // An empty string disables the mirror comparison on purpose.
    updateCheckMirror:
      typeof source.updateCheckMirror === 'string' ? source.updateCheckMirror.trim() : DEFAULTS.updateCheckMirror,
    backupOnUpdate: bool(source.backupOnUpdate, DEFAULTS.backupOnUpdate),
    backupPath: typeof source.backupPath === 'string' ? source.backupPath : DEFAULTS.backupPath,
  }
}

/**
 * Collision-resistant sortable id: millisecond timestamp plus random tail.
 * @returns a new entry id.
 */
function newId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
}

/**
 * Age out entries and enforce the ceiling, in place, inside a write.
 * Deprecated entries leave search immediately; so does anything the user has
 * not touched in `archiveAfterDays`. A draft that nobody ever searched for
 * leaves on the shorter `draftArchiveAfterDays` clock: models do write the
 * occasional note that is an implementation remark rather than a problem, and
 * without this those accumulate forever as unreviewed drafts. Nothing is
 * deleted until the ceiling is actually exceeded, so every archived entry stays
 * recoverable.
 * @param ledger - the ledger being written.
 * @param config - resolved plugin config.
 */
function maintainInPlace(ledger, config) {
  const now = Date.now()
  const cutoff = now - config.archiveAfterDays * DAY_MS
  const draftCutoff = now - config.draftArchiveAfterDays * DAY_MS
  for (const snapshot of ledger.all()) {
    const entry = ledger.get(snapshot.id)
    if (entry === undefined || entry.archived === true) continue
    const lastUse = entry.lastHitAt > 0 ? entry.lastHitAt : entry.createdAt
    if (entry.status === 'deprecated' || lastUse < cutoff) {
      entry.archived = true
      continue
    }
    // Never surfaced, never confirmed, and older than the draft clock: this is
    // the shape of a remark that was never useful to anyone.
    if (entry.status === 'draft' && entry.hits === 0 && entry.createdAt < draftCutoff) {
      entry.archived = true
    }
  }
  if (ledger.size <= config.maxEntries) return
  const oldestArchived = ledger
    .all()
    .filter((entry) => entry.archived === true)
    .sort((a, b) => a.updatedAt - b.updatedAt)
  for (const entry of oldestArchived) {
    if (ledger.size <= config.maxEntries) break
    ledger.drop(entry.id)
  }
}

/**
 * Decide whether a dispatch outcome counts as a failure worth matching.
 *
 * `isError` alone is far too narrow: a shell command that exits non-zero is a
 * normal successful tool result carrying `value.exitCode`, and that is the
 * single most common way a user hits a problem. `value` is the tool's declared
 * output schema, so these fields are part of the tool contract rather than a
 * guess about its render text.
 * @param result - the dispatch outcome.
 * @returns true when the model just hit something that went wrong.
 */
function looksFailed(result) {
  if (result?.isError === true) return true
  const value = result?.value
  if (value !== null && typeof value === 'object') {
    if (typeof value.exitCode === 'number' && value.exitCode !== 0) return true
    if (value.timedOut === true) return true
    if (value.sandbox?.denied === true) return true
    // An explicit zero proves the command ran; do not fall through to text.
    if (value.exitCode === 0 && value.timedOut !== true) return false
  }
  for (const block of result?.content ?? []) {
    if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      if (/\[exit code: [1-9]\d*\]/.test(block.text)) return true
    }
  }
  return false
}

/**
 * Flatten a failed dispatch into the text the scorer matches against, so an
 * error code that the tool reported structurally is still searchable.
 * @param result - the failed ToolExecutionResult.
 * @returns normalized failure text, capped so one huge stderr cannot bloat the store.
 */
function failureText(result) {
  const parts = []
  const error = result?.error
  if (error !== null && typeof error === 'object') {
    if (typeof error.message === 'string') parts.push(error.message)
    const info = error.info
    if (info !== null && typeof info === 'object') {
      if (typeof info.name === 'string') parts.push(info.name)
      if (typeof info.code === 'string') parts.push(info.code)
      if (typeof info.reason === 'string') parts.push(info.reason)
    }
  }
  // Structured streams first: `content` may be truncated or re-rendered, while
  // the tool's own value carries the real stderr.
  const value = result?.value
  if (value !== null && typeof value === 'object') {
    if (typeof value.stderr?.text === 'string') parts.push(value.stderr.text)
    if (typeof value.stdout?.text === 'string') parts.push(value.stdout.text)
  }
  for (const block of result?.content ?? []) {
    if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text)
    }
  }
  return parts.join('\n').slice(0, 4000)
}

/**
 * Compose the note attached to a failed tool result.
 * @param hit - the ranked match.
 * @returns the note text.
 */
function buildNote(hit) {
  const { entry } = hit
  const excerpt = entry.resolution.length > 200 ? `${entry.resolution.slice(0, 200)}…` : entry.resolution
  const lines = [
    `[solution-ledger] Known problem match (score ${hit.score}): ${entry.title}`,
    `Resolution: ${excerpt}`,
  ]
  if (entry.verify.length > 0) lines.push(`Verify: ${entry.verify.slice(0, 160)}`)
  lines.push(`(id ${entry.id}; call solution_search for the full entry, or solution_log with replaces to correct it)`)
  return lines.join('\n')
}

/**
 * Register the two tools and the failure hook.
 * @param ctx - plugin context carrying `tools`.
 * @param config - the Loader row config.
 */
export async function apply(ctx, config) {
  const resolved = normalizeConfig(config)
  const ledger = new Ledger(resolveStatePath(resolved))
  ledger.start()
  ctx.effect(() => () => ledger.dispose(), 'solution-ledger: store flush timer')
  await ledger.ready()

  // One note per distinct failure shape: a retry loop must not stack notes.
  const recentPushes = new Set()

  ctx.tools.register({
    name: 'solution_log',
    description:
      'Record a problem whose root cause was not obvious, or a route you chose after genuinely rejecting a '
      + 'workable alternative, so a later session can skip the same search. Do NOT record how something was '
      + 'implemented, what a file contains, or a decision where no alternative was seriously considered. If a '
      + "note would never appear in a failure message and would not change anyone's next decision, it is a log "
      + 'line, not a ledger entry. Before calling, all three must be true: (1) a future session is likely to '
      + 'hit the same situation; (2) the answer is not obvious from one glance at the code or docs; (3) '
      + 'skipping this entry would cost that session real time. New entries start as drafts and are not '
      + 'surfaced automatically until the user confirms them.',
    // Standard JSON Schema, like `output.schema` below. The Host passes
    // `parameters` to the provider unmodified: a bare property table without
    // `type`/`properties`, or a boolean `required` on a property, reaches a
    // strict provider as an invalid schema and fails the entire turn with
    // `Invalid schema for function 'solution_log'`.
    parameters: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          enum: KINDS,
          description: 'troubleshoot for a failure you actually hit and fixed; decision only when you seriously considered a workable alternative and rejected it.',
        },
        domain: {
          type: 'string',
          enum: DOMAINS,
          description: 'Which knowledge area this belongs to; searches filter on it first.',
        },
        title: {
          type: 'string',
          description: 'One-line conclusion that reads as a finding. A statement like `we use X to do Y` is an implementation note, not a finding.',
        },
        problem: {
          type: 'string',
          description: 'The symptom as it appeared in an error or a failed attempt. For a decision, the two options that looked equally viable and what made the choice hard.',
        },
        resolution: {
          type: 'string',
          description: 'The fix that worked, or the route you took.',
        },
        rejected: {
          type: 'string',
          description: 'An alternative you seriously considered and could have used, plus the concrete cost that ruled it out. Required when kind is decision.',
        },
        verify: {
          type: 'string',
          description: 'How to confirm the fix worked: the command to run and what it should print.',
        },
        signals: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Short strings a future failure message would contain verbatim: error codes, command names, file names. '
            + 'Automatic matching keys on these, so copy them from the real output.',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Two to six lowercase reuse words, such as windows, sandbox, pwsh, acl.',
        },
        scope: {
          type: 'string',
          enum: SCOPES,
          description:
            "machine for this computer's paths, permissions, or installed tools; "
            + "project for one repository's conventions; general for anything reusable anywhere.",
        },
        platform: {
          type: 'string',
          enum: PLATFORMS,
          description: 'Set only when the entry is platform-specific, such as a Windows path or a filesystem quirk.',
        },
        status: {
          type: 'string',
          enum: STATUSES,
          description:
            'draft (default) until the user confirms the entry; confirmed entries are the only ones surfaced '
            + 'automatically; deprecated keeps the entry out of search without deleting it.',
        },
        replaces: {
          type: 'string',
          description: 'Id of an existing entry to update in place. Prefer this over adding a near-duplicate.',
        },
        supersedes: {
          type: 'string',
          description:
            'Id of a different entry this one makes obsolete: a wrong answer, or an approach that was later replaced. '
            + 'That entry is marked deprecated and stops being surfaced. Use `replaces` to correct one entry in place; '
            + 'use `supersedes` only when the old entry must stay readable as history.',
        },
      },
      required: ['kind', 'domain', 'title', 'problem', 'resolution'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'action', 'status', 'total', 'similar', 'superseded'],
        properties: {
          id: { type: 'string' },
          action: { type: 'string', enum: ['created', 'updated'] },
          status: { type: 'string', enum: STATUSES },
          total: { type: 'integer' },
          superseded: {
            type: 'string',
            description: 'Id of the entry this write marked deprecated, or an empty string when nothing was superseded.',
          },
          similar: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['id', 'title', 'score'],
              properties: {
                id: { type: 'string' },
                title: { type: 'string' },
                score: { type: 'number' },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        const lines = [
          `${value.action === 'updated' ? 'Updated' : 'Recorded'} entry ${value.id} as ${value.status}. `
          + `Ledger holds ${value.total} entries.`,
        ]
        if (value.similar.length > 0) {
          lines.push('Similar entries already present — consider folding this into one of them with `replaces`:')
          for (const item of value.similar) lines.push(`- ${item.id} (score ${item.score}): ${item.title}`)
        }
        if (value.superseded.length > 0) {
          lines.push(`Marked entry ${value.superseded} as deprecated: it is superseded by this one and will no longer be surfaced.`)
        }
        if (value.status === 'draft') {
          lines.push('This entry stays a draft until the user confirms it; drafts are not surfaced automatically.')
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args, exec) {
      const input = args !== null && typeof args === 'object' ? args : {}
      const now = Date.now()
      const cwd = exec?.agent?.session?.header?.cwd
      const sessionId = exec?.agent?.id

      if (typeof input.kind === 'string' && !KINDS.includes(input.kind)) {
        throw new Error(`invalid kind ${JSON.stringify(input.kind)}; expected one of ${KINDS.join(', ')}`)
      }
      if (input.kind === 'decision' && (typeof input.rejected !== 'string' || input.rejected.trim().length === 0)) {
        throw new Error('kind=decision requires `rejected`: state the route you turned down and why')
      }

      await ledger.ready()

      const replacing = typeof input.replaces === 'string' && input.replaces.length > 0
      if (replacing && ledger.get(input.replaces) === undefined) {
        throw new Error(`no entry with id ${input.replaces}; omit replaces to create a new one`)
      }

      // Superseding is the only path that changes another entry's status, so it
      // is validated before the write rather than silently doing nothing. An
      // entry superseding itself is a caller mistake, not a no-op.
      const superseding =
        typeof input.supersedes === 'string' && input.supersedes.length > 0 ? input.supersedes : undefined
      if (superseding !== undefined) {
        if (ledger.get(superseding) === undefined) {
          throw new Error(`no entry with id ${superseding}; omit supersedes to write a standalone entry`)
        }
        if (superseding === input.replaces) {
          throw new Error('supersedes cannot name the entry being updated; an entry cannot supersede itself')
        }
      }

      // Probe for near-duplicates before writing, but never block the write:
      // a false positive must not cost the user the entry they asked for. The
      // bar sits well above the search floor because a wrong "you already have
      // this" is more annoying than a missed merge.
      const probeText = `${input.title ?? ''} ${input.problem ?? ''}`
      const similar = searchEntries(ledger.all(), { text: probeText, includeArchived: false }, 4)
        .filter((hit) => hit.score >= 12 && hit.entry.id !== input.replaces)
        .map((hit) => ({ id: hit.entry.id, title: hit.entry.title, score: hit.score }))

      return ledger.mutate(() => {
        maintainInPlace(ledger, resolved)
        const existing = replacing ? ledger.get(input.replaces) : undefined
        const base = existing ?? {}
        const pick = (key, fallback) => (typeof input[key] === 'string' && input[key].length > 0 ? input[key] : fallback)
        const pickList = (key, fallback) =>
          Array.isArray(input[key]) && input[key].every((item) => typeof item === 'string')
            ? input[key].map((item) => item.trim()).filter((item) => item.length > 0)
            : fallback

        const entry = {
          id: existing?.id ?? newId(),
          kind: pick('kind', base.kind ?? 'troubleshoot'),
          domain: pick('domain', base.domain ?? 'other'),
          title: pick('title', base.title ?? ''),
          problem: pick('problem', base.problem ?? ''),
          resolution: pick('resolution', base.resolution ?? ''),
          rejected: pick('rejected', base.rejected ?? ''),
          verify: pick('verify', base.verify ?? ''),
          signals: pickList('signals', base.signals ?? []),
          tags: pickList('tags', base.tags ?? []),
          scope: pick('scope', base.scope ?? 'general'),
          platform: pick('platform', base.platform),
          status: pick('status', base.status ?? 'draft'),
          supersedes: superseding ?? base.supersedes,
          archived: existing?.archived === true,
          source: existing?.source ?? {},
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
          lastHitAt: existing?.lastHitAt ?? 0,
          hits: existing?.hits ?? 0,
        }
        if (typeof cwd === 'string' && cwd.length > 0) entry.source.cwd = cwd
        if (typeof sessionId === 'string' && sessionId.length > 0) entry.source.sessionId = sessionId
        if (entry.title.trim().length < 6) {
          throw new Error('`title` must be a real one-line finding, at least 6 characters')
        }

        ledger.set(entry.id, entry)
        // Deprecating the old entry is the whole point of `supersedes`: it stays
        // on disk as history (the panel still lists it), but it leaves the
        // automatic push path and the search ranking from now on. Its archive
        // flag is left to `maintainInPlace`, so one rule owns that transition.
        if (superseding !== undefined && superseding !== entry.id) {
          const previous = ledger.get(superseding)
          if (previous !== undefined) {
            ledger.set(previous.id, { ...previous, status: 'deprecated', updatedAt: now })
          }
        }
        return {
          id: entry.id,
          action: existing === undefined ? 'created' : 'updated',
          status: entry.status,
          total: ledger.size,
          similar,
          superseded: superseding !== undefined && superseding !== entry.id ? superseding : '',
        }
      })
    },
    presentCall: (args) => ({
      card: 'generic',
      title: args?.kind === 'decision' ? 'Record decision' : 'Record solution',
      kind: 'other',
      rawInput: args,
    }),
  })

  ctx.tools.register({
    name: 'solution_search',
    description:
      'Search the global problem ledger before you start debugging an environment or tooling failure, and before '
      + 'you commit to a technical route on a new task: a past session may have already hit it. Results are a short '
      + 'title plus a resolution excerpt. Update a match in place with solution_log `replaces` instead of adding a '
      + 'near-duplicate.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Failure text, error codes, or the decision you are weighing. Paste the real error when you have one.',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Restrict to entries carrying these tags.',
        },
        kind: { type: 'string', enum: KINDS, description: 'Restrict to troubleshooting or decision entries.' },
        domain: { type: 'string', enum: DOMAINS, description: 'Restrict to one knowledge area.' },
        scope: { type: 'string', enum: SCOPES, description: 'Restrict to machine, project, or general knowledge.' },
        status: {
          type: 'string',
          enum: STATUSES,
          description: 'Restrict by lifecycle state, e.g. draft to review what still needs confirming.',
        },
        includeArchived: {
          type: 'boolean',
          description:
            'Include archived entries. Archive is not deletion: an entry leaves search once it is superseded '
            + 'or untouched past archiveAfterDays, so without this a replaced answer becomes unreachable from a tool.',
        },
        limit: { type: 'integer', description: 'Maximum matches, default 8, capped at 20.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['count', 'entries'],
        properties: {
          count: { type: 'integer' },
          entries: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['id', 'kind', 'domain', 'status', 'title', 'excerpt', 'tags', 'score'],
              properties: {
                id: { type: 'string' },
                kind: { type: 'string' },
                domain: { type: 'string' },
                status: { type: 'string' },
                title: { type: 'string' },
                excerpt: { type: 'string' },
                tags: { type: 'array', items: { type: 'string' } },
                score: { type: 'number' },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        if (value.count === 0) {
          return [{ type: 'text', text: 'No matching entries in the problem ledger. Solve it, then record it with solution_log.' }]
        }
        const lines = [`${value.count} matching entr${value.count === 1 ? 'y' : 'ies'}:`]
        for (const item of value.entries) {
          const tags = item.tags.length > 0 ? ` [${item.tags.join(', ')}]` : ''
          lines.push(
            `- ${item.id} (${item.kind}/${item.domain}/${item.status}, score ${item.score})${tags}`,
            `  ${item.title}`,
            `  ${item.excerpt}`,
          )
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args, exec) {
      const input = args !== null && typeof args === 'object' ? args : {}
      await ledger.ready()
      const limit = Math.min(20, Math.max(1, Number.isFinite(input.limit) ? Math.round(input.limit) : 8))
      const ranked = searchEntries(
        ledger.all(),
        {
          text: typeof input.query === 'string' ? input.query : '',
          tags: Array.isArray(input.tags) ? input.tags : [],
          kind: typeof input.kind === 'string' ? input.kind : undefined,
          domain: typeof input.domain === 'string' ? input.domain : undefined,
          scope: typeof input.scope === 'string' ? input.scope : undefined,
          status: typeof input.status === 'string' ? input.status : undefined,
          includeArchived: input.includeArchived === true,
          platform: process.platform,
          cwd: exec?.agent?.session?.header?.cwd,
        },
        limit,
      )
      ledger.bumpHits(ranked.map((hit) => hit.entry.id))
      return {
        count: ranked.length,
        entries: ranked.map((hit) => ({
          id: hit.entry.id,
          kind: hit.entry.kind,
          domain: hit.entry.domain,
          status: hit.entry.status,
          title: hit.entry.title,
          excerpt: hit.entry.resolution.length > 240 ? `${hit.entry.resolution.slice(0, 240)}…` : hit.entry.resolution,
          tags: hit.entry.tags,
          score: hit.score,
        })),
      }
    },
    presentCall: (args) => ({
      card: 'generic',
      title: 'Search problem ledger',
      kind: 'other',
      rawInput: args,
    }),
  })

  // ---- Browser surface -------------------------------------------------
  // The store is a Host-side JSON file, so the settings page reads and writes
  // through these routes. Registered on whichever web server is mounted; a
  // headless composition simply skips them and keeps the tools working.
  const webServer = ctx.get('webServer')
  if (webServer !== undefined) {
    // These routes listen on loopback, which every page open in the user's
    // browser can reach. Without a fence, any of them could read the ledger and
    // fire the write routes with a CORS-simple POST — measured here, a
    // cross-site `text/plain` request reached the delete handler.
    // `requestRejection` is DSH's own check: its Host/Origin fence defeats DNS
    // rebinding and cross-site calls, and its login-token cookie gates callers
    // that pass the fence.
    // Resolved per request, never captured here: this plugin's `apply` races the
    // Connection service's own async registration, so a lookup taken once can be
    // undefined and stay that way until the plugin is reloaded.
    const rejected = createGuard(() => ctx.get('connection'))

    /**
     * Read a request body as JSON.
     * @param req - the HTTP request.
     * @returns the parsed body, or an empty object for an empty body.
     */
    const readJsonBody = async (req) => {
      const chunks = []
      let size = 0
      for await (const chunk of req) {
        size += chunk.length
        if (size > 256 * 1024) throw new Error('request body too large')
        chunks.push(chunk)
      }
      if (size === 0) return {}
      return JSON.parse(Buffer.concat(chunks).toString('utf8'))
    }

    /** Send one JSON answer. */
    const reply = (res, status, payload) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(JSON.stringify(payload))
    }

    /**
     * Serialize one entry for the page, trimming the long prose so a large
     * ledger still fits in one response.
     *
     * `supersededBy` is derived, not stored: one entry's `supersedes` is the only
     * edge on disk, so the reverse direction is computed by whoever holds the
     * whole table. There are at most `maxEntries` of them, so a scan is cheaper
     * than a second field that could disagree with the forward link.
     * @param entry - a normalized ledger entry.
     * @param supersededBy - reverse index of `supersedes`, keyed by the old id.
     * @returns the wire shape.
     */
    const wireEntry = (entry, supersededBy = new Map()) => {
      const clip = (text) => (text.length > 4000 ? `${text.slice(0, 4000)}…` : text)
      return {
        id: entry.id,
        kind: entry.kind,
        domain: entry.domain,
        title: entry.title,
        problem: clip(entry.problem),
        resolution: clip(entry.resolution),
        rejected: clip(entry.rejected),
        verify: clip(entry.verify),
        tags: entry.tags,
        signals: entry.signals,
        scope: entry.scope,
        platform: entry.platform ?? null,
        supersedes: typeof entry.supersedes === 'string' ? entry.supersedes : null,
        supersededBy: supersededBy.get(entry.id) ?? null,
        status: entry.status,
        archived: entry.archived === true,
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
        hits: entry.hits,
        lastHitAt: entry.lastHitAt,
        cwd: typeof entry.source?.cwd === 'string' ? entry.source.cwd : null,
        sessionId: typeof entry.source?.sessionId === 'string' ? entry.source.sessionId : null,
      }
    }

    /**
     * Reverse index of `supersedes`: old id → the id that replaced it.
     *
     * Derived from the live table rather than stored, so a forward link and its
     * reverse can never disagree; there are at most `maxEntries` rows to walk.
     * @returns the index, empty when nothing supersedes anything.
     */
    const supersededIndex = () => {
      const index = new Map()
      for (const entry of ledger.all()) {
        if (typeof entry.supersedes === 'string' && entry.supersedes.length > 0) {
          index.set(entry.supersedes, entry.id)
        }
      }
      return index
    }

    /**
     * Register one exact route and tie its disposer to the plugin lifetime.
     * @param path - absolute request path.
     * @param handler - async (req, res) => void.
     */
    const route = (path, handler) => {
      const dispose = webServer.register({
        kind: 'exact',
        path,
        handler: async (req, res) => {
          try {
            // One gate for every route: the fence runs before any handler reads
            // a body, so an untrusted call never reaches ledger data.
            if (rejected(req, res)) return
            await handler(req, res)
          } catch (error) {
            console.log(`solution-ledger: ${path} failed:`, String(error))
            if (!res.headersSent) reply(res, 500, { ok: false, error: String(error) })
            else res.end()
          }
        },
      })
      ctx.effect(() => dispose, `solution-ledger: route ${path}`)
    }

    route('/solution-ledger/list', async (req, res) => {
      if (req.method !== 'GET') return reply(res, 405, { ok: false, error: 'method not allowed' })
      await ledger.ready()
      const all = ledger.all()
      // Built once: rebuilding it per entry would make this route O(n²).
      const supersededBy = supersededIndex()
      reply(res, 200, {
        ok: true,
        storePath: ledger.path,
        entries: all.map((entry) => wireEntry(entry, supersededBy)),
        stats: {
          total: all.length,
          draft: all.filter((entry) => entry.status === 'draft' && entry.archived !== true).length,
          confirmed: all.filter((entry) => entry.status === 'confirmed' && entry.archived !== true).length,
          deprecated: all.filter((entry) => entry.status === 'deprecated').length,
          archived: all.filter((entry) => entry.archived === true).length,
        },
      })
    })

    route('/solution-ledger/update', async (req, res) => {
      if (req.method !== 'POST') return reply(res, 405, { ok: false, error: 'method not allowed' })
      const body = await readJsonBody(req)
      const id = typeof body.id === 'string' ? body.id : ''
      const patch = body.patch !== null && typeof body.patch === 'object' ? body.patch : {}
      await ledger.ready()
      if (ledger.get(id) === undefined) return reply(res, 404, { ok: false, error: `no entry with id ${id}` })

      const TEXT_FIELDS = ['title', 'problem', 'resolution', 'rejected', 'verify']
      let unlinked = null
      const updated = await ledger.mutate(() => {
        const existing = ledger.get(id)
        const next = { ...existing }
        for (const field of TEXT_FIELDS) {
          if (typeof patch[field] === 'string') next[field] = patch[field]
        }
        // The log tool refuses a title that is not a one-line finding; the panel
        // must hold the same line, or an edit can empty a title the tool would
        // never have accepted.
        if (next.title.trim().length < 6) {
          throw new Error('`title` must be a real one-line finding, at least 6 characters')
        }
        if (typeof patch.status === 'string' && STATUSES.includes(patch.status)) next.status = patch.status
        if (typeof patch.kind === 'string' && KINDS.includes(patch.kind)) next.kind = patch.kind
        if (typeof patch.domain === 'string' && DOMAINS.includes(patch.domain)) next.domain = patch.domain
        if (typeof patch.scope === 'string' && SCOPES.includes(patch.scope)) next.scope = patch.scope
        if (Array.isArray(patch.tags) && patch.tags.every((tag) => typeof tag === 'string')) {
          next.tags = patch.tags.map((tag) => tag.trim()).filter((tag) => tag.length > 0)
        }
        // `signals` is the strongest match field and the one a user most often
        // corrects after seeing a push miss, so the panel must be able to edit it.
        if (Array.isArray(patch.signals) && patch.signals.every((signal) => typeof signal === 'string')) {
          next.signals = patch.signals.map((signal) => signal.trim()).filter((signal) => signal.length > 0)
        }
        if (patch.archived === true) next.archived = true
        if (patch.archived === false) next.archived = false
        // Re-confirming a record clears a stale archive flag so it can be
        // surfaced again without a second edit.
        if (next.status === 'confirmed') next.archived = false
        next.updatedAt = Date.now()
        ledger.set(id, next)
        // Confirming is also how a user overrules a supersede. Keeping the other
        // entry's forward link would leave two records claiming the same slot:
        // this one revived, the other still advertising that it replaced it.
        if (patch.status === 'confirmed' && existing.status !== 'confirmed') {
          for (const candidate of ledger.all()) {
            if (candidate.id !== id && candidate.supersedes === id) {
              ledger.set(candidate.id, { ...candidate, supersedes: undefined, updatedAt: Date.now() })
              unlinked = candidate.id
            }
          }
        }
        return next
      })
      reply(res, 200, { ok: true, entry: wireEntry(updated, supersededIndex()), unlinked })
    })

    route('/solution-ledger/delete', async (req, res) => {
      if (req.method !== 'POST') return reply(res, 405, { ok: false, error: 'method not allowed' })
      const body = await readJsonBody(req)
      const ids = Array.isArray(body.ids) ? body.ids.filter((id) => typeof id === 'string') : []
      if (ids.length === 0) return reply(res, 400, { ok: false, error: 'no ids supplied' })
      const removed = await ledger.mutate(() => {
        let count = 0
        for (const id of ids) if (ledger.drop(id)) count += 1
        return count
      })
      reply(res, 200, { ok: true, removed })
    })

    // ---- Update check ----------------------------------------------------
    // The mirror a mainland China `pnpm` defaults to can sit a whole release
    // behind npmjs, which makes DSH's own `listVersions()` answer "up to date"
    // right after a publish. This route asks the authoritative registry and
    // reports the mirror separately instead of trusting whichever answered.
    const ownVersion = readOwnVersion()
    const ownDir = resolvePackageDir()
    const backupsRoot = resolveBackupsRoot(resolved)
    let updateCache = null
    let updateInflight = null

    /**
     * One full check: is there a newer version, and can it be fetched at all?
     *
     * The availability probe runs only when a newer version exists, so an
     * install that is already current costs one lookup per registry rather than
     * a tarball request as well. `installable` is the gate the page uses: a
     * version whose tarball 404s everywhere would turn an update into a removal
     * with nothing to install.
     * @returns the report plus `availability` and `installable`.
     */
    const performCheck = async () => {
      const report = await checkForUpdate({
        currentVersion: ownVersion,
        packageName: resolved.updateCheckPackage,
        registry: resolved.updateCheckRegistry,
        mirror: resolved.updateCheckMirror === '' ? null : resolved.updateCheckMirror,
        timeoutMs: resolved.updateCheckTimeoutMs,
      })
      if (report.hasUpdate !== true || typeof report.latest !== 'string') return report

      const registries = [resolved.updateCheckRegistry]
      if (resolved.updateCheckMirror !== '') registries.push(resolved.updateCheckMirror)
      const availability = await checkAvailability({
        packageName: resolved.updateCheckPackage,
        version: report.latest,
        registries,
        timeoutMs: resolved.updateCheckTimeoutMs,
      })
      return { ...report, availability, installable: availability.some((entry) => entry.ok) }
    }

    route('/solution-ledger/update-check', async (req, res) => {
      if (req.method !== 'GET') return reply(res, 405, { ok: false, error: 'method not allowed' })
      if (!resolved.updateCheck) return reply(res, 200, { ok: false, disabled: true })

      const requested = new URL(req.url ?? '/', 'http://localhost')
      const force = requested.searchParams.get('force') === '1'
      const age = updateCache === null ? Infinity : Date.now() - updateCache.at
      if (!force && age < resolved.updateCheckTtlMs) {
        return reply(res, 200, { ...updateCache.value, cached: true, cacheAgeMs: age })
      }

      if (updateInflight === null) {
        updateInflight = performCheck().finally(() => {
          updateInflight = null
        })
      }
      const report = await updateInflight
      updateCache = { at: Date.now(), value: report }
      reply(res, 200, { ...report, cached: false, cacheAgeMs: 0 })
    })

    /** Report one backup's rollback command, so the page can show it. */
    const describeBackup = (meta) => ({
      ...meta,
      restoreCommand: `dsh plugin --profile <profile> add file:${meta.path}`,
    })

    route('/solution-ledger/backup', async (req, res) => {
      if (req.method !== 'POST') return reply(res, 405, { ok: false, error: 'method not allowed' })
      try {
        const meta = createBackup({
          backupsRoot,
          packageName: resolved.updateCheckPackage,
          version: ownVersion,
          packageDir: ownDir,
          source: ownDir,
        })
        reply(res, 200, { ok: true, backup: describeBackup(meta) })
      } catch (error) {
        // A failed copy must surface as a failure: the page treats a backup it
        // cannot confirm as a reason not to send the user off to install.
        reply(res, 500, { ok: false, error: String(error?.message ?? error) })
      }
    })

    route('/solution-ledger/backups', async (req, res) => {
      if (req.method !== 'GET') return reply(res, 405, { ok: false, error: 'method not allowed' })
      reply(res, 200, { ok: true, root: backupsRoot, backups: listBackups(backupsRoot).map(describeBackup) })
    })
  }

  // Push, not pull: a failing tool names its own problem in the same step it
  // happens, which is the only moment the model is guaranteed to be looking.
  ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    try {
      if (!resolved.pushOnToolError) return decision
      if (decision?.kind !== 'accept') return decision
      if (!looksFailed(result)) return decision
      if (exec?.signal?.aborted === true) return decision
      if (exec.name === 'solution_log' || exec.name === 'solution_search') return decision

      const text = failureText(result)
      if (text.trim().length < 8) return decision

      const ranked = searchEntries(
        ledger.all(),
        { text, platform: process.platform, cwd: exec?.agent?.session?.header?.cwd },
        5,
      )
      const hit = ranked.find(
        (candidate) => candidate.entry.status === 'confirmed' && candidate.score >= resolved.pushMinScore,
      )
      if (hit === undefined) return decision

      const signature = `${exec.name}::${text.slice(0, 160)}`
      if (recentPushes.has(signature)) return decision
      recentPushes.add(signature)
      if (recentPushes.size > 20) recentPushes.delete(recentPushes.values().next().value)

      ledger.bumpHits([hit.entry.id])
      const content = [...(Array.isArray(decision.content) ? decision.content : result.content ?? [])]
      content.push({ type: 'text', text: buildNote(hit) })
      return { ...decision, content }
    } catch (error) {
      // A failed lookup must never turn a real tool error into a worse one.
      console.log('solution-ledger: failure note skipped:', String(error))
      return decision
    }
  })
}
