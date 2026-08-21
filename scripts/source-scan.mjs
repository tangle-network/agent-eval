/**
 * Shared reading primitives for the source gates.
 *
 * Both gates walk `src/`, locate a function, and name it. Keeping one copy of
 * each means a fix to how a function is named — such as no longer naming an
 * anonymous arrow after the function it is passed to — reaches every gate at
 * once rather than one of them.
 */

import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** Every `.ts` file under `directory`, in a stable order. */
export function* sourceFiles(directory) {
  for (const name of readdirSync(directory).sort()) {
    const path = join(directory, name)
    if (statSync(path).isDirectory()) yield* sourceFiles(path)
    else if (path.endsWith('.ts')) yield path
  }
}

/**
 * The name a function is BOUND to, or undefined when it has none.
 *
 * A declaration id, a `const`/`let`/`var` binding, or an object-property key.
 * Deliberately NOT the identifier in front of an open paren: an arrow passed as
 * an argument — `sumOver(() => …)` — sits behind the text `sumOver(`, and
 * reading that as its name gives a function the name of the thing it is passed
 * to. Only a bound function can be called by name.
 */
export function boundName(fn, source) {
  if (fn.id?.name) return fn.id.name
  const before = source.slice(Math.max(0, fn.start - 200), fn.start)
  const declared = before.match(/(?:const|let|var|function)\s+([A-Za-z0-9_$]+)\s*(?::[^=]*)?=?\s*$/)
  if (declared) return declared[1]
  const property = before.match(/([A-Za-z0-9_$]+)\s*:\s*$/)
  return property ? property[1] : undefined
}

/** The name to print for a function. An unbound one is located by its line. */
export function functionName(fn, source) {
  return boundName(fn, source) ?? '(anonymous)'
}

/** 1-based line of a byte offset. */
export function lineOf(source, offset) {
  let line = 1
  for (let index = 0; index < offset; index++) if (source.charCodeAt(index) === 10) line++
  return line
}

/** Call `onNode` for every AST node under `node`. */
export function visitNodes(node, onNode) {
  if (node === null || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const child of node) visitNodes(child, onNode)
    return
  }
  if (typeof node.type !== 'string') return
  onNode(node)
  for (const key of Object.keys(node)) {
    if (key === 'type' || key === 'start' || key === 'end') continue
    visitNodes(node[key], onNode)
  }
}
