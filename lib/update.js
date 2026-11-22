/**
 * Self update check for this package.
 *
 * The hard part is not the request: it is which registry answers. A mainland
 * China package manager defaults to `registry.npmmirror.com`, and that mirror
 * lags npmjs by an unpredictable amount — measured here, a version published
 * to npmjs was still 404 on the mirror minutes later, both its metadata and
 * its tarball. DSH's own `pluginManager.listVersions()` runs `pnpm view`, so it
 * asks the same lagging mirror and reports "already up to date".
 *
 * So this module asks the official registry first, asks the mirror second, and
 * reports the difference instead of hiding it. Nothing here installs anything:
 * the page only tells the user what exists.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The package this module checks. */
export const PACKAGE_NAME = 'dsh-solution-ledger'

/** Authoritative source: a publish lands here first. */
export const DEFAULT_REGISTRY = 'https://registry.npmjs.org'

/** Common mainland China mirror; usually behind the authoritative source. */
export const DEFAULT_MIRROR = 'https://registry.npmmirror.com'

/** npm's placeholder version while a publish is still being finalized. */
const STAGING_PREFIX = '0.0.0'

/**
 * Read this package's own version from its manifest.
 *
 * `package.json` is not re-exported through the `exports` whitelist, so it is
 * read from the filesystem beside `lib/` rather than imported.
 * @returns the version string, or an empty string when unreadable.
 */
export function readOwnVersion() {
  try {
    const here = dirname(fileURLToPath(import.meta.url))
    const manifest = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'))
    return typeof manifest.version === 'string' ? manifest.version : ''
  } catch {
    return ''
  }
}

/**
 * Split a version into comparable parts.
 * @param value - a version string, with or without a leading `v`.
 * @returns the parts, or null when the string is not a version.
 */
export function parseVersion(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(value ?? '').trim())
  if (match === null) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? '',
  }
}

/**
 * Compare two versions the way semver orders them.
 * @param left - first version.
 * @param right - second version.
 * @returns -1, 0, or 1; two unparsable versions compare equal.
 */
export function compareVersions(left, right) {
  const a = parseVersion(left)
  const b = parseVersion(right)
  if (a === null || b === null) return 0
  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1
  }
  // A release outranks any prerelease of the same number.
  if (a.prerelease === b.prerelease) return 0
  if (a.prerelease === '') return 1
  if (b.prerelease === '') return -1
  return a.prerelease < b.prerelease ? -1 : 1
}

/**
 * Turn a thrown fetch failure into a short, reportable reason.
 * @param error - whatever the request threw.
 * @returns a one-word reason plus detail.
 */
function describeError(error) {
  if (error?.name === 'AbortError') return 'timeout'
  const message = String(error?.message ?? error)
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(message)) return 'dns'
  if (/ECONNREFUSED|ECONNRESET|socket/i.test(message)) return 'connection'
  if (/certificate|self-signed/i.test(message)) return 'tls'
  return message.slice(0, 120)
}

/**
 * Read one registry's `latest` dist-tag.
 *
 * The dist-tags endpoint is a few hundred bytes; the full manifest is hundreds
 * of kilobytes, so it is only a fallback for a registry that does not serve the
 * small one. Both carry a cache-busting query: the mirror ignores it, but a CDN
 * in front of the official registry does not.
 * @param registry - registry base URL.
 * @param packageName - package to ask about.
 * @param timeoutMs - per-request deadline.
 * @param fetchImpl - fetch implementation to use.
 * @returns `{ latest, error }` — `latest` is null when the registry had no answer.
 */
async function fetchLatestTag(registry, packageName, timeoutMs, fetchImpl) {
  const base = String(registry).replace(/\/+$/, '')
  const attempts = [
    `${base}/-/package/${packageName}/dist-tags`,
    `${base}/${packageName}/latest`,
  ]
  let lastError = null
  for (const target of attempts) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetchImpl(`${target}?t=${Date.now()}`, {
        signal: controller.signal,
        headers: { Accept: 'application/json', 'Cache-Control': 'no-cache', Pragma: 'no-cache' },
      })
      if (!response.ok) {
        lastError = `http ${response.status}`
        continue
      }
      const body = await response.json()
      const latest =
        typeof body?.latest === 'string'
          ? body.latest
          : // A full manifest answers with its own version instead of a tag map.
            typeof body?.version === 'string'
            ? body.version
            : ''
      if (latest === '') {
        lastError = 'no latest tag'
        continue
      }
      return { latest, error: null }
    } catch (error) {
      lastError = describeError(error)
    } finally {
      clearTimeout(timer)
    }
  }
  return { latest: null, error: lastError ?? 'unreachable' }
}

/**
 * Check whether a newer version has been published.
 *
 * Both sources are asked in parallel so the answer can say that the official
 * registry already has a version the mirror has not synced — the exact state
 * that makes a mirror-only check report "up to date" after a publish.
 * @param options - check parameters.
 * @param options.currentVersion - the version this install is running.
 * @param options.packageName - package to check.
 * @param options.registry - authoritative registry.
 * @param options.mirror - mirror to compare against, or null to skip it.
 * @param options.timeoutMs - per-request deadline.
 * @param options.fetchImpl - fetch implementation; defaults to the global one.
 * @returns one normalized report; never throws.
 */
export async function checkForUpdate(options) {
  const {
    currentVersion,
    packageName = PACKAGE_NAME,
    registry = DEFAULT_REGISTRY,
    mirror = DEFAULT_MIRROR,
    timeoutMs = 8000,
    fetchImpl = globalThis.fetch,
  } = options ?? {}

  const checkedAt = Date.now()
  const base = {
    ok: true,
    current: typeof currentVersion === 'string' ? currentVersion : '',
    packageName,
    registry,
    checkedAt,
    latest: null,
    hasUpdate: false,
    publishing: false,
    degraded: false,
    mirror: null,
    error: null,
  }

  if (typeof fetchImpl !== 'function') {
    return { ...base, ok: false, error: 'no fetch implementation' }
  }

  const [primary, secondary] = await Promise.all([
    fetchLatestTag(registry, packageName, timeoutMs, fetchImpl),
    mirror === null || mirror === undefined || mirror === registry
      ? Promise.resolve(null)
      : fetchLatestTag(mirror, packageName, timeoutMs, fetchImpl),
  ])

  // Prefer the authoritative answer; fall back to the mirror but say so, since
  // a mirror answer can be behind the published state.
  let latest = primary.latest
  let usedRegistry = registry
  let degraded = false
  if (latest === null && secondary?.latest != null) {
    latest = secondary.latest
    usedRegistry = String(mirror)
    degraded = true
  }

  const mirrorReport =
    secondary === null
      ? null
      : {
          registry: String(mirror),
          latest: secondary.latest,
          error: secondary.error,
          // Only meaningful when both answered and the mirror is behind.
          lagging:
            primary.latest !== null &&
            secondary.latest !== null &&
            compareVersions(secondary.latest, primary.latest) < 0,
        }

  if (latest === null) {
    return {
      ...base,
      ok: false,
      registry: usedRegistry,
      degraded,
      mirror: mirrorReport,
      error: primary.error ?? 'unreachable',
    }
  }

  // npm briefly publishes `0.0.0-<stage>` before promoting the real version;
  // reporting that as an update would be noise.
  const publishing = latest === STAGING_PREFIX || latest.startsWith(`${STAGING_PREFIX}-`)
  const hasUpdate =
    !publishing &&
    base.current !== '' &&
    parseVersion(base.current) !== null &&
    compareVersions(latest, base.current) > 0

  return {
    ...base,
    latest,
    registry: usedRegistry,
    degraded,
    publishing,
    hasUpdate,
    mirror: mirrorReport,
  }
}
