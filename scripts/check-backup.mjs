/**
 * Live check for the pre-flight and rollback module.
 *
 * Run with `node scripts/check-backup.mjs`.
 */
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  checkAvailability,
  createBackup,
  listBackups,
  resolvePackageDir,
  resolveBackupsRoot,
  tarballUrl,
} from '../lib/backup.js'
import { DEFAULT_REGISTRY, DEFAULT_MIRROR, readOwnVersion } from '../lib/update.js'

let failures = 0
const fail = (message) => {
  failures += 1
  console.log(`FAIL ${message}`)
}
const pass = (message) => console.log(`PASS ${message}`)

console.log('--- package dir ---')
const pkgDir = resolvePackageDir()
console.log('resolvePackageDir() =', pkgDir)
if (!existsSync(join(pkgDir, 'package.json'))) fail('no package.json beside lib/')
else pass('package.json found')

console.log('\n--- backup root resolution ---')
console.log('default root =', resolveBackupsRoot({}))
if (resolveBackupsRoot({ backupPath: 'C:\\tmp\\x' }) !== 'C:\\tmp\\x') fail('backupPath override ignored')
else pass('backupPath override honoured')

console.log('\n--- tarball url ---')
const url = tarballUrl(DEFAULT_REGISTRY, 'dsh-solution-ledger', '0.2.3')
console.log(url)
if (url !== 'https://registry.npmjs.org/dsh-solution-ledger/-/dsh-solution-ledger-0.2.3.tgz') fail('unexpected url shape')
else pass('tarball url shape')

console.log('\n--- availability: a published version ---')
const live = await checkAvailability({
  packageName: 'dsh-solution-ledger',
  version: '0.2.3',
  registries: [DEFAULT_REGISTRY, DEFAULT_MIRROR],
})
for (const entry of live) console.log(`  ${entry.registry} → ${entry.status} ok=${entry.ok}`)
if (live[0]?.ok !== true) fail('npmjs does not serve the published 0.2.3 tarball')
else pass('npmjs serves 0.2.3')

console.log('\n--- availability: a version that does not exist ---')
const missing = await checkAvailability({
  packageName: 'dsh-solution-ledger',
  version: '99.99.99',
  registries: [DEFAULT_REGISTRY],
})
for (const entry of missing) console.log(`  ${entry.registry} → ${entry.status} ok=${entry.ok}`)
if (missing[0]?.ok === true) fail('a nonexistent version was reported available')
else pass('nonexistent version refused')

console.log('\n--- copy a package then back it up ---')
const sandbox = mkdtempSync(join(tmpdir(), 'sl-backup-'))
const fakePkg = join(sandbox, 'pkg')
cpSync(pkgDir, fakePkg, {
  recursive: true,
  filter: (src) => !src.includes('node_modules') && !src.includes(`${'\\'}.git`),
})
// A backup root inside the package is refused: it would copy its own output.
try {
  createBackup({ backupsRoot: join(fakePkg, 'inside'), packageName: 'dsh-solution-ledger', packageDir: fakePkg })
  fail('a backup root inside the package was accepted')
} catch {
  pass('backup root inside the package refused')
}

const root = join(sandbox, 'backups')
const meta = createBackup({
  backupsRoot: root,
  packageName: 'dsh-solution-ledger',
  version: readOwnVersion(),
  packageDir: fakePkg,
})
console.log(JSON.stringify(meta, null, 2))
if (!existsSync(join(meta.path, 'package.json'))) fail('backup is not an installable package')
else pass('backup contains package.json')
if (!existsSync(join(meta.path, 'backup.json'))) fail('backup.json missing')
else pass('backup.json written')
if (!existsSync(join(meta.path, 'RESTORE.md'))) fail('RESTORE.md missing')
else pass('RESTORE.md written')
if (existsSync(join(meta.path, 'node_modules'))) fail('node_modules copied into the backup')
else pass('node_modules excluded')
if (meta.files < 5) fail(`suspiciously few files copied: ${meta.files}`)

const restoreText = readFileSync(join(meta.path, 'RESTORE.md'), 'utf8')
if (!restoreText.includes(`file:${meta.path}`)) fail('RESTORE.md lacks the install command')
else pass('RESTORE.md names the restore command')

console.log('\n--- listing ---')
const listed = listBackups(root)
if (listed.length !== 1) fail(`expected 1 backup, got ${listed.length}`)
else pass('one backup listed')
if (listed[0]?.version !== meta.version) fail('listed version mismatch')
else pass('listed version matches')

rmSync(sandbox, { recursive: true, force: true })
console.log('\ncleaned', sandbox)

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'}`)
process.exitCode = failures === 0 ? 0 : 1
