/**
 * Canonical-JSON gate.
 *
 * A digest IS a record's identity. Two records that differ in a real field must
 * not produce one digest, and a record's digest must not depend on which copy
 * of the encoder ran. This package had eleven hand-rolled canonical-JSON
 * encoders that disagreed on `undefined`-valued keys, `Date`, and integer-like
 * key order, so the same value hashed differently depending on the caller.
 *
 * The home is `src/ledger-core/canonical.ts`. The gate reads every function
 * under `src/` and reports the ones that sort object keys AND serialize in the
 * same body — the shape of a twelfth copy. Nothing about the intent is
 * inspected: the pair of operations is the signal, which is why the gate
 * cannot go stale as names change.
 *
 * The type system cannot express this rule: a hand-written
 * `Object.keys(v).sort()` plus `JSON.stringify` is ordinary, well-typed code.
 * A reviewer is the only other check, and a reviewer already missed it eleven
 * times.
 *
 * ALLOWLIST below names the encoders that are deliberately not the home: the
 * private legacy verifiers each durable-record module keeps so a record signed
 * under the retired scheme still verifies. Each is unreachable from any path
 * that writes a digest, and each is retired with its retention window (see
 * docs/experiment.md).
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseSync } from 'oxc-parser'

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** The one canonical-JSON home. */
const HOME = 'src/ledger-core/canonical.ts'

/**
 * Read-only legacy encoders, kept private inside the module that verifies with
 * them so a durable record written under the retired scheme still verifies.
 * `file` and `fn` must both match; a new function in the same file is not
 * covered.
 */
const ALLOWLIST = [
  {
    file: 'src/pre-registration.ts',
    fn: 'legacyContentDigest',
    reason: 'verifies a manifest signed under sha256-content; never writes a digest',
  },
  {
    file: 'src/agent-profile-cell.ts',
    fn: 'legacyCellDigest',
    reason: 'verifies an agent-profile-cell:sha256: id; never mints one',
  },
  {
    file: 'src/experiment/define.ts',
    fn: 'specDigest',
    reason: 'selects the encoder by the seal algo; the legacy branch only verifies',
  },
]

/** Tests and type declarations ship no encoder. */
const SKIPPED = [/\.test\.ts$/, /\.test-support\.ts$/, /\.d\.ts$/]

const FUNCTION_NODES = new Set([
  'FunctionDeclaration',
  'FunctionExpression',
  'ArrowFunctionExpression',
  'TSDeclareFunction',
])

/** Serializers that turn a value into digestible bytes. */
const SERIALIZERS = new Set(['stringify', 'digest', 'update'])

/**
 * Report every function under `root/src` that sorts keys and serializes in one
 * body. Pure apart from reading the tree, so tests drive it over fixtures.
 * Throws on an unparseable source file — a gate that cannot read its own input
 * must not report a pass.
 */
export function checkCanonicalJson({ root = REPOSITORY_ROOT, allowlist = ALLOWLIST } = {}) {
  const offences = []
  const usedWaivers = new Set()
  const sourceRoot = resolve(root, 'src')
  if (statSync(sourceRoot, { throwIfNoEntry: false })?.isDirectory()) {
    for (const file of sourceFiles(sourceRoot)) {
      const relativePath = relative(root, file).replaceAll('\\', '/')
      if (relativePath === HOME) continue
      if (SKIPPED.some((pattern) => pattern.test(relativePath))) continue
      collect({ file, relativePath, allowlist, usedWaivers, offences })
    }
  }
  return {
    offences,
    unusedWaivers: allowlist.filter((entry) => !usedWaivers.has(`${entry.file} ${entry.fn}`)),
  }
}

function* sourceFiles(directory) {
  for (const name of readdirSync(directory).sort()) {
    const path = join(directory, name)
    if (statSync(path).isDirectory()) yield* sourceFiles(path)
    else if (path.endsWith('.ts')) yield path
  }
}

function collect({ file, relativePath, allowlist, usedWaivers, offences }) {
  const source = readFileSync(file, 'utf8')
  const { program, errors } = parseSync(file, source)
  if (errors.length > 0) throw new Error(`${relativePath}: parse failed — ${errors[0].message}`)

  // An encoder often splits the sort into a helper — `JSON.stringify(sortKeys(v))`.
  // Collect the module's own key-sorting helpers first, so a call to one counts
  // as sorting and the split does not evade the gate.
  const sorters = new Set()
  const eachFunction = (visitor) => {
    const walk = (node, enclosing) => {
      if (node === null || typeof node !== 'object') return
      if (Array.isArray(node)) {
        for (const child of node) walk(child, enclosing)
        return
      }
      if (typeof node.type !== 'string') return
      const scope = FUNCTION_NODES.has(node.type) ? node : enclosing
      if (scope !== enclosing) visitor(scope)
      for (const key of Object.keys(node)) {
        if (key === 'type' || key === 'start' || key === 'end') continue
        walk(node[key], scope)
      }
    }
    walk(program, undefined)
  }
  // Only a BOUND function can be called by name, so only a bound one can be a
  // sorting helper. Registering a fallback name here is how one anonymous
  // arrow in a sort chain made every caller of a same-named function read as an
  // encoder.
  eachFunction((fn) => {
    const name = boundName(fn, source)
    if (name === undefined) return
    if (bodyHas(fn, { sorters: new Set() }).sortsKeys) sorters.add(name)
  })
  eachFunction((fn) => {
    const { sortsKeys, serializes } = bodyHas(fn, { sorters })
    if (!(sortsKeys && serializes)) return
    const name = functionName(fn, source)
    const waiver = allowlist.find((e) => e.file === relativePath && e.fn === name)
    if (waiver !== undefined) usedWaivers.add(`${waiver.file} ${waiver.fn}`)
    else offences.push({ file: relativePath, line: lineOf(source, fn.start), fn: name })
  })
}

/**
 * Whether a function body sorts object keys FOR ENCODING, and whether it
 * serializes.
 *
 * Sorting for encoding means the sorted key list is iterated to build
 * something — `.map(...)` over it, or a `for...of` across it — which is the
 * move every encoder makes. A key-SET check sorts too (`Object.keys(v).sort()`
 * compared against an expected list, or joined into one string) and is not an
 * encoder, so it is not reported.
 *
 * Sorting also counts through one of the module's own key-sorting helpers named
 * in `sorters`, so splitting the sort into `JSON.stringify(sortKeys(v))` does
 * not evade the gate.
 */
function bodyHas(fn, { sorters }) {
  let sortsKeys = false
  let serializes = false
  const sortedInto = new Set() // variables holding a sorted key list
  const iterated = new Set() // variables iterated with .map or for...of
  let sortedIsIteratedDirectly = false

  const visit = (node) => {
    if (node === null || typeof node !== 'object') return
    if (Array.isArray(node)) {
      for (const child of node) visit(child)
      return
    }
    if (typeof node.type !== 'string') return

    if (node.type === 'VariableDeclarator' && isSortedKeyList(node.init) && node.id?.name) {
      sortedInto.add(node.id.name)
    }
    if (node.type === 'ForOfStatement') {
      if (isSortedKeyList(node.right)) sortedIsIteratedDirectly = true
      if (node.right?.type === 'Identifier') iterated.add(node.right.name)
    }
    if (node.type === 'CallExpression') {
      if (node.callee?.type === 'MemberExpression') {
        const method = node.callee.property?.name
        if (method === 'map') {
          if (isSortedKeyList(node.callee.object)) sortedIsIteratedDirectly = true
          if (node.callee.object?.type === 'Identifier') iterated.add(node.callee.object.name)
        }
        if (SERIALIZERS.has(method)) serializes = true
      } else if (node.callee?.type === 'Identifier' && sorters.has(node.callee.name)) {
        sortsKeys = true
      }
    }
    for (const key of Object.keys(node)) {
      if (key === 'type' || key === 'start' || key === 'end') continue
      visit(node[key])
    }
  }
  visit(fn.body)
  if (sortedIsIteratedDirectly) sortsKeys = true
  for (const name of sortedInto) if (iterated.has(name)) sortsKeys = true
  return { sortsKeys, serializes }
}

/** True for `Object.keys(x)....sort(...)` — the sorted key list itself. */
function isSortedKeyList(node) {
  if (node === null || typeof node !== 'object') return false
  if (node.type !== 'CallExpression' || node.callee?.type !== 'MemberExpression') return false
  if (node.callee.property?.name !== 'sort') return false
  return sortsObjectKeys(node.callee.object)
}

/** True when the sorted receiver is a key list: `Object.keys(x)`, possibly filtered. */
function sortsObjectKeys(node) {
  if (node === null || typeof node !== 'object') return false
  if (node.type !== 'CallExpression') return false
  const callee = node.callee
  if (callee?.type !== 'MemberExpression') return false
  if (callee.object?.name === 'Object' && callee.property?.name === 'keys') return true
  // `Object.keys(x).filter(...)`, `.map(...)` — still the key list.
  return sortsObjectKeys(callee.object)
}

/**
 * The name a function is BOUND to, or undefined when it has none.
 *
 * A declaration id, a `const`/`let`/`var` binding, or an object-property key.
 * Deliberately NOT the identifier in front of an open paren: an arrow passed as
 * an argument — `sumOver(rows, (row) => …)` — sits behind the text `sumOver(`,
 * and reading that as its name gives a function the name of the thing it is
 * passed to.
 */
function boundName(fn, source) {
  if (fn.id?.name) return fn.id.name
  const before = source.slice(Math.max(0, fn.start - 200), fn.start)
  const declared = before.match(/(?:const|let|var|function)\s+([A-Za-z0-9_$]+)\s*(?::[^=]*)?=?\s*$/)
  if (declared) return declared[1]
  const property = before.match(/([A-Za-z0-9_$]+)\s*:\s*$/)
  return property ? property[1] : undefined
}

/** The name to print for a function. An unbound one is located by its line. */
function functionName(fn, source) {
  return boundName(fn, source) ?? '(anonymous)'
}

function lineOf(source, offset) {
  let line = 1
  for (let index = 0; index < offset; index++) if (source.charCodeAt(index) === 10) line++
  return line
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { offences, unusedWaivers } = checkCanonicalJson()
    for (const offence of offences) {
      console.error(
        `${offence.file}:${offence.line}: ${offence.fn}() sorts object keys and serializes in one ` +
          `body — that is a canonical-JSON encoder. Call canonicalString or hashCanonical from ` +
          `${HOME} instead.`,
      )
    }
    for (const entry of unusedWaivers) {
      console.error(
        `scripts/check-canonical-json.mjs: the allowlist entry for ${entry.fn}() in ${entry.file} ` +
          'matches nothing — delete it.',
      )
    }
    if (offences.length > 0) {
      console.error(
        `\n${offences.length} hand-rolled canonical-JSON encoder(s). Eleven copies of this code ` +
          'disagreed on undefined-valued keys, Date, and integer-like key order, so one value ' +
          `hashed differently depending on the caller. ${HOME} is the one encoder; a legacy ` +
          'verifier that must keep the retired bytes is added to ALLOWLIST with its reason.',
      )
    }
    if (offences.length > 0 || unusedWaivers.length > 0) process.exit(1)
    console.log(
      `canonical json gate valid: ${HOME} is the only encoder under src/ ` +
        `(${ALLOWLIST.length} legacy verifiers waived, all matched)`,
    )
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
