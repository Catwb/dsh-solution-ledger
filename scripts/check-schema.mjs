/**
 * Validate every registered tool's parameter and output schema.
 *
 * Two different failures have already shipped from this plugin, and both killed
 * the whole turn with `Invalid schema for function ...`:
 *
 * 1. A bare double quote inside a parameter description. Some providers reject
 *    the tool schema over it, so the source text is scanned for risky
 *    characters rather than trusting JSON.stringify.
 * 2. A parameter table written as bare properties with a boolean `required` on
 *    each field. The Host passes `parameters` to the provider unmodified, so a
 *    strict provider sees `{"type":"string","required":true,...}` where a JSON
 *    Schema expects a property name. Scanning characters alone reported this
 *    one as CLEAN, which is why the structural checks below exist.
 *
 * Run with `node scripts/check-schema.mjs ./lib/index.js`.
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

const JSON_TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'])

let problems = 0
const fail = (message) => {
  console.log(`  FAIL  ${message}`)
  problems += 1
}

/** Scan one string for characters that break provider-side parsing. */
const scanText = (where, text) => {
  if (typeof text !== 'string') return
  for (const [needle, label] of RISKY) {
    if (text.includes(needle)) fail(`${where} contains a ${label}`)
  }
}

/**
 * Walk one JSON Schema node and report anything a strict provider rejects.
 * @param where - dotted path for the report.
 * @param node - schema node.
 * @param isRoot - true for a `parameters` or output `schema` root.
 */
function walkSchema(where, node, isRoot = false) {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) {
    fail(`${where} is not a schema object`)
    return
  }

  if (node.type !== undefined && !JSON_TYPES.has(node.type)) {
    fail(`${where}.type is not a JSON Schema type: ${JSON.stringify(node.type)}`)
  }

  // A boolean `required` on a property is the exact shape that broke 0.2.6.
  if (node.required !== undefined && !Array.isArray(node.required)) {
    fail(`${where}.required must be an array of property names, got ${JSON.stringify(node.required)}`)
  }
  if (Array.isArray(node.required)) {
    for (const item of node.required) {
      if (typeof item !== 'string') fail(`${where}.required contains a non-string: ${JSON.stringify(item)}`)
    }
    const known = node.properties !== null && typeof node.properties === 'object' ? Object.keys(node.properties) : null
    if (known !== null) {
      for (const item of node.required) {
        if (typeof item === 'string' && !known.includes(item)) fail(`${where}.required names "${item}", which is not in properties`)
      }
    }
  }

  if (node.properties !== undefined) {
    if (node.properties === null || typeof node.properties !== 'object' || Array.isArray(node.properties)) {
      fail(`${where}.properties is not an object`)
    } else {
      if (node.type !== undefined && node.type !== 'object') {
        fail(`${where} declares properties but type is ${JSON.stringify(node.type)}`)
      }
      for (const [key, child] of Object.entries(node.properties)) {
        walkSchema(`${where}.properties.${key}`, child)
      }
    }
  }

  if (node.items !== undefined) walkSchema(`${where}.items`, node.items)

  // Anything provider-facing must survive a JSON round trip unchanged.
  let round
  try {
    round = JSON.parse(JSON.stringify(node))
  } catch (error) {
    fail(`${where} does not survive a JSON round trip: ${String(error)}`)
    return
  }
  if (JSON.stringify(round) !== JSON.stringify(node)) fail(`${where} changes across a JSON round trip`)

  if (isRoot && node.type !== 'object') fail(`${where} must declare type "object"`)
  if (isRoot && (node.properties === null || typeof node.properties !== 'object')) {
    fail(`${where} must wrap fields in "properties"; a bare property table reaches the provider as invalid`)
  }
}

for (const [name, definition] of defs) {
  console.log(`\n${name}`)
  scanText(`${name}.description`, definition.description)

  walkSchema(`${name}.parameters`, definition.parameters, true)
  const paramCount = Object.keys(definition.parameters?.properties ?? {}).length

  for (const [key, spec] of Object.entries(definition.parameters?.properties ?? {})) {
    scanText(`${name}.parameters.${key}.description`, spec?.description)
  }

  if (definition.output?.schema !== undefined) {
    walkSchema(`${name}.output.schema`, definition.output.schema, true)
  }

  console.log(`  params ${paramCount}, schema ${JSON.stringify(definition.parameters).length} chars`)
}

await rm(dir, { recursive: true, force: true })
console.log(problems === 0 ? '\nCLEAN' : `\n${problems} problem(s)`)
process.exit(problems === 0 ? 0 : 1)
