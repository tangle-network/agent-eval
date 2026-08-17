import { describe, expect, it } from 'vitest'
import {
  createEvidenceReceipt,
  isIndependentEvidence,
  verifyEvidenceReceipt,
} from './evidence-receipt'

const provenance = {
  modelVersions: { evaluator: 'checker@abc' },
  codeSha: 'abc123',
  inputsHash: 'sha256:inputs',
  createdAt: '2026-08-17T00:00:00.000Z',
}

const binding = {
  pursuitId: 'pursuit:alpha',
  runId: 'run:7',
  candidateDigest: 'sha256:candidate',
  evaluatorDigest: 'sha256:evaluator',
  environmentDigest: 'sha256:environment',
  inputSetCommitment: 'sha256:hidden-cases',
  outputDigest: 'sha256:output',
  resultDigest: 'sha256:result',
  authority: { kind: 'independent-evaluator' as const, id: 'eval-service:v1' },
  experimentDigest: 'sha256:experiment',
  observerDigest: 'sha256:observer-tip',
}

describe('evidence receipts', () => {
  it('binds pursuit, execution, candidate, environment, hidden inputs, and result', () => {
    const receipt = createEvidenceReceipt(binding, provenance)
    expect(verifyEvidenceReceipt(receipt)).toEqual({ valid: true })
    expect(receipt.binding.pursuitId).toBe('pursuit:alpha')
    expect(isIndependentEvidence(receipt)).toBe(true)
  })

  it('detects any mutation of the bound evaluation identity', () => {
    const receipt = createEvidenceReceipt(binding, provenance)
    const tampered = {
      ...receipt,
      binding: { ...receipt.binding, candidateDigest: 'sha256:different-candidate' },
    }
    expect(verifyEvidenceReceipt(tampered).valid).toBe(false)
  })

  it('keeps candidate self-reports distinct from independent evidence', () => {
    const receipt = createEvidenceReceipt(
      {
        ...binding,
        authority: { kind: 'candidate-self-report', id: 'candidate:alpha' },
      },
      provenance,
    )
    expect(isIndependentEvidence(receipt)).toBe(false)
  })

  it('refuses missing identity instead of encoding unknown as empty', () => {
    expect(() => createEvidenceReceipt({ ...binding, pursuitId: '   ' }, provenance)).toThrow(
      /pursuitId must be non-empty/,
    )
  })
})
