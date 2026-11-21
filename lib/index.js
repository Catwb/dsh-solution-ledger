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
  pushMinScore: 12,
  maxEntries: 2000,
  archiveAfterDays: 90,
  draftArchiveAfterDays: 30,
  statePath: '',
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
      + 'workable alternative, so a later session can skip the same search.\n\n'
      + 'Do NOT record how something was implemented, what a file contains, or a decision where no alternative '
      + 'was seriously considered. If a note would never appear in a failure message and would not change '
      + "anyone's next decision, it is a log line, not a ledger entry.\n\n"
      + 'Before calling, all three must be true: (1) a future session is likely to hit the same situation; '
      + '(2) the answer is not obvious from one glance at the code or docs; (3) skipping this entry would '
      + 'cost that session real time.\n\n'
      + 'New entries start as drafts and are not surfaced automatically until the user confirms them.',
    parameters: {
      kind: {
        type: 'string',
        required: true,
        enum: KINDS,
        description: 'troubleshoot for a failure you actually hit and fixed; decision only when you seriously considered a workable alternative and rejected it.',
      },
      domain: {
        type: 'string',
        required: true,
        enum: DOMAINS,
        description: 'Which knowledge area this belongs to; searches filter on it first.',
      },
      title: {
        type: 'string',
        required: true,
        description: 'One-line conclusion that reads as a finding. A statement like "we use X to do Y" is an implementation note, not a finding.',
      },
      problem: {
        type: 'string',
        required: true,
        description: 'The symptom as it appeared in an error or a failed attempt. For a decision, the two options that looked equally viable and what made the choice hard.',
      },
      resolution: {
        type: 'string',
        required: true,
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
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'action', 'status', 'total', 'similar'],
        properties: {
          id: { type: 'string' },
          action: { type: 'string', enum: ['created', 'updated'] },
          status: { type: 'string', enum: STATUSES },
          total: { type: 'integer' },
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
          supersedes: typeof input.supersedes === 'string' ? input.supersedes : base.supersedes,
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
        return {
          id: entry.id,
          action: existing === undefined ? 'created' : 'updated',
          status: entry.status,
          total: ledger.size,
          similar,
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
      limit: { type: 'integer', description: 'Maximum matches, default 8, capped at 20.' },
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
     * @param entry - a normalized ledger entry.
     * @returns the wire shape.
     */
    const wireEntry = (entry) => {
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
      reply(res, 200, {
        ok: true,
        storePath: ledger.path,
        entries: all.map(wireEntry),
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
      const updated = await ledger.mutate(() => {
        const existing = ledger.get(id)
        const next = { ...existing }
        for (const field of TEXT_FIELDS) {
          if (typeof patch[field] === 'string') next[field] = patch[field]
        }
        if (typeof patch.status === 'string' && STATUSES.includes(patch.status)) next.status = patch.status
        if (typeof patch.kind === 'string' && KINDS.includes(patch.kind)) next.kind = patch.kind
        if (typeof patch.domain === 'string' && DOMAINS.includes(patch.domain)) next.domain = patch.domain
        if (typeof patch.scope === 'string' && SCOPES.includes(patch.scope)) next.scope = patch.scope
        if (Array.isArray(patch.tags) && patch.tags.every((tag) => typeof tag === 'string')) {
          next.tags = patch.tags.map((tag) => tag.trim()).filter((tag) => tag.length > 0)
        }
        if (patch.archived === true) next.archived = true
        if (patch.archived === false) next.archived = false
        // Re-confirming a record clears a stale archive flag so it can be
        // surfaced again without a second edit.
        if (next.status === 'confirmed') next.archived = false
        next.updatedAt = Date.now()
        ledger.set(id, next)
        return next
      })
      reply(res, 200, { ok: true, entry: wireEntry(updated) })
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
