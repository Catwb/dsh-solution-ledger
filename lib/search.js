/**
 * Relevance scoring over the ledger. There is no index and no embedding model:
 * a few hundred entries are scanned in memory, so the scorer is the whole
 * retrieval strategy and its weights are the design.
 *
 * The ordering of weights matters more than their exact values: a machine-
 * matchable `signal` (an error code, a command name) beats a tag, a tag beats
 * the verbatim `problem` text, and `problem` beats the title. `resolution` and
 * `rejected` describe the fix rather than the failure, so they score last.
 *
 * The scale has to stay in step with `pushMinScore`. A floor that the achievable
 * scores cannot reach turns automatic push off silently: `problem` once shared
 * the body bucket (cap 4), which pinned an entry that quoted the error verbatim
 * at 6, and a single accurate `signal` at 11 — both under the old floor of 12.
 */

/** Bound on how many surface tokens one query may contribute. */
const MAX_QUERY_TOKENS = 64

/**
 * Split text into comparable tokens: Latin/digit runs stay whole, and CJK
 * runs become character bigrams because there are no spaces to split on.
 * @param text - any text.
 * @returns the token set, possibly empty.
 */
export function tokenize(text) {
  const tokens = new Set()
  const raw = String(text ?? '').toLowerCase()
  if (raw.length === 0) return tokens
  // Strip drive-letter paths before tokenizing. A path repeats the same words on
  // every machine and in unrelated entries ("文档", "工作", "src", "node_modules"),
  // so a shared directory name looked like shared subject matter: a plain
  // "old_string was not found in D:\文档\1工作站\..." error matched a Windows ACL
  // entry purely because both texts contained the same Chinese folder names.
  // `signals` still match paths verbatim; only token evidence drops them.
  const source = raw.replace(/[a-z]:[\\/][^\s"'`]+/g, ' ')
  for (const match of source.matchAll(/[a-z0-9][a-z0-9_.\-\\/]{1,}/g)) {
    const word = match[0]
    tokens.add(word)
    // A compound such as `sandbox-local` must also match a plain `sandbox`:
    // keeping only the joined form misses the prefix a user actually types, and
    // that showed up as a valid query returning nothing.
    if (/[_.\-\\/]/.test(word)) {
      for (const part of word.split(/[_.\-\\/]+/)) {
        if (part.length >= 2) tokens.add(part)
      }
    }
    if (tokens.size >= MAX_QUERY_TOKENS) return tokens
  }
  const cjk = source.replace(/[^\u4e00-\u9fff]+/g, ' ')
  for (const segment of cjk.split(/\s+/)) {
    for (let i = 0; i + 2 <= segment.length; i += 1) {
      tokens.add(segment.slice(i, i + 2))
      if (tokens.size >= MAX_QUERY_TOKENS) return tokens
    }
  }
  return tokens
}

/**
 * Score one entry against one query. Weights are documented inline because
 * tuning them is the expected maintenance task here.
 *
 * The return separates two things a single number conflates: `matched` records
 * whether the entry matched anything the query actually asked for, while
 * `score` also folds in ranking adjustments (status, platform, scope). Without
 * that split, a confirmed entry on the same platform scores +4 against any
 * query whatsoever and would be returned as a "result".
 * @param entry - a normalized ledger entry.
 * @param query - the normalized query (see `searchEntries`).
 * @returns `{ score, matched }`; `score` can be negative for penalized entries.
 */
export function scoreEntry(entry, query) {
  let score = 0
  let matched = false
  const haystack = String(query.text ?? '').toLowerCase()

  // Machine-matchable fingerprints dominate: an error string that appears
  // verbatim in the failure text is the strongest evidence we can get.
  if (haystack.length > 0) {
    let signalScore = 0
    for (const signal of entry.signals) {
      const needle = String(signal ?? '').toLowerCase()
      if (needle.length >= 2 && haystack.includes(needle)) {
        signalScore += 5
        matched = true
      }
    }
    score += Math.min(signalScore, 15)
  }

  if (query.tags !== undefined && query.tags.length > 0) {
    const owned = new Set(entry.tags.map((tag) => tag.toLowerCase()))
    let tagScore = 0
    for (const tag of query.tags) {
      if (owned.has(String(tag).toLowerCase())) {
        tagScore += 3
        matched = true
      }
    }
    score += Math.min(tagScore, 9)
  }

  if (query.domain !== undefined && entry.domain === query.domain) {
    score += 3
    matched = true
  }
  if (query.kind !== undefined && entry.kind === query.kind) {
    score += 2
    matched = true
  }

  const queryTokens = query.tokens ?? tokenize(query.text)
  if (queryTokens.size > 0) {
    const titleTokens = tokenize(entry.title)
    let titleScore = 0
    for (const token of queryTokens) {
      if (titleTokens.has(token)) {
        titleScore += 2
        matched = true
      }
    }
    score += Math.min(titleScore, 8)

    // `problem` gets its own bucket, above the generic body. The tool description
    // asks for "the symptom as it appeared in an error", so this is the field
    // most likely to hold the failure text verbatim — and folding it into the
    // body bucket (cap 4) made the most error-like field the weakest signal: a
    // verbatim copy of the error still scored only 4, below one signal token.
    // Measured before this split: Chinese title + verbatim problem = 6, which no
    // threshold above 6 can ever surface.
    const problemTokens = tokenize(entry.problem)
    let problemScore = 0
    for (const token of queryTokens) {
      if (problemTokens.has(token)) {
        problemScore += 2
        matched = true
      }
    }
    score += Math.min(problemScore, 8)

    // Resolution and rejected stay the weakest text signal: they describe the fix,
    // not the symptom, so they say less about whether this is the same failure.
    const bodyTokens = tokenize(`${entry.resolution} ${entry.rejected}`)
    let bodyScore = 0
    for (const token of queryTokens) {
      if (bodyTokens.has(token)) {
        bodyScore += 1
        matched = true
      }
    }
    score += Math.min(bodyScore, 4)
  }

  // Below here: ranking adjustments only. They never make an entry a result.

  // A platform-specific entry is a guess that can be actively wrong elsewhere.
  if (entry.platform !== undefined && query.platform !== undefined) {
    score += entry.platform === query.platform ? 2 : -3
  }

  // Machine-scoped knowledge (this box's paths, this box's ACLs) travels poorly.
  const entryCwd = entry.source?.cwd
  if (entry.scope === 'machine' && typeof query.cwd === 'string' && query.cwd.length > 0) {
    if (typeof entryCwd === 'string' && entryCwd.length > 0 && entryCwd !== query.cwd) score -= 2
  }

  if (entry.status === 'confirmed') score += 2
  else if (entry.status === 'draft') score -= 1
  else if (entry.status === 'deprecated') score -= 5

  return { score, matched }
}

/**
 * Filter and rank entries for one query.
 * @param entries - every live entry.
 * @param query - `{ text, tags, kind, domain, scope, status, platform, cwd, includeArchived }`.
 * @param limit - maximum results.
 * @returns ranked `{ entry, score }` pairs.
 */
export function searchEntries(entries, query, limit) {
  const normalized = {
    text: String(query.text ?? ''),
    tags: Array.isArray(query.tags) ? query.tags : [],
    kind: query.kind,
    domain: query.domain,
    scope: query.scope,
    status: query.status,
    platform: query.platform,
    cwd: query.cwd,
    includeArchived: query.includeArchived === true,
  }
  normalized.tokens = tokenize(normalized.text)

  const filtered = []
  for (const entry of entries) {
    if (normalized.includeArchived !== true && entry.archived === true) continue
    if (normalized.status !== undefined && entry.status !== normalized.status) continue
    if (normalized.kind !== undefined && entry.kind !== normalized.kind) continue
    if (normalized.domain !== undefined && entry.domain !== normalized.domain) continue
    if (normalized.scope !== undefined && entry.scope !== normalized.scope) continue
    filtered.push(entry)
  }

  // Without search text or tags there is nothing to score against, so this is
  // a filtered browse (respecting kind/domain/scope/status) ordered by recency.
  // Scoring it instead would rank every survivor on status alone and then drop
  // the drafts below MIN_RELEVANCE, which is not what a filter means.
  const browsing = normalized.text.trim().length === 0 && normalized.tags.length === 0
  if (browsing) {
    return filtered
      .slice()
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, limit)
      .map((entry) => ({ entry, score: 0 }))
  }

  const ranked = []
  for (const entry of filtered) {
    const { score, matched } = scoreEntry(entry, normalized)
    // `matched` is the real gate: an entry that shares nothing with the query
    // must not be returned just because its status and platform score well.
    if (matched && score > 0) ranked.push({ entry, score })
  }
  ranked.sort((a, b) => b.score - a.score || recency(b.entry) - recency(a.entry))
  return ranked.slice(0, limit)
}

/**
 * Last-use timestamp, falling back to creation for entries never surfaced.
 * @param entry - a normalized ledger entry.
 * @returns a comparable millisecond timestamp.
 */
function recency(entry) {
  return entry.lastHitAt > 0 ? entry.lastHitAt : entry.createdAt
}
