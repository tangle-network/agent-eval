/**
 * Reproducibility attestation for any serializable report object.
 *
 * `attest()` binds a report to its content address (sha-256 over canonical
 * JSON) AND binds that address to the provenance needed to reproduce it:
 * model versions, seeds, price-table hash, code SHA, inputs hash. The outer
 * `envelopeHash` prevents provenance from being rewritten while leaving the
 * report hash valid.
 *
 * Layering: content-addressing is the substrate's job; cryptographic SIGNING
 * (who vouches for the attestation, key management, transparency logs) is the
 * consumer's layer on top. An `AttestedReport` is a stable byte-identical
 * payload a consumer can sign — the substrate never holds keys.
 *
 * Generic by design: the report parameter is ANY value `canonicalJson`
 * accepts (campaign results, fuzz capsules, scorecards, cost ledgers). Do not
 * couple this module to a specific report schema.
 */

import { contentHash } from './verdict-cache'

/** Hash scheme identifier carried by every attestation. A verifier rejects
 * unknown algorithms instead of guessing. */
export const ATTESTATION_ALGORITHM = 'sha256/canonical-json' as const

export interface AttestationProvenance {
  /** Every model involved in producing the report, name → version/id. */
  modelVersions: Record<string, string>
  /** RNG seeds the run was driven by, when seeded. */
  seeds?: number[]
  /** Content hash of the price table used for cost figures — cost numbers
   * are only reproducible against the same prices. */
  priceTableHash?: string
  /** Git SHA of the code that produced the report. */
  codeSha: string
  /** Content hash of the input set (scenarios, dataset manifest, ...). */
  inputsHash?: string
  /** ISO-8601 timestamp, caller-supplied — the substrate stays clock-free
   * so attestation is deterministic and testable. */
  createdAt: string
}

export interface AttestedReport {
  /** Hex sha-256 over the canonical JSON of the report. */
  reportHash: string
  provenance: AttestationProvenance
  algorithm: typeof ATTESTATION_ALGORITHM
  /**
   * Hex sha-256 over `{ reportHash, provenance, algorithm }`. New attestations
   * always carry it. Optional only so persisted pre-envelope attestations can
   * still be read and explicitly recognized as legacy by callers.
   */
  envelopeHash?: string
}

export interface AttestationVerification {
  valid: boolean
  /** Populated iff `valid` is false — names the exact mismatch. */
  reason?: string
  /** True only for a valid pre-envelope attestation whose provenance is not cryptographically bound. */
  legacyUnboundProvenance?: true
}

function envelopeMaterial(
  reportHash: string,
  provenance: AttestationProvenance,
  algorithm: typeof ATTESTATION_ALGORITHM,
): object {
  return { reportHash, provenance, algorithm }
}

/**
 * Content-address a report and bind it to its provenance. Throws (via
 * `canonicalJson`) if the report or provenance contains undefined / function /
 * symbol / non-finite numbers — an attestation that cannot be unambiguously
 * serialized cannot be trusted.
 */
export function attest(report: unknown, provenance: AttestationProvenance): AttestedReport {
  const reportHash = contentHash(report)
  const algorithm = ATTESTATION_ALGORITHM
  return {
    reportHash,
    provenance,
    algorithm,
    envelopeHash: contentHash(envelopeMaterial(reportHash, provenance, algorithm)),
  }
}

/**
 * Verify a report against its attestation. Returns a typed outcome rather
 * than throwing: an unverifiable report (e.g. one that no longer
 * canonicalizes) is a verification failure with the cause in `reason`, not a
 * crash — verifiers run in pipelines that must record WHY, not die.
 *
 * Legacy attestations without `envelopeHash` remain readable, but verification
 * explicitly marks their provenance as unbound so a promotion path can refuse
 * them instead of accidentally treating old metadata as cryptographic proof.
 */
export function verifyAttestation(
  report: unknown,
  attested: AttestedReport,
): AttestationVerification {
  if (attested.algorithm !== ATTESTATION_ALGORITHM) {
    return {
      valid: false,
      reason: `unknown algorithm '${attested.algorithm}' — this verifier only checks '${ATTESTATION_ALGORITHM}'`,
    }
  }
  let recomputed: string
  try {
    recomputed = contentHash(report)
  } catch (err) {
    return {
      valid: false,
      reason: `report is not canonicalizable: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
  if (recomputed !== attested.reportHash) {
    return {
      valid: false,
      reason: `report hash mismatch: attested ${attested.reportHash}, recomputed ${recomputed}`,
    }
  }

  if (attested.envelopeHash === undefined) {
    return { valid: true, legacyUnboundProvenance: true }
  }

  let envelopeHash: string
  try {
    envelopeHash = contentHash(
      envelopeMaterial(attested.reportHash, attested.provenance, attested.algorithm),
    )
  } catch (err) {
    return {
      valid: false,
      reason: `attestation provenance is not canonicalizable: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
  if (envelopeHash !== attested.envelopeHash) {
    return {
      valid: false,
      reason: `attestation envelope hash mismatch: attested ${attested.envelopeHash}, recomputed ${envelopeHash}`,
    }
  }

  return { valid: true }
}
