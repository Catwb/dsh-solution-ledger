/**
 * Durable storage for the ledger: one JSON document under $DSH_HOME, loaded
 * once into memory and saved atomically (temp file + rename) so a crash mid-write
 * cannot truncate the store.
 *
 * Two write paths exist on purpose:
 * - `mutate()` is serialized and awaits durability; use it for anything the
 *   caller must be able to rely on immediately.
 * - `bumpHits()` only touches memory and sets a dirty flag, because a search
 *   would otherwise force a disk write on every lookup. The debounce timer
 *   flushes those counters later.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** On-disk document version. Bump only when the shape changes incompatibly. */
export const STATE_VERSION = 1

/** How long hit counters may stay in memory before a flush is attempted. */
const FLUSH_MS = 30_000

/**
 * Resolve the store path. The plugin never picks a path inside a project
 * checkout: entries are global, so they belong beside the other Harness state.
 * @param config - the Loader row config.
 * @returns absolute path of the JSON store.
 */
export function resolveStatePath(config) {
  if (typeof config?.statePath === 'string' && config.statePath.length > 0) return config.statePath
  const home = process.env.DSH_HOME
  if (typeof home === 'string' && home.length > 0) return join(home, 'solution-ledger.json')
  return join(process.cwd(), '.solution-ledger.json')
}

/**
 * Keep a stored record usable: drop unknown keys, coerce every field the
 * search and render paths read, and never let one hand-edited record throw.
 * @param raw - untrusted value from disk.
 * @returns a normalized entry, or null when it has no usable identity.
 */
export function normalizeEntry(raw) {
  if (raw === null || typeof raw !== 'object') return null
  const id = typeof raw.id === 'string' && raw.id.length > 0 ? raw.id : null
  if (id === null) return null
  const str = (value, fallback = '') => (typeof value === 'string' ? value : fallback)
  const strList = (value) =>
    Array.isArray(value) ? value.filter((v) => typeof v === 'string' && v.length > 0) : []
  const num = (value, fallback) => (typeof value === 'number' && Number.isFinite(value) ? value : fallback)
  const createdAt = num(raw.createdAt, Date.now())
  return {
    id,
    kind: raw.kind === 'decision' ? 'decision' : 'troubleshoot',
    domain: ['environment', 'tooling', 'code', 'config', 'process', 'other'].includes(raw.domain)
      ? raw.domain
      : 'other',
    title: str(raw.title, '(untitled)'),
    problem: str(raw.problem),
    resolution: str(raw.resolution),
    rejected: str(raw.rejected),
    verify: str(raw.verify),
    signals: strList(raw.signals),
    tags: strList(raw.tags),
    scope: ['machine', 'project', 'general'].includes(raw.scope) ? raw.scope : 'general',
    platform: ['win32', 'darwin', 'linux'].includes(raw.platform) ? raw.platform : undefined,
    status: ['draft', 'confirmed', 'deprecated'].includes(raw.status) ? raw.status : 'draft',
    supersedes: typeof raw.supersedes === 'string' ? raw.supersedes : undefined,
    archived: raw.archived === true,
    source: raw.source !== null && typeof raw.source === 'object' ? raw.source : {},
    createdAt,
    updatedAt: num(raw.updatedAt, createdAt),
    lastHitAt: num(raw.lastHitAt, 0),
    hits: num(raw.hits, 0),
  }
}

/** In-memory ledger with atomic, serialized persistence. */
export class Ledger {
  #path
  #data = { version: STATE_VERSION, entries: {} }
  #loaded = false
  #chain = Promise.resolve()
  #dirty = false
  /**
   * Monotonic count of in-memory changes. A write snapshots this before
   * `writeFile` and compares it afterwards, so a hit counted while the write was
   * in flight keeps the dirty flag set instead of being cleared by the very
   * write that had not included it yet. Those lost hits used to advance nothing,
   * and `lastHitAt` is exactly what the archive rule reads as "still in use".
   */
  #dirtyVersion = 0
  #timer = null

  /** @param path - absolute path of the JSON store. */
  constructor(path) {
    this.#path = path
  }

  get path() {
    return this.#path
  }

  /** Begin the lazy flush timer; the caller disposes it with the plugin. */
  start() {
    if (this.#timer !== null) return
    this.#timer = setInterval(() => {
      if (this.#dirty) void this.#flushQuietly()
    }, FLUSH_MS)
    this.#timer.unref?.()
  }

  /** Stop flushing and persist any outstanding hit counters. */
  async dispose() {
    if (this.#timer !== null) {
      clearInterval(this.#timer)
      this.#timer = null
    }
    if (this.#dirty) await this.#flushQuietly()
  }

  /** Load the store once; a missing or corrupt file starts an empty ledger. */
  async ready() {
    if (this.#loaded) return
    this.#loaded = true
    let raw
    try {
      raw = await readFile(this.#path, 'utf8')
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        console.log('solution-ledger: store unreadable, starting empty:', String(error))
      }
      return
    }
    try {
      const parsed = JSON.parse(raw)
      const source = parsed?.entries
      if (source !== null && typeof source === 'object') {
        const entries = {}
        for (const [key, value] of Object.entries(source)) {
          const entry = normalizeEntry(value)
          if (entry !== null) entries[entry.id ?? key] = entry
        }
        this.#data = { version: STATE_VERSION, entries }
      }
    } catch (error) {
      console.log('solution-ledger: store malformed, starting empty:', String(error))
    }
  }

  /** Every live entry, newest first. Call after `ready()`. */
  all() {
    return Object.values(this.#data.entries).sort((a, b) => b.updatedAt - a.updatedAt)
  }

  /** One entry by id, or undefined. */
  get(id) {
    return this.#data.entries[id]
  }

  /** Number of stored entries, archived included. */
  get size() {
    return Object.keys(this.#data.entries).length
  }

  /** Insert or overwrite one entry in memory. Call inside `mutate()`. */
  set(id, entry) {
    this.#data.entries[id] = entry
  }

  /** Remove one entry outright. Only pruning calls this; deposits never do. */
  drop(id) {
    if (!(id in this.#data.entries)) return false
    delete this.#data.entries[id]
    return true
  }

  /**
   * Apply a mutation and await durability.
   * @param fn - pure mutation against the in-memory table.
   * @returns whatever `fn` returned.
   */
  mutate(fn) {
    const run = this.#chain.then(async () => {
      await this.ready()
      const result = fn()
      await this.#persist()
      return result
    })
    // Keep the chain healthy: one rejected write must not block later writes.
    this.#chain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  /**
   * Record that entries were surfaced by a search. Memory only; the debounce
   * timer persists the counters so a lookup never pays for a disk write.
   * @param ids - ids that appeared in a result.
   */
  bumpHits(ids) {
    const now = Date.now()
    let changed = false
    for (const id of ids) {
      const entry = this.#data.entries[id]
      if (entry === undefined) continue
      entry.hits += 1
      entry.lastHitAt = now
      changed = true
    }
    if (changed) {
      this.#dirty = true
      this.#dirtyVersion += 1
    }
  }

  async #flushQuietly() {
    try {
      await this.#persist()
    } catch (error) {
      // A failed flush leaves the counters dirty so the next tick retries them,
      // instead of clearing the flag and losing them for good.
      this.#dirty = true
      console.log('solution-ledger: deferred flush failed:', String(error))
    }
  }

  async #persist() {
    const version = this.#dirtyVersion
    await mkdir(dirname(this.#path), { recursive: true })
    // A per-call temp name: a fixed `${path}.tmp` lets two processes overwrite
    // each other's temp file and rename the wrong bytes into place.
    const tmp = `${this.#path}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`
    await writeFile(tmp, JSON.stringify(this.#data, null, 2), 'utf8')
    await rename(tmp, this.#path)
    // Only settle the flag when nothing changed during the write itself.
    if (this.#dirtyVersion === version) this.#dirty = false
  }
}
