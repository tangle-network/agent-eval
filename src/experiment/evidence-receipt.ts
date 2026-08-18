/**
 * Evidence receipts are the join between Runtime execution and Eval promotion.
 *
 * Runtime says what actually ran. Eval says what independently measured it.
 * This receipt binds those worlds without making either package import the other:
 * stable pursuit/run identity, exact candidate/evaluator/environment/input/output
 * content identities, and the authority class that produced the observation.
 *
 * The payload is attested with agent-eval's existing canonical report attestation.
 * Signing/key management deliberately remains outside this substrate; consumers may
 * sign the byte-stable receipt or anchor its attestation in a transparency log.
 */

import {
  type AttestationProvenance,
  type AttestedReport,
  attest,
  verifyAttestation,
} from '../attestation'

export const EVIDENCE_RECEIPT_VERSION = '1.0.0' as const

/** Closed promotion vocabulary. A typo or unknown future kind is never independent by default. */
export const EVIDENCE_AUTHORITY_KINDS = [
  'candidate-self-report',
  'independent-evaluator',
  'independent-replication',
  'human-review',
  'production-canary',
] as const

export type EvidenceAuthorityKind = (typeof EVIDENCE_AUTHORITY_KINDS)[number]

export const INDEPENDENT_EVIDENCE_AUTHORITY_KINDS = [
  'independent-evaluator',
  'independent-replication',
  'human-review',
  'production-canary',
] as const satisfies readonly EvidenceAuthorityKind[]

export interface EvidenceAuthority {
  readonly kind: EvidenceAuthorityKind
  /** Stable authority/service/person identifier; never inferred from model prose. */
  readonly id: string
}

export interface EvidenceBinding {
  readonly schemaVersion: typeof EVIDENCE_RECEIPT_VERSION
  /** Stable objective identity spanning retries, forks, resumes, and multiple runs. */
  readonly pursuitId: string
  /** Concrete execution/evaluation run this evidence was produced from. */
  readonly runId: string
  /** Exact candidate/program/profile bundle under evaluation. */
  readonly candidateDigest: string
  /** Exact evaluator/checker program or registered experiment definition. */
  readonly evaluatorDigest: string
  /** Exact sandbox/container/dependency/environment identity. */
  readonly environmentDigest: string
  /** Commitment to the input set. The hidden inputs themselves need not be exposed. */
  readonly inputSetCommitment: string
  /** Content identity of the raw evaluated output/artifact set. */
  readonly outputDigest: string
  /** Content identity of the evaluation result/report/verdict body. */
  readonly resultDigest: string
  readonly authority: EvidenceAuthority
  /** Optional experiment seal that governed the evaluation. */
  readonly experimentDigest?: string
  /** Optional observer-journal chain tip covering the execution being evaluated. */
  readonly observerDigest?: string
}

export interface EvidenceReceipt {
  readonly binding: EvidenceBinding
  readonly attestation: AttestedReport
}

export interface EvidenceReceiptVerification {
  readonly valid: boolean
  readonly reason?: string
}

export interface CreateEvidenceReceiptInput extends Omit<EvidenceBinding, 'schemaVersion'> {}

/**
 * Mint a content-attested evidence receipt. Required identity fields are deliberately
 * non-optional: unknown evidence stays unknown and cannot accidentally look certified.
 * The attestation's input provenance must equal the receipt commitment so two competing
 * descriptions of the evaluated population cannot coexist inside one valid receipt.
 */
export function createEvidenceReceipt(
  input: CreateEvidenceReceiptInput,
  provenance: AttestationProvenance,
): EvidenceReceipt {
  const inputSetCommitment = requiredIdentity(input.inputSetCommitment, 'inputSetCommitment')
  assertInputCommitment(provenance, inputSetCommitment)
  const binding: EvidenceBinding = Object.freeze({
    schemaVersion: EVIDENCE_RECEIPT_VERSION,
    pursuitId: requiredIdentity(input.pursuitId, 'pursuitId'),
    runId: requiredIdentity(input.runId, 'runId'),
    candidateDigest: requiredIdentity(input.candidateDigest, 'candidateDigest'),
    evaluatorDigest: requiredIdentity(input.evaluatorDigest, 'evaluatorDigest'),
    environmentDigest: requiredIdentity(input.environmentDigest, 'environmentDigest'),
    inputSetCommitment,
    outputDigest: requiredIdentity(input.outputDigest, 'outputDigest'),
    resultDigest: requiredIdentity(input.resultDigest, 'resultDigest'),
    authority: requiredAuthority(input.authority),
    ...(input.experimentDigest === undefined
      ? {}
      : { experimentDigest: requiredIdentity(input.experimentDigest, 'experimentDigest') }),
    ...(input.observerDigest === undefined
      ? {}
      : { observerDigest: requiredIdentity(input.observerDigest, 'observerDigest') }),
  })
  return Object.freeze({ binding, attestation: attest(binding, provenance) })
}

/**
 * Verify promotion-grade evidence. Generic report attestation keeps a legacy read path,
 * but an EvidenceReceipt never accepts unbound provenance: changing the evaluator code,
 * model versions, input commitment provenance, or creation record must invalidate the
 * evidence rather than merely annotating it as legacy.
 */
export function verifyEvidenceReceipt(receipt: EvidenceReceipt): EvidenceReceiptVerification {
  if (receipt.binding.schemaVersion !== EVIDENCE_RECEIPT_VERSION) {
    return {
      valid: false,
      reason: `unsupported evidence receipt version '${receipt.binding.schemaVersion}'`,
    }
  }
  try {
    for (const [field, value] of Object.entries({
      pursuitId: receipt.binding.pursuitId,
      runId: receipt.binding.runId,
      candidateDigest: receipt.binding.candidateDigest,
      evaluatorDigest: receipt.binding.evaluatorDigest,
      environmentDigest: receipt.binding.environmentDigest,
      inputSetCommitment: receipt.binding.inputSetCommitment,
      outputDigest: receipt.binding.outputDigest,
      resultDigest: receipt.binding.resultDigest,
    })) {
      requiredIdentity(value, field)
    }
    requiredAuthority(receipt.binding.authority)
    assertInputCommitment(receipt.attestation.provenance, receipt.binding.inputSetCommitment)
  } catch (error) {
    return { valid: false, reason: error instanceof Error ? error.message : String(error) }
  }

  const verification = verifyAttestation(receipt.binding, receipt.attestation)
  if (!verification.valid) return verification
  if (
    verification.legacyUnboundProvenance === true ||
    receipt.attestation.envelopeHash === undefined
  ) {
    return {
      valid: false,
      reason: 'evidence receipt provenance is not bound by an attestation envelope',
    }
  }
  return { valid: true }
}

/**
 * Promotion may choose a stricter policy, but this primitive makes the basic separation
 * explicit: only a recognized independent authority is independent. Unknown/forged kinds
 * and candidate self-reports both return false.
 */
export function isIndependentEvidence(receipt: EvidenceReceipt): boolean {
  return (INDEPENDENT_EVIDENCE_AUTHORITY_KINDS as readonly string[]).includes(
    receipt.binding.authority?.kind,
  )
}

function requiredAuthority(value: unknown): EvidenceAuthority {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('evidence receipt: authority must be an object')
  }
  const authority = value as { kind?: unknown; id?: unknown }
  if (
    typeof authority.kind !== 'string' ||
    !(EVIDENCE_AUTHORITY_KINDS as readonly string[]).includes(authority.kind)
  ) {
    throw new TypeError(`evidence receipt: unknown authority kind '${String(authority.kind)}'`)
  }
  if (typeof authority.id !== 'string') {
    throw new TypeError('evidence receipt: authority.id must be a string')
  }
  return Object.freeze({
    kind: authority.kind as EvidenceAuthorityKind,
    id: requiredIdentity(authority.id, 'authority.id'),
  })
}

function assertInputCommitment(
  provenance: AttestationProvenance,
  inputSetCommitment: string,
): void {
  if (typeof provenance?.inputsHash !== 'string' || provenance.inputsHash.trim().length === 0) {
    throw new TypeError('evidence receipt: provenance.inputsHash is required')
  }
  if (provenance.inputsHash.trim() !== inputSetCommitment) {
    throw new TypeError(
      'evidence receipt: provenance.inputsHash must equal binding.inputSetCommitment',
    )
  }
}

function requiredIdentity(value: string, field: string): string {
  const normalized = value.trim()
  if (normalized.length === 0) throw new TypeError(`evidence receipt: ${field} must be non-empty`)
  return normalized
}
