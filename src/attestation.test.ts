import { describe, expect, it } from 'vitest'
import type { AttestationProvenance, AttestedReport } from './attestation'
import { ATTESTATION_ALGORITHM, attest, verifyAttestation } from './attestation'

const provenance: AttestationProvenance = {
  modelVersions: { judge: 'kimi-k2-0905', worker: 'deepseek-v3.2' },
  seeds: [42, 1337],
  priceTableHash: 'a'.repeat(64),
  codeSha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
  inputsHash: 'b'.repeat(64),
  createdAt: '2026-06-07T12:00:00.000Z',
}

const report = {
  schema: 'example.report.v1',
  cells: [
    { scenarioId: 's-1', composite: 0.8 },
    { scenarioId: 's-2', composite: 0.6 },
  ],
  aggregates: { compositeMean: 0.7, totalCostUsd: 1.25 },
}

describe('attest', () => {
  it('binds the report content hash to provenance and algorithm', () => {
    const attested = attest(report, provenance)
    expect(attested.algorithm).toBe(ATTESTATION_ALGORITHM)
    expect(attested.reportHash).toMatch(/^[0-9a-f]{64}$/)
    expect(attested.provenance).toEqual(provenance)
  })

  it('is key-order independent over the report', () => {
    const reordered = {
      aggregates: { totalCostUsd: 1.25, compositeMean: 0.7 },
      cells: [
        { composite: 0.8, scenarioId: 's-1' },
        { composite: 0.6, scenarioId: 's-2' },
      ],
      schema: 'example.report.v1',
    }
    expect(attest(reordered, provenance).reportHash).toBe(attest(report, provenance).reportHash)
  })

  it('throws on a report that cannot be unambiguously serialized', () => {
    expect(() => attest({ broken: NaN }, provenance)).toThrow(/non-finite/)
    expect(() => attest({ broken: undefined }, provenance)).toThrow(/undefined/)
  })
})

describe('verifyAttestation', () => {
  it('round-trips: attest then verify the identical report', () => {
    const attested = attest(report, provenance)
    expect(verifyAttestation(report, attested)).toEqual({ valid: true })
  })

  it('verifies a structurally-equal report with different key order', () => {
    const attested = attest(report, provenance)
    const clone = JSON.parse(JSON.stringify(report)) as typeof report
    expect(verifyAttestation(clone, attested)).toEqual({ valid: true })
  })

  it('rejects a single-field tamper with a named reason', () => {
    const attested = attest(report, provenance)
    const tampered = {
      ...report,
      aggregates: { ...report.aggregates, compositeMean: 0.71 },
    }
    const result = verifyAttestation(tampered, attested)
    expect(result.valid).toBe(false)
    expect(result.reason).toMatch(/report hash mismatch/)
    expect(result.reason).toContain(attested.reportHash)
  })

  it('rejects a tampered nested cell value', () => {
    const attested = attest(report, provenance)
    const tampered = {
      ...report,
      cells: [report.cells[0], { scenarioId: 's-2', composite: 0.61 }],
    }
    expect(verifyAttestation(tampered, attested).valid).toBe(false)
  })

  it('rejects an unknown algorithm instead of guessing', () => {
    const attested = attest(report, provenance)
    const forged = { ...attested, algorithm: 'md5/whatever' } as unknown as AttestedReport
    const result = verifyAttestation(report, forged)
    expect(result.valid).toBe(false)
    expect(result.reason).toMatch(/unknown algorithm 'md5\/whatever'/)
  })

  it('reports a non-canonicalizable report as invalid with the cause', () => {
    const attested = attest(report, provenance)
    const result = verifyAttestation({ broken: NaN }, attested)
    expect(result.valid).toBe(false)
    expect(result.reason).toMatch(/not canonicalizable: .*non-finite/)
  })
})
