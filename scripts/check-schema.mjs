/**
 * Scan every registered tool description for characters that break provider-side
 * schema validation, and prove the parameter object survives a JSON round trip.
 *
 * The reported failure was a bare double quote inside a parameter description:
 * some providers reject the whole tool schema over it, which kills the turn.
 * A quote inside a description would never be escaped wrongly by
 * JSON.stringify, so it has to be caught as source text.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const entry = process.argv[2]
if (entry === undefined) {
  console.error('usage: node check-schema.mjs <path to lib/index.js>')
  process.exit(2)
}

const mod = await import(pathToFileURL(entry).href)
const dir = await mkdtemp(join(tmpdir(), 'schema-scan-'))
const defs = new Map()
const ctx = {
  tools: { register: (definition) => { defs.set(definition.name, definition); return () => {} } },
  on: () => () => {},
  effect: (fn) => { fn(); return () => {} },
  get: () => undefined,
}
await mod.apply(ctx, { statePath: join(dir, 'ledger.json') })

const RISKY = [
  ['"', 'bare double quote'],
  ['\\', 'backslash'],
  ['\n', 'newline'],
  ['\t', 'tab'],
]

let problems = 0
const scan = (where, text) => {
  if (typeof text !== 'string') return
  for (const [needle, label] of RISKY) {
    if (text.includes(needle)) {
      console.log(`  RISKY  ${where}  (${label})`)
      problems += 1
    }
  }
}

for (const [name, definition] of defs) {
  scan(`${name}.description`, definition.description)
  for (const [key, spec] of Object.entries(definition.parameters ?? {})) {
    scan(`${name}.parameters.${key}.description`, spec.description)
    if (spec !== null && typeof spec === 'object' && spec.items !== undefined) {
      scan(`${name}.parameters.${key}.items.description`, spec.items.description)
    }
  }
  const round = JSON.parse(JSON.stringify(definition.parameters))
  if (JSON.stringify(round) !== JSON.stringify(definition.parameters)) {
    console.log(`  ROUNDTRIP MISMATCH ${name}`)
    problems += 1
  }
  console.log(`  ok     ${name}  (${Object.keys(definition.parameters ?? {}).length} params, schema ${JSON.stringify(definition.parameters).length} chars)`)
}

await rm(dir, { recursive: true, force: true })
console.log(problems === 0 ? 'CLEAN' : `${problems} problem(s)`)
process.exit(problems === 0 ? 0 : 1)
