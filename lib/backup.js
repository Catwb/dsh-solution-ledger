/**
 * Pre-flight checks and rollback copies for an update.
 *
 * Two things must be true before this plugin sends anyone to the Plugins page
 * to install a newer version:
 *
 * 1. The target version is actually downloadable. A version that exists in
 *    `dist-tags` but whose tarball 404s would leave the user with a removal and
 *    no installation, which is the worst outcome of an update.
 * 2. The running version can be brought back. A published release can be
 *    broken, and `updateBundle` refuses to go backwards, so the copy taken here
 *    is the only local way back.
 *
 * The backup is a complete, installable package directory: rollback is
 * `dsh plugin add file:<backup>`.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Directories never worth copying: rebuilt or re-fetched, and often huge. */
const EXCLUDED = new Set(['node_modules', '.git', '.pnpm-store'])

/** Metadata file written beside a backup copy. */
export const MANIFEST_NAME = 'backup.json'

/** Human-readable rollback steps written beside a backup copy. */
export const RESTORE_NAME = 'RESTORE.md'

/**
 * Resolve this package's own directory, the one holding `package.json`.
 * @returns the absolute directory path.
 */
export function resolvePackageDir() {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..')
}

/**
 * Resolve the backup root. Copies are global state like the ledger itself, so
 * they belong beside it rather than inside a project checkout.
 * @param config - the Loader row config.
 * @returns absolute path of the directory holding every backup.
 */
export function resolveBackupsRoot(config) {
  if (typeof config?.backupPath === 'string' && config.backupPath.length > 0) return config.backupPath
  const home = process.env.DSH_HOME
  if (typeof home === 'string' && home.length > 0) return join(home, 'solution-ledger-backups')
  return join(process.cwd(), '.solution-ledger-backups')
}

/**
 * Copy one directory tree, skipping excluded directories.
 * @param source - directory to read.
 * @param target - directory to write into; created when missing.
 * @returns the file count and byte total actually copied.
 */
function copyTree(source, target, stats = { files: 0, bytes: 0 }) {
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (entry.isDirectory() && EXCLUDED.has(entry.name)) continue
    const from = join(source, entry.name)
    const to = join(target, entry.name)
    if (entry.isDirectory()) {
      mkdirSync(to, { recursive: true })
      copyTree(from, to, stats)
      continue
    }
    if (!entry.isFile()) continue
    copyFileSync(from, to)
    stats.files += 1
    try {
      stats.bytes += statSync(from).size
    } catch {
      // A size that cannot be read does not invalidate a completed copy.
    }
  }
  return stats
}

/**
 * Build one registry's tarball URL for an exact version.
 * @param registry - registry base URL.
 * @param packageName - package name.
 * @param version - exact version.
 * @returns the tarball URL.
 */
export function tarballUrl(registry, packageName, version) {
  const base = String(registry).replace(/\/+$/, '')
  return `${base}/${packageName}/-/${packageName}-${version}.tgz`
}

/**
 * Confirm a published version can actually be downloaded.
 *
 * A `dist-tags` entry proves only that the version was published, not that the
 * file behind it resolves — and a mirror can carry the tag without the tarball.
 * The check is a ranged GET rather than HEAD because some CDNs answer HEAD with
 * 405 while serving the body normally.
 * @param options - availability parameters.
 * @param options.registries - registries to ask, in reporting order.
 * @returns one entry per registry, each with `ok` and `status`.
 */
export async function checkAvailability(options) {
  const { packageName, version, registries, timeoutMs = 8000, fetchImpl = globalThis.fetch } = options ?? {}
  const results = []
  if (typeof fetchImpl !== 'function' || typeof version !== 'string' || version === '') return results

  for (const registry of registries) {
    const url = tarballUrl(registry, packageName, version)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetchImpl(url, {
        signal: controller.signal,
        method: 'GET',
        // One byte is enough to distinguish "served" from "not found" without
        // downloading a package just to look at it.
        headers: { Range: 'bytes=0-0', 'Cache-Control': 'no-cache' },
      })
      // 206 for a satisfied range, 200 for a registry that ignores Range.
      const ok = response.status === 200 || response.status === 206
      results.push({ registry, url, status: response.status, ok, error: ok ? null : `http ${response.status}` })
    } catch (error) {
      const reason = error?.name === 'AbortError' ? 'timeout' : String(error?.message ?? error).slice(0, 120)
      results.push({ registry, url, status: 0, ok: false, error: reason })
    } finally {
      clearTimeout(timer)
    }
  }
  return results
}

/**
 * Write the rollback document for one backup.
 * @param meta - the backup metadata.
 * @returns markdown text.
 */
function restoreDocument(meta) {
  return [
    `# Rollback for ${meta.packageName} ${meta.version}`,
    '',
    `Taken ${new Date(meta.createdAt).toISOString()} from \`${meta.source}\`.`,
    `Contains ${meta.files} file(s), ${meta.bytes} byte(s).`,
    '',
    'This directory is a complete package: installing it restores the version',
    'that was running when the copy was taken.',
    '',
    '## Registry install or link install',
    '',
    '```bash',
    `dsh plugin --profile <profile> add file:${meta.path}`,
    '```',
    '',
    'Remove and re-add the bundle if the profile already lists it:',
    '',
    '```bash',
    `dsh plugin --profile <profile> remove ${meta.packageName}`,
    `dsh plugin --profile <profile> add file:${meta.path}`,
    '```',
    '',
    '## Development link',
    '',
    'When the plugin was linked from a Git checkout, that checkout can be rolled',
    'back instead, which keeps the link intact:',
    '',
    '```bash',
    `git -C "${meta.source}" log --oneline -5   # find the commit to return to`,
    `git -C "${meta.source}" checkout <commit>`,
    '```',
    '',
    '## Note',
    '',
    'A rolled-back copy carries whatever version it was taken from, so it may be',
    'older than the newest published release. Reinstall from the registry when a',
    'fixed version is available.',
    '',
  ].join('\n')
}

/**
 * Copy the running package into the backup root.
 * @param options - backup parameters.
 * @param options.backupsRoot - directory holding every backup.
 * @param options.version - version being backed up, used in the folder name.
 * @param options.packageName - package name recorded in the manifest.
 * @param options.packageDir - package directory; defaults to this package.
 * @returns the written metadata.
 */
export function createBackup(options) {
  const {
    backupsRoot,
    packageName,
    version = '',
    packageDir = resolvePackageDir(),
    source,
  } = options ?? {}

  const sourceDir = resolve(packageDir)
  const root = resolve(backupsRoot)

  // Guard against a backup root inside the tree being copied: that would make
  // the copy recurse into its own output.
  if (root === sourceDir || root.startsWith(`${sourceDir}${sep}`)) {
    throw new Error(`backup root ${root} is inside the package directory ${sourceDir}`)
  }
  if (!existsSync(join(sourceDir, 'package.json'))) {
    throw new Error(`no package.json in ${sourceDir}`)
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const name = version === '' ? stamp : `${version}-${stamp}`
  const target = join(root, name)
  mkdirSync(target, { recursive: true })

  const stats = copyTree(sourceDir, target)
  const meta = {
    schema: 1,
    packageName,
    version,
    createdAt: Date.now(),
    path: target,
    source: source ?? sourceDir,
    files: stats.files,
    bytes: stats.bytes,
  }
  writeFileSync(join(target, MANIFEST_NAME), `${JSON.stringify(meta, null, 2)}\n`, 'utf8')
  writeFileSync(join(target, RESTORE_NAME), restoreDocument(meta), 'utf8')
  return meta
}

/**
 * List the backups under one root, newest first.
 * @param backupsRoot - directory holding every backup.
 * @returns the readable manifests; unreadable entries are skipped.
 */
export function listBackups(backupsRoot) {
  const root = resolve(backupsRoot)
  if (!existsSync(root)) return []
  const found = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const manifestPath = join(root, entry.name, MANIFEST_NAME)
    if (!existsSync(manifestPath)) continue
    try {
      const meta = JSON.parse(readFileSync(manifestPath, 'utf8'))
      if (meta !== null && typeof meta === 'object') found.push({ ...meta, name: basename(entry.name) })
    } catch {
      // A half-written manifest simply does not appear in the list.
    }
  }
  return found.sort((left, right) => (right.createdAt ?? 0) - (left.createdAt ?? 0))
}
