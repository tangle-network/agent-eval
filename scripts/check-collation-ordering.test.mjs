import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { checkCollationOrdering } from './check-collation-ordering.mjs'

const tempRoots = []

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { force: true, recursive: true })
})

function run(files, allowlist = []) {
  const root = mkdtempSync(join(tmpdir(), 'collation-gate-'))
  tempRoots.push(root)
  for (const [name, content] of Object.entries(files)) {
    const path = join(root, 'src', name)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, content)
  }
  return checkCollationOrdering({ root, allowlist })
}

describe('an ordering that reaches a digest', () => {
  test('is reported with its file, line, and function name', () => {
    const { offences } = run({
      'digest.ts': [
        'export function suiteDigest(files: { path: string }[]): string {',
        '  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path))',
        '  return hashCanonical(sorted)',
        '}',
      ].join('\n'),
    })

    expect(offences).toEqual([{ file: 'src/digest.ts', line: 2, fn: 'suiteDigest' }])
  })

  test('is reported when the digest comes from createHash rather than the canonical helper', () => {
    const { offences } = run({
      'suite.ts': [
        'export function fold(files: { path: string }[]): string {',
        '  const hash = createHash("sha256")',
        '  for (const f of [...files].sort((a, b) => a.path.localeCompare(b.path))) hash.update(f.path)',
        '  return hash.digest("hex")',
        '}',
      ].join('\n'),
    })

    expect(offences.map((o) => o.fn)).toEqual(['fold'])
  })

  test('is not reported once the comparator orders by code unit', () => {
    const { offences } = run({
      'digest.ts': [
        'export function suiteDigest(files: { path: string }[]): string {',
        '  const sorted = [...files].sort((a, b) => compareCodeUnits(a.path, b.path))',
        '  return hashCanonical(sorted)',
        '}',
      ].join('\n'),
    })

    expect(offences).toEqual([])
  })
})

/**
 * The predicate keys on "canonicalizes AND orders by collation", not on "sorts
 * and serializes somewhere in the same body". A report a human reads is free to
 * order by collation, and this is the distinction a broader predicate could not
 * make.
 */
describe('an ordering that reaches a report', () => {
  test('is not reported when the function never canonicalizes', () => {
    const { offences } = run({
      'render.ts': [
        'export function renderTable(rows: Record<string, number>): string {',
        '  return Object.entries(rows)',
        '    .sort(([a], [b]) => a.localeCompare(b))',
        '    .map(([k, v]) => `| ${k} | ${v} |`)',
        '    .join("\\n")',
        '}',
      ].join('\n'),
    })

    expect(offences).toEqual([])
  })
})

describe('the allowlist', () => {
  test('fails the gate when an entry matches nothing, so a stale waiver cannot hide a new one', () => {
    const { unusedWaivers } = run({ 'clean.ts': 'export const x = 1\n' }, [
      { file: 'src/gone.ts', fn: 'removed', reason: 'stale' },
    ])

    expect(unusedWaivers).toHaveLength(1)
  })
})

describe('the shipped repository', () => {
  test('passes its own gate', () => {
    expect(checkCollationOrdering()).toEqual({ offences: [], unusedWaivers: [] })
  })
})
