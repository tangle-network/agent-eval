/**
 * Pre-registered hypotheses — declare what you're testing BEFORE the
 * run, check it AFTER. Prevents p-hacking, optional stopping, and the
 * "we ran until it looked good" failure mode.
 *
 * Manifest is a plain JSON-friendly object. Sign it with a content hash
 * + timestamp; the registered record becomes immutable. Post-run,
 * evaluate the manifest against observed results — the library refuses
 * to let you re-interpret a different metric as the declared one.
 *
 * A signed manifest carries its required digest scheme. Verification accepts
 * only RFC 8785 canonical JSON, using the same encoder as every new identity.
 */

import { hashCanonical } from './ledger-core/canonical'

export interface HypothesisManifest {
  id: string
  /** Human prose — goes into the audit trail. */
  hypothesis: string
  /** Metric the hypothesis claims to move. */
  metric: string
  /** 'increase' = candidate should score higher than baseline; 'decrease' = lower. */
  direction: 'increase' | 'decrease'
  /** Minimum effect size to count (same units as the metric). */
  minEffect: number
  /** Alpha threshold. */
  alpha: number
  /** Target statistical power at which sample size was pre-computed. */
  power: number
  /** Declared N per arm before running. */
  preRegisteredN: number
  /** ISO8601 timestamp the manifest was registered. */
  registeredAt: string
  /** Optional identifiers to tie into the trace corpus. */
  baselineLabel?: string
  candidateLabel?: string
}

/** SHA-256 over RFC 8785 canonical JSON, excluding `contentHash` and `algo`. */
export type SignedManifestAlgo = 'sha256-rfc8785'

export interface SignedManifest extends HypothesisManifest {
  /** sha256 hex of canonicalized manifest (everything except contentHash and algo). */
  contentHash: string
  /** Required digest scheme. Missing or unsupported schemes fail verification. */
  algo: SignedManifestAlgo
}

export interface HypothesisResult {
  manifest: SignedManifest
  observedN: number
  observedEffect: number
  observedPValue: number
  /** True iff the observed effect hits the pre-declared direction with
   *  magnitude ≥ minEffect AND p < alpha. */
  confirmed: boolean
  /** Enumerated reasons the hypothesis was rejected (each a machine-tag). */
  rejectionReasons: Array<
    'wrong_direction' | 'effect_too_small' | 'not_significant' | 'undersampled'
  >
  notes?: string
}

/**
 * SHA-256 hex (full 64 chars) over the RFC 8785 canonical JSON encoding of
 * `obj` — the package's one identity scheme, shared with `ledger-core`.
 *
 * Values canonical JSON cannot represent faithfully — `undefined`, `NaN`,
 * class instances, cycles — are refused rather than coerced, because a
 * coercion maps two distinct records onto one digest.
 *
 * Named `hashJson` to disambiguate from `prompt-registry.ts`'s `hashContent`,
 * which takes a string input and returns a truncated 12-char prompt id.
 *
 * @example
 *   const hash = await hashJson({ id: '1', kind: 'spec' })
 *   // 'a3f1...' (64 hex chars)
 */
export async function hashJson<T>(obj: T): Promise<string> {
  return hashCanonical(obj).slice('sha256:'.length)
}

/**
 * Digest a manifest after validating its scheme, excluding `contentHash` and
 * `algo`. This synchronous check can refuse a manifest before consuming data.
 */
export function manifestContentDigest(manifest: SignedManifest): string {
  const { contentHash: _contentHash, algo, ...rest } = manifest
  void _contentHash
  if (algo !== 'sha256-rfc8785') {
    throw new Error(`pre-registration: unsupported manifest hash algo '${String(algo)}'`)
  }
  return hashCanonical(rest).slice('sha256:'.length)
}

/**
 * Sign a manifest with a SHA-256 content hash over its RFC 8785 canonical
 * JSON, with `contentHash` and `algo` stripped, and stamp the scheme in
 * `algo` so a later reader knows which encoder to verify with.
 */
export async function signManifest(m: HypothesisManifest): Promise<SignedManifest> {
  const signed: SignedManifest = { ...m, contentHash: '', algo: 'sha256-rfc8785' }
  return { ...signed, contentHash: manifestContentDigest(signed) }
}

/**
 * Verify that a signed manifest has not been tampered with, under the scheme
 * the manifest itself declares.
 */
export async function verifyManifest(m: SignedManifest): Promise<boolean> {
  try {
    return manifestContentDigest(m) === m.contentHash
  } catch {
    return false
  }
}

/**
 * Evaluate a pre-registered hypothesis against observed results.
 * Mechanical — no re-interpretation permitted.
 */
export async function evaluateHypothesis(
  manifest: SignedManifest,
  observed: { n: number; effect: number; pValue: number },
): Promise<HypothesisResult> {
  if (!(await verifyManifest(manifest))) {
    throw new Error('evaluateHypothesis: unsupported manifest hash scheme or content hash mismatch')
  }
  const reasons: HypothesisResult['rejectionReasons'] = []
  const directionOk = manifest.direction === 'increase' ? observed.effect > 0 : observed.effect < 0
  if (!directionOk) reasons.push('wrong_direction')
  if (Math.abs(observed.effect) < manifest.minEffect) reasons.push('effect_too_small')
  if (observed.pValue >= manifest.alpha) reasons.push('not_significant')
  if (observed.n < manifest.preRegisteredN) reasons.push('undersampled')
  return {
    manifest,
    observedN: observed.n,
    observedEffect: observed.effect,
    observedPValue: observed.pValue,
    confirmed: reasons.length === 0,
    rejectionReasons: reasons,
  }
}
