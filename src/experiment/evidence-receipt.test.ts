import { describe, expect, it } from 'vitest'
import {
  createEvidenceReceipt,
  type EvidenceReceipt,
  isIndependentEvidence,
  verifyEvidenceReceipt,
} from './evidence-receipt'

const provenance = {
  modelVersions: { evaluator: 'checker@abc' },
  codeSha: 'abc123',
  inputsHash: 'sha256:hidden-cases',
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

  it('detects provenance mutation', () => {
    const receipt = createEvidenceReceipt(binding, provenance)
    const tampered = {
      ...receipt,
      attestation: {
        ...receipt.attestation,
        provenance: { ...receipt.attestation.provenance, codeSha: 'forged-code' },
      },
    }
    expect(verifyEvidenceReceipt(tampered)).toMatchObject({ valid: false })
  })

  it('requires provenance to name the same hidden input commitment as the binding', () => {
    expect(() =>
      createEvidenceReceipt(binding, {
        ...provenance,
        inputsHash: 'sha256:different-inputs',
      }),
    ).toThrow(/inputsHash must equal binding.inputSetCommitment/)
  })

  it('refuses legacy report attestations whose provenance was never envelope-bound', () => {
    const receipt = createEvidenceReceipt(binding, provenance)
    const { envelopeHash: _envelopeHash, ...legacy } = receipt.attestation
    expect(verifyEvidenceReceipt({ ...receipt, attestation: legacy })).toEqual({
      valid: false,
      reason: 'evidence receipt provenance is not bound by an attestation envelope',
    })
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

  it('fails closed on unknown authority kinds instead of treating typos as independent', () => {
    const receipt = createEvidenceReceipt(binding, provenance)
    const forged = {
      ...receipt,
      binding: {
        ...receipt.binding,
        authority: { kind: 'independent-evaluatr', id: 'forged' },
      },
    } as unknown as EvidenceReceipt

    expect(isIndependentEvidence(forged)).toBe(false)
    expect(verifyEvidenceReceipt(forged)).toMatchObject({
      valid: false,
      reason: expect.stringMatching(/unknown authority kind/),
    })
  })

  it('refuses missing identity instead of encoding unknown as empty', () => {
    expect(() => createEvidenceReceipt({ ...binding, pursuitId: '   ' }, provenance)).toThrow(
      /pursuitId must be non-empty/,
    )
  })
})
