import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { apply } from './lib/index.js'

const dir = await mkdtemp(join(tmpdir(), 'sl-'))
const statePath = join(dir, 'ledger.json')

const defs = new Map()
const hooks = []
const routes = new Map()
let disposer

/** Minimal Web carrier, so the HTTP half registers its routes for testing. */
const webServer = {
  register: (route) => {
    routes.set(route.path, route.handler)
    return () => routes.delete(route.path)
  },
}

/** Trusted caller: the fence itself is covered by check-guard.mjs. */
const connection = { requestRejection: () => undefined }

const ctx = {
  tools: { register: (def) => { defs.set(def.name, def); return () => defs.delete(def.name) } },
  on: (event, fn) => { hooks.push({ event, fn }); return () => {} },
  effect: (fn) => { disposer = fn(); return () => {} },
  get: (name) => {
    if (name === 'webServer') return webServer
    if (name === 'connection') return connection
    return undefined
  },
}

await apply(ctx, { statePath, pushOnToolError: true, pushMinScore: 4 })
console.log('tools =', [...defs.keys()].join(','), '| hooks =', hooks.map((h) => h.event).join(','))

const log = defs.get('solution_log')
const search = defs.get('solution_search')
const agent = { id: 'sess-1', session: { header: { cwd: 'D:\\work' } } }
const run = (def, args) => def.execute(args, { agent, signal: { aborted: false } })

/**
 * Invoke one registered route the way the Web carrier would.
 * @param path - absolute route path.
 * @param method - HTTP method.
 * @param body - JSON body for POST, omitted for GET.
 * @returns the status and the parsed payload.
 */
async function callRoute(path, method, body) {
  const handler = routes.get(path)
  if (typeof handler !== 'function') throw new Error(`route ${path} is not registered`)
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')])
  req.method = method
  req.url = path
  req.headers = { host: '127.0.0.1:14559' }
  const res = {
    headersSent: false,
    status: 0,
    body: '',
    writeHead(status) {
      this.status = status
      this.headersSent = true
    },
    end(text) {
      this.body = text ?? ''
    },
  }
  await handler(req, res)
  return { status: res.status, json: res.body === '' ? null : JSON.parse(res.body) }
}

/** Read one entry back through the list route. */
async function readBack(id) {
  const { json } = await callRoute('/solution-ledger/list', 'GET')
  return json.entries.find((entry) => entry.id === id) ?? null
}

const a = await run(log, {
  kind: 'troubleshoot',
  domain: 'environment',
  title: 'pwsh 沙箱在工作区起不来时补 WRITE_OWNER',
  problem: 'sandbox-local: windows-acl workspace grant failed',
  resolution: '用 diagnose-windows-sandbox-acl 脚本给工作区目录补完整控制权后再跑受限命令',
  signals: ['windows-acl workspace grant failed', 'SetNamedSecurityInfoW'],
  tags: ['windows', 'sandbox', 'acl'],
  scope: 'machine',
  status: 'confirmed',
  verify: '受限模式下重跑 pwsh，能正常输出结果',
})
console.log('\n[1] log confirmed ->', JSON.stringify(a))

const b = await run(log, {
  kind: 'decision',
  domain: 'tooling',
  title: '本地插件放弃 storageDomain 改用 JSON 文件持久化',
  problem: 'link 安装的本地插件解析不到 @deepseek-ai/* 与 zod',
  resolution: '用 $DSH_HOME 下的单个 JSON + 临时文件 rename 原子写',
  rejected: 'storageDomain 需要 zod schema，插件端 import 会失败；schemastery Config 同理',
  tags: ['dsh', 'plugin'],
})
console.log('[2] log draft ->', JSON.stringify(b))

const c = await run(log, {
  kind: 'troubleshoot', domain: 'tooling', title: '未确认的草稿条目不该被自动推送',
  problem: 'x', resolution: 'y', tags: ['dsh'],
})
console.log('[3] log draft2 ->', JSON.stringify(c))

const s1 = await run(search, { query: 'sandbox-local: windows-acl workspace grant failed', limit: 5 })
console.log('\n[4] search by error text:')
console.log(JSON.stringify(s1, null, 2))

const s2 = await run(search, { kind: 'decision', limit: 5 })
console.log('\n[5] search by kind decision:', s2.count, 'hit(s)')

const hook = hooks.find((h) => h.event === 'tools/post-execute').fn
const callHook = (name, text) => hook(
  { name, agent, signal: { aborted: false } },
  { isError: true, content: [{ type: 'text', text }], error: { message: text } },
  async () => ({ kind: 'accept' }),
)

const push1 = await callHook('pwsh', 'Error: sandbox-local: windows-acl workspace grant failed: Win32Error: SetNamedSecurityInfoW failed (Win32 5)')
console.log('\n[6] push on matching failure:')
console.log(push1.content.map((blk) => blk.text).join('\n'))

const push2 = await callHook('pwsh', 'Error: sandbox-local: windows-acl workspace grant failed: Win32Error: SetNamedSecurityInfoW failed (Win32 5)')
console.log('\n[7] same failure again -> no note attached =', push2.content === undefined)

const push3 = await callHook('grep', 'Error: ENOENT no such file')
console.log('[8] unrelated failure -> no note attached =', push3.content === undefined)

const upd = await run(log, { replaces: c.id, status: 'confirmed', title: '草稿确认后即可参与自动推送' })
console.log('\n[9] update via replaces ->', JSON.stringify(upd))

const s3 = await run(search, { query: 'completely unrelated gibberish zzqxv', limit: 5 })
console.log('\n[10] unrelated query ->', s3.count, 'hit(s) (expect 0)')

const s4 = await run(search, { query: '本地插件 ESM 依赖解析失败', limit: 5 })
console.log(
  '[11] cross-topic search ->',
  s4.count,
  'hit(s):',
  s4.entries.map((e) => `${e.score}:${e.title.slice(0, 14)}`).join(' | '),
)

const dup = await run(log, {
  kind: 'troubleshoot',
  domain: 'environment',
  title: 'pwsh 沙箱起不来时补 WRITE_OWNER 权限',
  problem: 'sandbox-local: windows-acl workspace grant failed',
  resolution: '跑 repair 脚本修 ACL',
})
console.log('[12] near-duplicate probe ->', JSON.stringify(dup.similar))

// [13] supersedes: the new entry deprecates an *older, different* entry. This is
// the one path where solution_log intentionally changes another entry.
const sup = await run(log, {
  kind: 'troubleshoot',
  domain: 'environment',
  title: 'pwsh 沙箱修复还要清一次 shell 缓存',
  problem: '旧条目只写了补 ACL，重跑仍读到缓存的拒绝结果',
  resolution: '补完 ACL 后清 shell 缓存再重跑受限命令',
  supersedes: a.id,
})
console.log('\n[13] supersede ->', JSON.stringify(sup))

const dep = await run(search, { status: 'deprecated', limit: 5 })
console.log('[14] deprecated after supersede ->', dep.count, 'hit(s)')
console.log('[15] old entry deprecation confirmed =', dep.entries.some((e) => e.id === a.id))

try {
  await run(log, {
    kind: 'troubleshoot', domain: 'other', title: '指向不存在的取代目标',
    problem: 'x', resolution: 'y', supersedes: 'no-such-id',
  })
  console.log('[16] missing supersedes target -> NOT rejected (bug)')
} catch (error) {
  console.log('[16] missing supersedes target ->', error.message)
}

try {
  await run(log, {
    kind: 'troubleshoot', domain: 'other', title: '自己取代自己应当被拒绝',
    problem: 'x', resolution: 'y', replaces: c.id, supersedes: c.id,
  })
  console.log('[17] self-supersede -> NOT rejected (bug)')
} catch (error) {
  console.log('[17] self-supersede ->', error.message)
}

// The archive button shipped broken because nothing asserted this matrix: every
// case below is a combination that once did the wrong thing.
console.log('\n=== route: /update archive matrix ===')
const z = await run(log, {
  kind: 'troubleshoot',
  domain: 'other',
  title: '归档矩阵测试条目',
  problem: 'archive matrix probe',
  resolution: 'n/a',
})

/** Apply one patch, read the row back, and report whether it landed. */
const step = async (label, patch, check) => {
  const answer = await callRoute('/solution-ledger/update', 'POST', { id: z.id, patch })
  const row = await readBack(z.id)
  console.log(`${label} ->`, check(row, answer) ? 'ok' : `FAIL ${JSON.stringify(row)}`)
}

await step('[R1] archive a draft', { archived: true }, (row) => row.archived === true)
await step('[R2] text edit keeps archive', { problem: 'probe (edited)' }, (row) => row.archived === true)
await step('[R3] confirm clears archive', { status: 'confirmed' }, (row) => row.status === 'confirmed' && row.archived === false)
await step('[R4] explicit archive wins over confirm', { status: 'confirmed', archived: true }, (row) => row.archived === true)
await step('[R5] unarchive', { archived: false }, (row) => row.archived === false)

console.log('\n=== route: confirming an entry severs its supersede link ===')
const oldOne = await run(log, {
  kind: 'troubleshoot',
  domain: 'other',
  title: '被取代的旧条目',
  problem: 'old',
  resolution: 'old fix',
})
const newOne = await run(log, {
  kind: 'troubleshoot',
  domain: 'other',
  title: '取代旧条目的新条目',
  problem: 'new',
  resolution: 'new fix',
  supersedes: oldOne.id,
})
console.log('[R6] supersede deprecates the old entry ->', (await readBack(oldOne.id)).status === 'deprecated' ? 'ok' : 'FAIL')

const revive = await callRoute('/solution-ledger/update', 'POST', { id: oldOne.id, patch: { status: 'confirmed' } })
const revived = await readBack(oldOne.id)
const superseder = await readBack(newOne.id)
console.log('[R7] confirm revives the old entry ->', revived.status === 'confirmed' ? 'ok' : 'FAIL')
console.log(
  '[R8] supersede link cleared ->',
  superseder.supersedes === null && revive.json.unlinked === newOne.id
    ? 'ok'
    : `FAIL ${JSON.stringify({ supersedes: superseder.supersedes, unlinked: revive.json.unlinked })}`,
)

await disposer?.()
await rm(dir, { recursive: true, force: true })
console.log('\ndone')
