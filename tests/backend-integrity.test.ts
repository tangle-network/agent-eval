import { describe, expect, it } from 'vitest'
import type { CostReceipt } from '../src/cost-ledger'
import {
  assertRealAgentReceipts,
  assertRealBackend,
  BackendIntegrityError,
  summarizeAgentReceiptIntegrity,
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

function makeReceipt(
  channel: CostReceipt['channel'],
  inputTokens: number,
  outputTokens: number,
  costUsd: number,
): CostReceipt {
  return {
    callId: `${channel}-${inputTokens}-${outputTokens}-${costUsd}`,
    channel,
    phase: 'test',
    actor: 'backend-integrity-test',
    model: 'test-model@2026-01',
    timestamp: 0,
    status: 'settled',
    inputTokens,
    outputTokens,
    costUsd,
    costUnknown: false,
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

  describe('agent cost receipts', () => {
    it('derives real backend usage from agent receipts only', () => {
      const report = summarizeAgentReceiptIntegrity([
        makeReceipt('agent', 500, 1_000, 0.01),
        makeReceipt('agent', 600, 1_200, 0.012),
        makeReceipt('judge', 9_999, 9_999, 1),
      ])

      expect(report).toMatchObject({
        verdict: 'real',
        totalRecords: 2,
        totalInputTokens: 1_100,
        totalOutputTokens: 2_200,
        totalCostUsd: 0.022,
      })
    })

    it('rejects mixed agent receipts when every call must be real', () => {
      expect(() =>
        assertRealAgentReceipts(
          [makeReceipt('agent', 500, 1_000, 0.01), makeReceipt('agent', 0, 0, 0)],
          { allowMixed: false },
        ),
      ).toThrow(BackendIntegrityError)
    })

    it('rejects ledgers that contain no agent execution', () => {
      expect(() => assertRealAgentReceipts([makeReceipt('judge', 500, 1_000, 0.01)])).toThrow(
        BackendIntegrityError,
      )
    })
  })
})
