import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { checkCanonicalJson } from './check-canonical-json.mjs'

const tempRoots = []

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { force: true, recursive: true })
})

/** Build a throwaway repo containing only `src` files. */
function run(files, allowlist = []) {
  const root = mkdtempSync(join(tmpdir(), 'canonical-json-gate-'))
  tempRoots.push(root)
  for (const [name, content] of Object.entries(files)) {
    const path = join(root, 'src', name)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, content)
  }
  return checkCanonicalJson({ root, allowlist })
}

/**
 * An arrow passed as an argument sits behind the text `helper(`, so naming it
 * from what precedes it gives it the name of the function it is passed to. That
 * fabricated name used to enter the module's sorter set, and every caller of the
 * REAL function of that name then read as sorting — which is how the gate came
 * to report `runBenchmarkAdapter()` at a line whose function contains no sort
 * at all, and `runReplayBatch()` at one containing neither `Object.keys` nor
 * `.sort(`. A gate that names the wrong function teaches the next reader that
 * it lies.
 */
describe('function attribution', () => {
  // The arrow is the FIRST argument, so the text immediately in front of it is
  // `sumOver(` — which is what the old fallback read as its name.
  const moduleWithArrowArgument = [
    'function sumOver(pick: () => number, times: number): number {',
    '  let total = 0',
    '  for (let i = 0; i < times; i++) total += pick()',
    '  return total',
    '}',
    '',
    'export function report(row: Record<string, unknown>): string {',
    '  const width = sumOver(() => Object.keys(row).sort().map((k) => k).length, 2)',
    '  return JSON.stringify({ width })',
    '}',
    '',
    'export function summary(count: number): string {',
    '  return JSON.stringify({ n: sumOver(() => 1, count) })',
    '}',
  ].join('\n')

  test('does not report a function whose only sin is calling a same-named helper', () => {
    const { offences } = run({ 'batch.ts': moduleWithArrowArgument })

    expect(offences.map((o) => o.fn)).not.toContain('summary')
  })

  test('still registers a real module-local sorting helper by its binding', () => {
    const { offences } = run({
      'digest.ts': [
        'const sortKeys = (value: Record<string, unknown>): string[] => Object.keys(value).sort().map((k) => k)',
        '',
        'export function contentHash(value: Record<string, unknown>): string {',
        '  return JSON.stringify(sortKeys(value))',
        '}',
      ].join('\n'),
    })

    expect(offences.map((o) => o.fn)).toContain('contentHash')
  })
})

describe('a hand-rolled canonical-JSON encoder', () => {
  test('is reported with its file, line, and function name', () => {
    const { offences } = run({
      'cache.ts': [
        'export function contentHash(value: Record<string, unknown>): string {',
        '  const keys = Object.keys(value).sort()',
        '  const parts = keys.map((k) => `${JSON.stringify(k)}:${String(value[k])}`)',
        '  return JSON.stringify(`{${parts.join(",")}}`)',
        '}',
      ].join('\n'),
    })

    expect(offences).toEqual([{ file: 'src/cache.ts', line: 1, fn: 'contentHash' }])
  })

  test('is reported when the sort is split into a module-local helper', () => {
    const { offences } = run({
      'digest.ts': [
        'function sortKeysDeep(value: unknown): unknown {',
        '  const out: Record<string, unknown> = {}',
        '  for (const key of Object.keys(value as Record<string, unknown>).sort()) {',
        '    out[key] = (value as Record<string, unknown>)[key]',
        '  }',
        '  return out',
        '}',
        'export function digest(value: unknown): string {',
        '  return JSON.stringify(sortKeysDeep(value))',
        '}',
      ].join('\n'),
    })

    expect(offences).toHaveLength(1)
    expect(offences[0]).toMatchObject({ file: 'src/digest.ts', fn: 'digest' })
  })

  test('is reported when it hashes the sorted encoding instead of returning it', () => {
    const { offences } = run({
      'receipt.ts': [
        'export function receiptDigest(value: Record<string, unknown>): string {',
        '  let body = ""',
        '  for (const key of Object.keys(value).sort()) body += `${key}${String(value[key])}`',
        '  return createHash("sha256").update(body).digest("hex")',
        '}',
      ].join('\n'),
    })

    expect(offences).toHaveLength(1)
    expect(offences[0]).toMatchObject({ fn: 'receiptDigest' })
  })
})

describe('code that sorts keys without encoding', () => {
  test('a key-SET check compared against an expected list is not an encoder', () => {
    const { offences } = run({
      'validate.ts': [
        'export function assertExactKeys(value: Record<string, unknown>, expected: string[]) {',
        '  const actual = Object.keys(value).sort()',
        '  if (actual.some((key, index) => key !== expected[index])) {',
        '    throw new Error(`unexpected fields: ${JSON.stringify(value)}`)',
        '  }',
        '}',
      ].join('\n'),
    })

    expect(offences).toEqual([])
  })

  test('a key-set joined into one string for comparison is not an encoder', () => {
    const { offences } = run({
      'state.ts': [
        'export function assertShape(value: Record<string, unknown>) {',
        '  if (Object.keys(value).sort().join(",") !== "accepted,max") {',
        '    throw new Error(`bad state: ${JSON.stringify(value)}`)',
        '  }',
        '}',
      ].join('\n'),
    })

    expect(offences).toEqual([])
  })

  test('the canonical home itself is never reported', () => {
    const { offences } = run({
      'ledger-core/canonical.ts': [
        'export function canonicalString(value: Record<string, unknown>): string {',
        '  const parts = Object.keys(value).sort().map((k) => JSON.stringify(k))',
        '  return JSON.stringify(parts.join(","))',
        '}',
      ].join('\n'),
    })

    expect(offences).toEqual([])
  })

  test('a test file is not a shipped encoder', () => {
    const { offences } = run({
      'cache.test.ts': [
        'function legacyEncode(value: Record<string, unknown>): string {',
        '  return JSON.stringify(Object.keys(value).sort().map((k) => value[k]))',
        '}',
      ].join('\n'),
    })

    expect(offences).toEqual([])
  })
})

describe('the allowlist', () => {
  const legacy = {
    'verify.ts': [
      'export function verifyLegacy(value: Record<string, unknown>): string {',
      '  const parts = Object.keys(value).sort().map((k) => `${k}${String(value[k])}`)',
      '  return JSON.stringify(parts.join(","))',
      '}',
    ].join('\n'),
  }

  test('waives exactly the named function in the named file', () => {
    const { offences, unusedWaivers } = run(legacy, [
      { file: 'src/verify.ts', fn: 'verifyLegacy', reason: 'verifies retired bytes; never writes' },
    ])

    expect(offences).toEqual([])
    expect(unusedWaivers).toEqual([])
  })

  test('reports a waiver that matches nothing, so a stale entry cannot hide a new copy', () => {
    const { offences, unusedWaivers } = run(legacy, [
      { file: 'src/verify.ts', fn: 'renamedAway', reason: 'stale entry' },
    ])

    expect(offences).toHaveLength(1)
    expect(unusedWaivers).toHaveLength(1)
  })
})

describe('the shipped repository', () => {
  test('passes its own gate', () => {
    const { offences, unusedWaivers } = checkCanonicalJson()
    expect({ offences, unusedWaivers }).toEqual({ offences: [], unusedWaivers: [] })
  })
})
