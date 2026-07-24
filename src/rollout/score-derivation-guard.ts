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
 * DEV-ONLY MODULE. It imports `typescript`, a devDependency, to parse. It is
 * not a package entry point and nothing under `src/` may import it outside a
 * test — doing so would put the compiler in the published bundle.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import ts from 'typescript'

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

const ASSIGNMENT_OPERATORS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.EqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken,
  ts.SyntaxKind.BarBarEqualsToken,
  ts.SyntaxKind.AmpersandAmpersandEqualsToken,
  ts.SyntaxKind.PlusEqualsToken,
  ts.SyntaxKind.MinusEqualsToken,
  ts.SyntaxKind.AsteriskEqualsToken,
  ts.SyntaxKind.SlashEqualsToken,
])

/** `x.holdoutScore = v` and friends are writes, not derivations. */
function isAssignmentTarget(node: ts.Node): boolean {
  const parent = node.parent
  if (parent === undefined) return false
  if (ts.isBinaryExpression(parent) && parent.left === node) {
    return ASSIGNMENT_OPERATORS.has(parent.operatorToken.kind)
  }
  return false
}

/** A string literal inside a type (`'searchScore' | 'holdoutScore'`) names no value. */
function inTypePosition(node: ts.Node): boolean {
  for (let cur: ts.Node | undefined = node.parent; cur !== undefined; cur = cur.parent) {
    if (ts.isTypeNode(cur)) return true
  }
  return false
}

/** `{ holdoutScore: 1 }` / `{ 'holdoutScore': 1 }` — the key is a write target. */
function isPropertyNamePosition(node: ts.Node): boolean {
  const parent = node.parent
  if (parent === undefined) return false
  if (ts.isPropertyAssignment(parent) && parent.name === node) return true
  if (ts.isPropertySignature(parent) && parent.name === node) return true
  return false
}

function lineText(source: ts.SourceFile, node: ts.Node): string {
  const { line } = source.getLineAndCharacterOfPosition(node.getStart(source))
  const lines = source.getFullText().split('\n')
  return (lines[line] ?? '').trim()
}

function lineOf(source: ts.SourceFile, node: ts.Node): number {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
}

/**
 * Every raw read of a guarded field in one file. Pure: takes the source text,
 * so the same rule runs over the repo and over a fixture of planted bypasses.
 */
export function findRawScoreReadsInSource(file: string, source: string): ScoreReadSite[] {
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.TS,
  )
  const found: ScoreReadSite[] = []
  const push = (node: ts.Node, field: string, kind: ScoreReadKind): void => {
    found.push({
      file,
      line: lineOf(sourceFile, node),
      field,
      kind,
      text: lineText(sourceFile, node),
    })
  }

  const visit = (node: ts.Node): void => {
    // `record.outcome.holdoutScore`, including `record.outcome?.holdoutScore`.
    if (ts.isPropertyAccessExpression(node) && GUARDED_FIELDS.includes(node.name.text)) {
      if (!isAssignmentTarget(node)) push(node, node.name.text, 'property-access')
    }
    // `record.outcome['holdoutScore']`.
    else if (
      ts.isElementAccessExpression(node) &&
      ts.isStringLiteralLike(node.argumentExpression) &&
      GUARDED_FIELDS.includes(node.argumentExpression.text)
    ) {
      if (!isAssignmentTarget(node)) {
        push(node, node.argumentExpression.text, 'element-access')
      }
    }
    // `const { holdoutScore, searchScore } = record.outcome`.
    else if (ts.isBindingElement(node)) {
      const name = node.propertyName ?? node.name
      const text = ts.isIdentifier(name) || ts.isStringLiteralLike(name) ? name.text : undefined
      if (text !== undefined && GUARDED_FIELDS.includes(text)) push(node, text, 'destructure')
    }
    // `const field = 'holdoutScore'` — the dynamic form's field name. Caught as
    // a bare string because that is the only place it is visible: by the time
    // it reaches `outcome[field]` the syntax says nothing about which field.
    else if (
      ts.isStringLiteralLike(node) &&
      GUARDED_FIELDS.includes(node.text) &&
      !inTypePosition(node) &&
      !isPropertyNamePosition(node) &&
      !(node.parent !== undefined && ts.isElementAccessExpression(node.parent))
    ) {
      push(node, node.text, 'dynamic-field-name')
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
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
