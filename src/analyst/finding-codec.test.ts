import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { decodeRawFindingArray, describeRejectedRows, MAX_FINDING_ROWS } from './finding-codec'

const CORPUS_DIR = join(__dirname, '../../tests/fixtures/finding-codec')

interface ParityCase {
  why: string
  input: unknown
  acceptedIndexes: number[]
  rejections: Array<{ index: number; path: string; code: string }>
}

const corpus = readdirSync(CORPUS_DIR)
  .filter((name) => name.endsWith('.json'))
  .sort()
  .map(
    (name) =>
      [name, JSON.parse(readFileSync(join(CORPUS_DIR, name), 'utf8')) as ParityCase] as const,
  )

describe('the cross-language parity corpus', () => {
  it('is not empty — a corpus that vanished would pass every parity test', () => {
    expect(corpus.length).toBeGreaterThanOrEqual(12)
  })

  it.each(corpus)('%s', (_name, testCase) => {
    const { accepted, rejected, topLevelError } = decodeRawFindingArray(testCase.input)
    expect(topLevelError).toBeUndefined()

    const rows = testCase.input as unknown[]
    expect(accepted).toEqual(testCase.acceptedIndexes.map((index) => rows[index]))
    expect(rejected.map(({ index, path, code }) => ({ index, path, code }))).toEqual(
      testCase.rejections,
    )
  })
})

describe('a value that is not a findings array', () => {
  it.each([[42], [true], [null], [undefined], [{ severity: 'high' }]])(
    'names the type it received instead of returning an empty array (%j)',
    (value: unknown) => {
      const result = decodeRawFindingArray(value)
      expect(result.topLevelError).toBeDefined()
      expect(result.accepted).toEqual([])
      expect(result.rejected).toEqual([])
    },
  )

  it('reports unparseable text rather than treating it as no findings', () => {
    const result = decodeRawFindingArray("[{'severity': 'high'}]")
    expect(result.topLevelError).toMatch(/not JSON/)
    expect(result.accepted).toEqual([])
  })
})

describe('shapes a model actually emits', () => {
  const row = {
    severity: 'high',
    claim: 'the retry loop never backs off',
    evidence: [{ uri: 'trace://t1/span/s1' }],
    confidence: 0.9,
  }

  it('accepts a JSON array carried as a string', () => {
    expect(decodeRawFindingArray(JSON.stringify([row])).accepted).toEqual([row])
  })

  it('accepts a fenced JSON array', () => {
    expect(decodeRawFindingArray(`\`\`\`json\n${JSON.stringify([row])}\n\`\`\``).accepted).toEqual([
      row,
    ])
  })

  it('unwraps { findings: [...] } but never wraps a bare object into a row', () => {
    expect(decodeRawFindingArray({ findings: [row] }).accepted).toEqual([row])
    // A single finding object is NOT silently promoted to a one-row array:
    // that widened acceptance is what let the two languages disagree.
    expect(decodeRawFindingArray(row).topLevelError).toBeDefined()
  })

  it('refuses rows past the bound instead of validating an unbounded array', () => {
    const many = Array.from({ length: MAX_FINDING_ROWS + 2 }, () => row)
    const { accepted, rejected } = decodeRawFindingArray(many)
    expect(accepted).toHaveLength(MAX_FINDING_ROWS)
    expect(rejected).toHaveLength(2)
    expect(rejected[0]?.code).toBe('row-limit')
  })
})

describe('describeRejectedRows', () => {
  it('names each refused row and field so a repair turn gets the exact defect', () => {
    const { rejected } = decodeRawFindingArray([{ claim: 'no evidence' }])
    expect(describeRejectedRows(rejected)).toMatch(/^row 0 field 'severity': /)
  })
})
