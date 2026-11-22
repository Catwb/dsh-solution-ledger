/**
 * Locale consistency check for the client half.
 *
 * A missing key does not throw: the page renders the raw key, which looks like
 * a bug only to whoever opens that panel. This compares the two dictionaries
 * and every literal `t('…')` call so a gap fails here instead.
 *
 * Run with `node scripts/check-locale.mjs`.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const file = join(root, 'lib', 'client.js')
const text = readFileSync(file, 'utf8')

/**
 * Read one object literal that follows `const <name> = {` and evaluate it.
 * @param name - variable name.
 * @returns the parsed object, or null when the literal cannot be found.
 */
function readLiteral(name) {
  const marker = new RegExp(`const\\s+${name}\\s*=\\s*\\{`)
  const match = marker.exec(text)
  if (match === null) return null
  let index = match.index + match[0].length - 1
  let depth = 0
  let quote = null
  for (let cursor = index; cursor < text.length; cursor += 1) {
    const char = text[cursor]
    if (quote !== null) {
      if (char === '\\') cursor += 1
      else if (char === quote) quote = null
      continue
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char
      continue
    }
    if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) {
        const literal = text.slice(index, cursor + 1)
        return new Function(`return (${literal})`)()
      }
    }
  }
  return null
}

/**
 * Flatten an object into dotted key paths.
 * @param value - object to flatten.
 * @param prefix - accumulated path.
 * @param out - collector.
 * @returns the collector.
 */
function flatten(value, prefix = '', out = new Set()) {
  for (const [key, child] of Object.entries(value)) {
    const path = prefix === '' ? key : `${prefix}.${key}`
    if (child !== null && typeof child === 'object' && !Array.isArray(child)) flatten(child, path, out)
    else out.add(path)
  }
  return out
}

const zh = readLiteral('zh')
const en = readLiteral('en')

if (zh === null || en === null) {
  console.log('FAIL could not locate the zh/en dictionaries in lib/client.js')
  process.exit(1)
}

const zhKeys = flatten(zh)
const enKeys = flatten(en)

let failures = 0
const report = (label, keys) => {
  if (keys.length === 0) {
    console.log(`PASS ${label}`)
    return
  }
  failures += keys.length
  console.log(`FAIL ${label}: ${keys.join(', ')}`)
}

report('keys only in zh', [...zhKeys].filter((key) => !enKeys.has(key)))
report('keys only in en', [...enKeys].filter((key) => !zhKeys.has(key)))

// Every static `t('key')` must resolve in both dictionaries.
const used = new Set()
for (const match of text.matchAll(/\bt\(\s*'([A-Za-z0-9_.]+)'\s*\)/g)) used.add(match[1])
const missing = [...used].filter((key) => !zhKeys.has(key))
report('t() keys missing from the dictionaries', missing)

// A dictionary entry nobody reads is dead weight, not an error worth failing.
const unused = [...zhKeys].filter((key) => !used.has(key) && !key.includes('.'))
if (unused.length > 0) console.log(`NOTE ${unused.length} key(s) not referenced literally: ${unused.join(', ')}`)

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'}`)
process.exitCode = failures === 0 ? 0 : 1
