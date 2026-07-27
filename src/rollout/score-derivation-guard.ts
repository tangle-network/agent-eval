/**
 * The anti-Goodhart source guard: find every place the codebase reads a run's
 * raw split score by hand, instead of naming its intent through
 * `rollout/reward.ts`.
 *
 * WHY THIS IS AN AST WALK AND NOT A REGEX. The guard this replaces matched one
 * spelling of the derivation per LINE:
 *
 *     /holdoutScore\s*\?\?\s*.*searchScore/
 *
 * An adversarial review planted seven working re-derivations past it — a `??`
 * that biome's own formatter wraps onto two lines, a destructured `??`, a
 * `split === 'holdout' ? a : b` ternary, a dynamic `outcome[scoreField]`, an
 * if/return chain, and `||` instead of `??`. None of them is exotic; several
 * are what a careful engineer writes by default. A line-oriented pattern cannot
 * hold an invariant about an EXPRESSION, because the expression does not have
 * to fit on a line, in that order, or with those operators.
 *
 * So the rule is not "does this line look like the derivation". It is "does
 * this file READ `outcome.holdoutScore` or `outcome.searchScore` at all",
 * decided on the parsed syntax tree. Every re-derivation, in any spelling that
 * exists or will be invented, has to read one of those two fields to compute
 * anything — including the dynamic form, where the field name is spelled as a
 * string literal instead of an identifier. WRITES are untouched: constructing a
 * `RunRecord` obviously assigns the fields, and that is not a derivation.
 *
 * DEV-ONLY MODULE. It imports `oxc-parser`, a devDependency, to parse. It is
 * not a package entry point and nothing under `src/` may import it outside a
 * test, which keeps the parser out of the published bundle.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { type Node, parseSync, visitorKeys } from 'oxc-parser'

/** The two fields whose raw reads only `rollout/reward.ts` may spell. */
export const GUARDED_FIELDS: readonly string[] = ['holdoutScore', 'searchScore']

/** How the read was spelled. Reported so a failure names the bypass shape. */
export type ScoreReadKind =
  | 'property-access'
  | 'element-access'
  | 'destructure'
  | 'dynamic-field-name'

export interface ScoreReadSite {
  /** Path relative to the scanned root, with `/` separators. */
  file: string
  /** 1-based line of the read. */
  line: number
  field: string
  kind: ScoreReadKind
  /** The offending source text, trimmed to one line for the failure message. */
  text: string
}

/** `x.holdoutScore = v` and friends are writes, not derivations. */
function isAssignmentTarget(node: Node, parent: Node | undefined): boolean {
  return (
    (parent?.type === 'AssignmentExpression' && parent.left === node) ||
    (parent?.type === 'UpdateExpression' && parent.argument === node)
  )
}

/** A string literal inside a type (`'searchScore' | 'holdoutScore'`) names no value. */
function inTypePosition(ancestors: readonly Node[]): boolean {
  return ancestors.some((node) => node.type === 'TSLiteralType')
}

/** `{ holdoutScore: 1 }` / `{ 'holdoutScore': 1 }` — the key is a write target. */
function isPropertyNamePosition(node: Node, parent: Node | undefined): boolean {
  if (parent?.type === 'Property' || parent?.type === 'TSPropertySignature') {
    return parent.key === node
  }
  if (parent?.type === 'PropertyDefinition' || parent?.type === 'MethodDefinition') {
    return parent.key === node
  }
  return false
}

function fieldName(node: Node): string | undefined {
  if (node.type === 'Identifier') return node.name
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value
  return undefined
}

function lineText(source: string, node: Node): string {
  const start = source.lastIndexOf('\n', node.start - 1) + 1
  const end = source.indexOf('\n', node.start)
  return source.slice(start, end === -1 ? source.length : end).trim()
}

function lineOf(source: string, node: Node): number {
  let line = 1
  for (let index = 0; index < node.start; index += 1) {
    if (source.charCodeAt(index) === 10) line += 1
  }
  return line
}

function isNode(value: unknown): value is Node {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { type?: unknown }).type === 'string'
  )
}

/**
 * Every raw read of a guarded field in one file. Pure: takes the source text,
 * so the same rule runs over the repo and over a fixture of planted bypasses.
 */
export function findRawScoreReadsInSource(file: string, source: string): ScoreReadSite[] {
  const parsed = parseSync(file, source)
  if (parsed.errors.length > 0) {
    throw new SyntaxError(
      `Cannot inspect ${file}: ${parsed.errors.map((error) => error.message).join('; ')}`,
    )
  }
  const found: ScoreReadSite[] = []
  const push = (node: Node, field: string, kind: ScoreReadKind): void => {
    found.push({
      file,
      line: lineOf(source, node),
      field,
      kind,
      text: lineText(source, node),
    })
  }

  const ancestors: Node[] = []
  const visit = (node: Node, parent: Node | undefined): void => {
    // `record.outcome.holdoutScore`, including `record.outcome?.holdoutScore`.
    if (node.type === 'MemberExpression' && !node.computed) {
      const field = fieldName(node.property)
      if (
        field !== undefined &&
        GUARDED_FIELDS.includes(field) &&
        !isAssignmentTarget(node, parent)
      ) {
        push(node, field, 'property-access')
      }
    }
    // `record.outcome['holdoutScore']`.
    else if (
      node.type === 'MemberExpression' &&
      node.computed &&
      fieldName(node.property) !== undefined
    ) {
      const field = fieldName(node.property)
      if (
        field !== undefined &&
        GUARDED_FIELDS.includes(field) &&
        !isAssignmentTarget(node, parent)
      ) {
        push(node, field, 'element-access')
      }
    }
    // `const { holdoutScore, searchScore } = record.outcome`.
    else if (node.type === 'Property' && parent?.type === 'ObjectPattern') {
      const field = fieldName(node.key)
      if (field !== undefined && GUARDED_FIELDS.includes(field)) {
        push(node, field, 'destructure')
      }
    }
    // `const field = 'holdoutScore'` — the dynamic form's field name. Caught as
    // a bare string because that is the only place it is visible: by the time
    // it reaches `outcome[field]` the syntax says nothing about which field.
    else if (
      node.type === 'Literal' &&
      typeof node.value === 'string' &&
      GUARDED_FIELDS.includes(node.value) &&
      !inTypePosition(ancestors) &&
      !isPropertyNamePosition(node, parent) &&
      parent?.type !== 'MemberExpression'
    ) {
      push(node, node.value, 'dynamic-field-name')
    }

    ancestors.push(node)
    const keys = visitorKeys[node.type] ?? []
    const record = node as Node & Record<string, unknown>
    for (const key of keys) {
      const value = record[key]
      if (isNode(value)) {
        visit(value, node)
      } else if (Array.isArray(value)) {
        for (const child of value) {
          if (isNode(child)) visit(child, node)
        }
      }
    }
    ancestors.pop()
  }
  visit(parsed.program, undefined)
  return found
}

/** Recursively collect `.ts` sources, skipping tests and declaration files. */
export function guardedSourceFiles(root: string, includeTests = false): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir).sort()) {
      const path = join(dir, entry)
      if (statSync(path).isDirectory()) {
        walk(path)
      } else if (path.endsWith('.ts') && !path.endsWith('.d.ts')) {
        if (!includeTests && path.endsWith('.test.ts')) continue
        out.push(path)
      }
    }
  }
  walk(root)
  return out
}

/**
 * Every raw read under `root`, keyed by root-relative path.
 *
 * Test files are excluded by default: a test builds `RunRecord` fixtures and
 * asserts on their scores, which is neither a derivation nor shipped.
 */
export function findRawScoreReads(root: string, includeTests = false): ScoreReadSite[] {
  return guardedSourceFiles(root, includeTests).flatMap((path) =>
    findRawScoreReadsInSource(
      relative(root, path).split(sep).join('/'),
      readFileSync(path, 'utf8'),
    ),
  )
}

/** Reads per file, for comparison against a declared allowlist. */
export function countRawScoreReads(sites: ScoreReadSite[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const site of sites) counts[site.file] = (counts[site.file] ?? 0) + 1
  return counts
}
