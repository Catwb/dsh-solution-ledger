/**
 * Behaviour of the scorer, exercised without a ledger.
 *
 * The case that motivated this file: a drive-letter path carries the same file
 * and folder names on every entry of a machine — the same `文档` / `工作` / `src` /
 * `node_modules`. Token evidence from a path therefore appeared in unrelated
 * texts and vouched for entries that had nothing to do with each other. A plain
 * `old_string was not found in D:\文档\1工作站\...` error matched a Windows ACL
 * entry at score 13 purely because both contained the same Chinese folder names.
 *
 * Run with `node scripts/check-search.mjs`.
 */
import { scoreEntry, tokenize } from '../lib/search.js'

let failures = 0
const expect = (label, ok, detail) => {
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok || detail === undefined ? '' : ` → ${detail}`}`)
}

/** The push threshold these cases are judged against. */
const GATE = 10

/** A real confirmed entry about Windows sandbox ACLs, path and all. */
const aclEntry = {
  id: 'acl',
  kind: 'troubleshoot',
  domain: 'environment',
  title: 'workspace-write 下工作区写入被拒的根因：子目录缺 Low Mandatory Level 标签',
  problem:
    'Furrity（Astro 7.2.0 + vite 8.2.0，工作区 D:\\文档\\1工作站\\testTheme\\Furrity）在 workspace-write 档位下，工作区根、dist、.astro 内写文件正常，但 src、src\\constants 内写文件一律 EPERM。',
  resolution: '用 diagnose 脚本修复，改前备份 DACL',
  rejected: 'EPERM: operation not permitted',
  signals: [
    'EPERM: operation not permitted',
    'Mandatory Label',
    'Mandatory Level',
    'require is not defined',
    'Unable to load your Astro config',
    'npm-cache',
  ],
  tags: ['windows', 'sandbox'],
  scope: 'machine',
  status: 'confirmed',
  archived: false,
  createdAt: 0,
  updatedAt: 0,
  lastHitAt: 0,
  hits: 0,
  pushed: 0,
  source: {},
}

const score = (text, entry = aclEntry) =>
  scoreEntry(entry, { text, tokens: tokenize(text), platform: 'win32', cwd: 'D:\\work' }).score

console.log('--- a shared directory path is not evidence ---')
{
  const unrelated = 'Error: old_string was not found in "D:\\文档\\1工作站\\dsh-plugins\\solution-ledger\\lib\\client.js"'
  const value = score(unrelated)
  expect('unrelated error stays under the gate', value < GATE, `score ${value}, gate ${GATE}`)
  expect('its path contributed no chinese tokens', !tokenize(unrelated).has('文档'), `tokens ${[...tokenize(unrelated)].join('|')}`)
}

console.log('\n--- the failure the entry was recorded for still matches ---')
{
  const real =
    'Error: [sandbox: file access denied under workspace-write mode] EPERM: operation not permitted, write D:\\文档\\1工作站\\testTheme\\Furrity\\src'
  const value = score(real)
  expect('real sandbox error clears the gate', value >= GATE, `score ${value}`)
}

console.log('\n--- signals still match verbatim, paths included ---')
{
  const locked = 'EPERM: npm-cache is locked'
  const value = score(locked)
  expect('a signal hit still counts', value >= 5, `score ${value}`)
}

console.log('\n--- chinese text keeps working without paths ---')
{
  const entry = { ...aclEntry, title: '工作区写入被拒', problem: '工作区写入被拒，子目录缺标签' }
  const value = score('工作区写入被拒', entry)
  expect('a chinese query still matches chinese text', value >= GATE, `score ${value}`)
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`)
process.exitCode = failures === 0 ? 0 : 1
