import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from './lib/index.js'

const dir = await mkdtemp(join(tmpdir(), 'sl-'))
const statePath = join(dir, 'ledger.json')

const defs = new Map()
const hooks = []
let disposer
const ctx = {
  tools: { register: (def) => { defs.set(def.name, def); return () => defs.delete(def.name) } },
  on: (event, fn) => { hooks.push({ event, fn }); return () => {} },
  effect: (fn) => { disposer = fn(); return () => {} },
  // No web server in this harness: the browser routes are optional.
  get: () => undefined,
}

await apply(ctx, { statePath, pushOnToolError: true, pushMinScore: 4 })
console.log('tools =', [...defs.keys()].join(','), '| hooks =', hooks.map((h) => h.event).join(','))

const log = defs.get('solution_log')
const search = defs.get('solution_search')
const agent = { id: 'sess-1', session: { header: { cwd: 'D:\\work' } } }
const run = (def, args) => def.execute(args, { agent, signal: { aborted: false } })

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

await disposer?.()
await rm(dir, { recursive: true, force: true })
console.log('\ndone')
