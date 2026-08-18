import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  EVIDENCE_STATES,
  type EvidenceRegistryRecord,
  parseEvidenceRegistryRecord,
  renderEvidenceIndex,
  validateEvidenceRegistry,
} from './evidence-record'

const valid: EvidenceRegistryRecord = {
  id: 'sample-claim',
  date: '2026-08-15',
  claim: 'The sample instrument separates the arms.',
  domain: 'sample',
  instrument: 'paired A/B over scripted rows',
  command: 'pnpm tsx scripts/sample.ts',
  arms: ['control', 'treatment'],
  n: { value: 151, unit: 'rows', detail: '22 clusters' },
  result: '+0.0596, 95% CI [-0.0061, +0.1210]',
  evidenceState: 'MEASURED-ONCE',
  artifacts: ['~/bench-cache/sample/'],
  costUsd: 9.64,
  confounds: ['CI crosses zero'],
  sourceRepo: 'agent-eval',
}

describe('evidenceRegistryRecordSchema', () => {
  it('accepts a complete record', () => {
    expect(parseEvidenceRegistryRecord(valid)).toEqual(valid)
  })

  it('accepts null command and null cost as named gaps', () => {
    const record = parseEvidenceRegistryRecord({ ...valid, command: null, costUsd: null })
    expect(record.command).toBeNull()
    expect(record.costUsd).toBeNull()
  })

  it('rejects an unknown evidence state', () => {
    expect(() =>
      parseEvidenceRegistryRecord({ ...valid, evidenceState: 'PROBABLY-FINE' }),
    ).toThrow()
  })

  it('rejects empty artifacts — a claim with no artifact is prose', () => {
    expect(() => parseEvidenceRegistryRecord({ ...valid, artifacts: [] })).toThrow()
  })

  it('rejects unknown keys, a non-kebab id, and a malformed date', () => {
    expect(() => parseEvidenceRegistryRecord({ ...valid, vibe: 'good' })).toThrow()
    expect(() => parseEvidenceRegistryRecord({ ...valid, id: 'Sample_Claim' })).toThrow()
    expect(() => parseEvidenceRegistryRecord({ ...valid, date: '08/15/2026' })).toThrow()
  })

  it('rejects a negative cost', () => {
    expect(() => parseEvidenceRegistryRecord({ ...valid, costUsd: -1 })).toThrow()
  })
})

describe('validateEvidenceRegistry', () => {
  it('rejects duplicate ids', () => {
    expect(() => validateEvidenceRegistry([valid, valid])).toThrow(/duplicate/)
  })

  it('rejects supersedes pointing at an unknown record', () => {
    expect(() => validateEvidenceRegistry([{ ...valid, supersedes: ['never-recorded'] }])).toThrow(
      /unknown record/,
    )
  })

  it('sorts by trust ladder, then date desc, then id', () => {
    const certified = { ...valid, id: 'a-certified', evidenceState: 'CERTIFIED' as const }
    const newerNull = {
      ...valid,
      id: 'b-null',
      date: '2026-08-16',
      evidenceState: 'RESOLVED-NULL' as const,
    }
    const sorted = validateEvidenceRegistry([newerNull, valid, certified])
    expect(sorted.map((r) => r.id)).toEqual(['a-certified', 'sample-claim', 'b-null'])
  })
})

describe('renderEvidenceIndex', () => {
  it('is deterministic and carries every load-bearing field', () => {
    const first = renderEvidenceIndex([valid])
    expect(renderEvidenceIndex([valid])).toBe(first)
    for (const needle of [
      valid.claim,
      valid.result,
      valid.instrument,
      '151 rows (22 clusters)',
      '$9.64',
      'CI crosses zero',
      'MEASURED-ONCE',
    ]) {
      expect(first).toContain(needle)
    }
  })

  it('labels the named gaps instead of dropping them', () => {
    const rendered = renderEvidenceIndex([{ ...valid, command: null, costUsd: null }])
    expect(rendered).toContain('not preserved')
    expect(rendered).toContain('not captured')
  })
})

describe('committed registry', () => {
  const recordsDir = resolve(__dirname, '../../evidence/records')
  const files = readdirSync(recordsDir)
    .filter((name) => name.endsWith('.json'))
    .sort()

  it('holds at least the initial migration', () => {
    expect(files.length).toBeGreaterThanOrEqual(7)
  })

  it('every committed record parses, ids match filenames, registry validates', () => {
    const raws = files.map((name) => {
      const parsed = JSON.parse(readFileSync(resolve(recordsDir, name), 'utf8'))
      expect(parsed.id).toBe(name.replace(/\.json$/, ''))
      return parsed
    })
    const records = validateEvidenceRegistry(raws)
    expect(records).toHaveLength(files.length)
    for (const state of records.map((r) => r.evidenceState)) {
      expect(EVIDENCE_STATES).toContain(state)
    }
  })

  it('the committed index matches the records byte for byte', () => {
    const raws = files.map((name) => JSON.parse(readFileSync(resolve(recordsDir, name), 'utf8')))
    const committed = readFileSync(resolve(recordsDir, '../INDEX.md'), 'utf8')
    expect(committed).toBe(renderEvidenceIndex(raws))
  })
})
