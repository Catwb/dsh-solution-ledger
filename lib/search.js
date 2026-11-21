/**
 * Relevance scoring over the ledger. There is no index and no embedding model:
 * a few hundred entries are scanned in memory, so the scorer is the whole
 * retrieval strategy and its weights are the design.
 *
 * The ordering of weights matters more than their exact values: a machine-
 * matchable `signal` (an error code, a command name) beats a tag, a tag beats
 * the title, and the title beats free body text. Semantic guesses are the
 * weakest signal we have, so they score last.
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
  const source = String(text ?? '').toLowerCase()
  if (source.length === 0) return tokens
  for (const match of source.matchAll(/[a-z0-9][a-z0-9_.\-\\/]{1,}/g)) {
    tokens.add(match[0])
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
 * @param entry - a normalized ledger entry.
 * @param query - the normalized query (see `searchEntries`).
 * @returns a relevance score; can be negative for penalized entries.
 */
export function scoreEntry(entry, query) {
  let score = 0
  const haystack = String(query.text ?? '').toLowerCase()

  // Machine-matchable fingerprints dominate: an error string that appears
  // verbatim in the failure text is the strongest evidence we can get.
  if (haystack.length > 0) {
    let signalScore = 0
    for (const signal of entry.signals) {
      const needle = String(signal ?? '').toLowerCase()
      if (needle.length >= 2 && haystack.includes(needle)) signalScore += 5
    }
    score += Math.min(signalScore, 15)
  }

  if (query.tags !== undefined && query.tags.length > 0) {
    const owned = new Set(entry.tags.map((tag) => tag.toLowerCase()))
    let tagScore = 0
    for (const tag of query.tags) {
      if (owned.has(String(tag).toLowerCase())) tagScore += 3
    }
    score += Math.min(tagScore, 9)
  }

  if (query.domain !== undefined && entry.domain === query.domain) score += 3
  if (query.kind !== undefined && entry.kind === query.kind) score += 2

  const queryTokens = query.tokens ?? tokenize(query.text)
  if (queryTokens.size > 0) {
    const titleTokens = tokenize(entry.title)
    let titleScore = 0
    for (const token of queryTokens) {
      if (titleTokens.has(token)) titleScore += 2
    }
    score += Math.min(titleScore, 8)

    const bodyTokens = tokenize(`${entry.problem} ${entry.resolution} ${entry.rejected}`)
    let bodyScore = 0
    for (const token of queryTokens) {
      if (bodyTokens.has(token)) bodyScore += 1
    }
    score += Math.min(bodyScore, 4)
  }

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

  return score
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

  // An unconditional browse (no text, no filters) should list what changed
  // most recently rather than score nothing and return an empty page.
  const browsing =
    normalized.text.trim().length === 0 &&
    normalized.tags.length === 0 &&
    normalized.domain === undefined &&
    normalized.kind === undefined
  if (browsing) {
    return filtered
      .slice()
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, limit)
      .map((entry) => ({ entry, score: 0 }))
  }

  const ranked = []
  for (const entry of filtered) {
    const score = scoreEntry(entry, normalized)
    if (score > 0) ranked.push({ entry, score })
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
