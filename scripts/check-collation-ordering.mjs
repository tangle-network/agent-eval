/**
 * Collation-ordering gate.
 *
 * RFC 8785 canonicalizes an array BY POSITION. A sort in front of a canonical
 * serialization therefore decides the digest bytes, and a comparator built on
 * `String.prototype.localeCompare` reads the host's collation rather than the
 * value: the ids `Accuracy, brevity, Clarity` order as `Accuracy,brevity,Clarity`
 * under an en-US collation and as `Accuracy,Clarity,brevity` by code unit, and
 * the two produce different digests for the same data. A digest that moves with
 * the machine is not an identity.
 *
 * The rule is narrow on purpose: a `localeCompare` comparator is reported only
 * inside a function that ALSO canonicalizes or hashes. Ordering a table a human
 * reads is not this gate's business, and a Markdown renderer that sorts rows
 * does not canonicalize, so it is not reported.
 *
 * The type system cannot express this: `a.localeCompare(b)` is an ordinary,
 * well-typed comparator. `compareCodeUnits` in `src/ledger-core/canonical.ts`
 * is the sanctioned alternative.
 */

import { readFileSync, statSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseSync } from 'oxc-parser'
import { functionName, lineOf, sourceFiles, visitNodes } from './source-scan.mjs'

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Calls that turn a value into canonical bytes or a digest. */
const CANONICALIZERS = new Set([
  'canonicalString',
  'hashCanonical',
  'canonicalDigest',
  'createHash',
  'contentHash',
  'sha256Digest',
])

/** A member call whose name ends here also counts: `x.someDigest(...)`. */
const CANONICALIZER_SUFFIX = /Digest$/

/**
 * Comparators that must keep `localeCompare` even though their function also
 * hashes. `file` and `fn` must both match; an entry matching nothing fails the
 * gate, so a stale waiver cannot hide a new one.
 */
const ALLOWLIST = []

const FUNCTION_NODES = new Set([
  'FunctionDeclaration',
  'FunctionExpression',
  'ArrowFunctionExpression',
])

export function checkCollationOrdering({ root = REPOSITORY_ROOT, allowlist = ALLOWLIST } = {}) {
  const offences = []
  const usedWaivers = new Set()
  const sourceRoot = resolve(root, 'src')
  if (statSync(sourceRoot, { throwIfNoEntry: false })?.isDirectory()) {
    for (const file of sourceFiles(sourceRoot)) {
      const relativePath = relative(root, file).replaceAll('\\', '/')
      if (/\.(test|spec)\.ts$/.test(relativePath)) continue
      collect({ file, relativePath, allowlist, usedWaivers, offences })
    }
  }
  return {
    offences,
    unusedWaivers: allowlist.filter((entry) => !usedWaivers.has(`${entry.file} ${entry.fn}`)),
  }
}

function collect({ file, relativePath, allowlist, usedWaivers, offences }) {
  const source = readFileSync(file, 'utf8')
  const { program, errors } = parseSync(file, source)
  if (errors.length > 0) throw new Error(`${relativePath}: parse failed — ${errors[0].message}`)

  eachTopLevelFunction(program, (fn) => {
    if (!canonicalizes(fn)) return
    const line = collatingSortLine(fn, source)
    if (line === undefined) return
    const name = functionName(fn, source)
    const waiver = allowlist.find((e) => e.file === relativePath && e.fn === name)
    if (waiver !== undefined) usedWaivers.add(`${waiver.file} ${waiver.fn}`)
    else offences.push({ file: relativePath, line, fn: name })
  })
}

/** Visit every function, innermost scopes included, exactly once. */
function eachTopLevelFunction(program, visitor) {
  visitNodes(program, (node) => {
    if (FUNCTION_NODES.has(node.type)) visitor(node)
  })
}

/** Whether the body turns a value into canonical bytes or a digest. */
function canonicalizes(fn) {
  let found = false
  visitNodes(fn.body, (node) => {
    if (node.type !== 'CallExpression') return
    const callee = node.callee
    const name =
      callee?.type === 'Identifier'
        ? callee.name
        : callee?.type === 'MemberExpression'
          ? callee.property?.name
          : undefined
    if (typeof name !== 'string') return
    if (CANONICALIZERS.has(name) || CANONICALIZER_SUFFIX.test(name)) found = true
  })
  return found
}

/** The line of a `.sort(...)` whose comparator calls `localeCompare`. */
function collatingSortLine(fn, source) {
  let line
  visitNodes(fn.body, (node) => {
    if (line !== undefined) return
    if (node.type !== 'CallExpression') return
    if (node.callee?.type !== 'MemberExpression') return
    if (node.callee.property?.name !== 'sort') return
    for (const argument of node.arguments ?? []) {
      if (!callsLocaleCompare(argument)) continue
      line = lineOf(source, argument.start)
      return
    }
  })
  return line
}

function callsLocaleCompare(node) {
  let found = false
  visitNodes(node, (child) => {
    if (child.type !== 'CallExpression') return
    if (child.callee?.type !== 'MemberExpression') return
    if (child.callee.property?.name === 'localeCompare') found = true
  })
  return found
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { offences, unusedWaivers } = checkCollationOrdering()
  for (const offence of offences) {
    console.error(
      `${offence.file}:${offence.line}: ${offence.fn}() orders with localeCompare and then canonicalizes — ` +
        'the host collation would decide the bytes. Sort with compareCodeUnits from src/ledger-core/canonical.ts.',
    )
  }
  for (const waiver of unusedWaivers) {
    console.error(
      `scripts/check-collation-ordering.mjs: the allowlist entry for ${waiver.fn}() in ${waiver.file} matches nothing; remove it.`,
    )
  }
  if (offences.length > 0 || unusedWaivers.length > 0) {
    console.error(
      '\nRFC 8785 canonicalizes an array by position, so an ordering that reads the host collation makes the digest a property of the machine. compareCodeUnits is the one comparator for an ordering that reaches a digest.',
    )
    process.exitCode = 1
  } else {
    console.log('collation ordering gate valid: no canonicalizing function orders with localeCompare')
  }
}
