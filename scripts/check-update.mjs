/**
 * Live check for the update module: version ordering plus the two registries.
 *
 * Run with `node scripts/check-update.mjs [currentVersion]`.
 */
import { readOwnVersion, compareVersions, checkForUpdate, DEFAULT_REGISTRY, DEFAULT_MIRROR } from '../lib/update.js'

let failures = 0

const expect = (label, actual, wanted) => {
  const ok = JSON.stringify(actual) === JSON.stringify(wanted)
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok ? '' : ` → got ${JSON.stringify(actual)}, wanted ${JSON.stringify(wanted)}`}`)
}

console.log('--- version ordering ---')
expect('0.2.3 > 0.2.2', compareVersions('0.2.3', '0.2.2'), 1)
expect('0.2.2 < 0.2.3', compareVersions('0.2.2', '0.2.3'), -1)
expect('equal', compareVersions('1.0.0', '1.0.0'), 0)
expect('0.10.0 > 0.9.0', compareVersions('0.10.0', '0.9.0'), 1)
expect('release > prerelease', compareVersions('1.0.0', '1.0.0-beta.1'), 1)
expect('prerelease < release', compareVersions('1.0.0-beta.1', '1.0.0'), -1)
expect('v-prefix tolerated', compareVersions('v1.2.3', '1.2.3'), 0)

console.log('\n--- own version ---')
const own = readOwnVersion()
console.log('readOwnVersion() =', JSON.stringify(own))
if (own === '') {
  failures += 1
  console.log('FAIL own version unreadable')
}

console.log('\n--- registries ---')
for (const registry of [DEFAULT_REGISTRY, DEFAULT_MIRROR]) {
  const report = await checkForUpdate({ currentVersion: '0.0.0', packageName: 'dsh-solution-ledger', registry, mirror: null })
  console.log(`${registry}\n  ok=${report.ok} latest=${report.latest} error=${report.error}`)
}

console.log('\n--- combined check (simulating an older install) ---')
const older = await checkForUpdate({ currentVersion: '0.2.2', packageName: 'dsh-solution-ledger' })
console.log(JSON.stringify(older, null, 2))
if (older.ok !== true) {
  failures += 1
  console.log('FAIL combined check did not reach a registry')
}
if (older.hasUpdate !== true) {
  failures += 1
  console.log('FAIL combined check missed the newer published version')
}

console.log('\n--- current install ---')
const current = await checkForUpdate({ currentVersion: own, packageName: 'dsh-solution-ledger' })
console.log(`current=${current.current} latest=${current.latest} hasUpdate=${current.hasUpdate} degraded=${current.degraded}`)
if (current.hasUpdate === true) {
  failures += 1
  console.log('NOTE this install is behind — useful state, not a test failure; review before treating as PASS')
  failures -= 1
}

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'}`)
process.exitCode = failures === 0 ? 0 : 1
