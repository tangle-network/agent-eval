import { describe, expect, it } from 'vitest'
import {
  assertRealBackend,
  BackendIntegrityError,
  summarizeBackendIntegrity,
} from '../src/integrity/backend-integrity'
import type { RunRecord } from '../src/run-record'

function makeRecord(input: number, output: number, costUsd: number): RunRecord {
  return {
    runId: `r-${Math.random()}`,
    experimentId: 'exp',
    candidateId: 'cand',
    seed: 0,
    model: 'test-model@2026-01',
    promptHash: 'a'.repeat(64),
    configHash: 'b'.repeat(64),
    commitSha: 'c'.repeat(40),
    wallMs: 100,
    costUsd,
    tokenUsage: { input, output },
    outcome: { holdoutScore: 0.5, raw: {} },
    splitTag: 'holdout',
    scenarioId: 'scn',
  }
}

describe('backend-integrity', () => {
  describe('summarizeBackendIntegrity', () => {
    it('classifies all-zero token usage as stub', () => {
      const r = summarizeBackendIntegrity([
        makeRecord(0, 0, 0),
        makeRecord(0, 0, 0),
        makeRecord(0, 0, 0),
      ])
      expect(r.verdict).toBe('stub')
      expect(r.stubRecords).toBe(3)
      expect(r.realRecords).toBe(0)
      expect(r.diagnosis).toContain('LLM backend was never called')
    })

    it('classifies any real activity as real', () => {
      const r = summarizeBackendIntegrity([
        makeRecord(500, 1000, 0.01),
        makeRecord(600, 1200, 0.012),
      ])
      expect(r.verdict).toBe('real')
      expect(r.realRecords).toBe(2)
      expect(r.stubRecords).toBe(0)
      expect(r.totalInputTokens).toBe(1100)
      expect(r.totalOutputTokens).toBe(2200)
    })

    it('classifies partial stub-mode as mixed', () => {
      const r = summarizeBackendIntegrity([
        makeRecord(500, 1000, 0.01),
        makeRecord(0, 0, 0),
        makeRecord(0, 0, 0),
      ])
      expect(r.verdict).toBe('mixed')
      expect(r.stubRecords).toBe(2)
      expect(r.realRecords).toBe(1)
      expect(r.diagnosis).toContain('2/3 records (67%) have zero')
    })

    it('flags output-tokens-without-cost as uncosted, naming both roots', () => {
      const r = summarizeBackendIntegrity([makeRecord(500, 1000, 0), makeRecord(500, 1000, 0)])
      expect(r.verdict).toBe('real')
      expect(r.uncostedRecords).toBe(2)
      // Two distinct roots, not one: mis-wired ledger OR unpriced-at-source model.
      expect(r.diagnosis).toContain('cost ledger mis-wired')
      expect(r.diagnosis).toContain('unpriced at the source')
      expect(r.diagnosis).toContain('estimateCost')
    })

    it('handles empty input', () => {
      const r = summarizeBackendIntegrity([])
      expect(r.verdict).toBe('stub')
      expect(r.totalRecords).toBe(0)
      expect(r.diagnosis).toContain('no records')
    })

    it('does not count input=0+output>0 as stub (partial usage propagation)', () => {
      const r = summarizeBackendIntegrity([makeRecord(0, 1000, 0)])
      expect(r.verdict).toBe('real')
      expect(r.stubRecords).toBe(0)
      expect(r.uncostedRecords).toBe(1)
    })
  })

  describe('assertRealBackend', () => {
    it('throws on pure-stub verdict', () => {
      expect(() => assertRealBackend([makeRecord(0, 0, 0)])).toThrow(BackendIntegrityError)
    })

    it('throws on empty input', () => {
      expect(() => assertRealBackend([])).toThrow(BackendIntegrityError)
    })

    it('passes through on real verdict', () => {
      const r = assertRealBackend([makeRecord(500, 1000, 0.01)])
      expect(r.verdict).toBe('real')
    })

    it('allows mixed by default', () => {
      const r = assertRealBackend([makeRecord(500, 1000, 0.01), makeRecord(0, 0, 0)])
      expect(r.verdict).toBe('mixed')
    })

    it('rejects mixed when allowMixed=false', () => {
      expect(() =>
        assertRealBackend([makeRecord(500, 1000, 0.01), makeRecord(0, 0, 0)], {
          allowMixed: false,
        }),
      ).toThrow(BackendIntegrityError)
    })

    it('thrown error carries the report and the right code', () => {
      try {
        assertRealBackend([makeRecord(0, 0, 0), makeRecord(0, 0, 0)])
        expect.fail('should have thrown')
      } catch (e) {
        expect(e).toBeInstanceOf(BackendIntegrityError)
        if (e instanceof BackendIntegrityError) {
          expect(e.code).toBe('backend_integrity')
          expect(e.report.verdict).toBe('stub')
          expect(e.report.totalRecords).toBe(2)
        }
      }
    })
  })
})
