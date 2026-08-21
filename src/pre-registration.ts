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
 * A signed manifest is a portable record: it is written once and verified
 * later, possibly by a different release. `algo` names the digest scheme it
 * was signed under, and verification selects the encoder by that field, so a
 * manifest signed by an earlier release still verifies.
 */

import { createHash } from 'node:crypto'
import { canonicalString, hashCanonical } from './ledger-core/canonical'

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

/**
 * Identifier for the hashing scheme used to produce `contentHash`.
 *
 * Both schemes are sha256 hex over the manifest with `contentHash` and `algo`
 * stripped, and differ only in how that manifest is serialized:
 *
 * - `'sha256-rfc8785'` — RFC 8785 canonical JSON. What {@link signManifest}
 *   emits.
 * - `'sha256-content'` — key-sorted `JSON.stringify`. Read-only: manifests
 *   signed by an earlier release carry it, or carry no `algo` at all, and
 *   {@link verifyManifest} still verifies them.
 */
export type SignedManifestAlgo = 'sha256-content' | 'sha256-rfc8785'

export interface SignedManifest extends HypothesisManifest {
  /** sha256 hex of canonicalized manifest (everything except contentHash and algo). */
  contentHash: string
  /**
   * Algorithm string describing how `contentHash` was produced.
   *
   * Optional on the type so serialized manifests without it still parse,
   * but ALWAYS populated by {@link signManifest}. Consumers that want to
   * enforce a known algorithm should reject manifests where this field
   * is missing or unrecognized.
   */
  algo?: SignedManifestAlgo
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
 * Key-sorted `JSON.stringify` digest. Private and read-only: it exists so a
 * manifest signed under `'sha256-content'` still verifies, and nothing that
 * WRITES a digest may call it.
 */
function legacyContentDigest(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(sortKeysDeep(value)), 'utf8')
    .digest('hex')
}

function sortKeysDeep(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(sortKeysDeep)
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    out[key] = sortKeysDeep((value as Record<string, unknown>)[key])
  }
  return out
}

/**
 * Digest of a manifest under its own declared scheme, with `contentHash` and
 * `algo` stripped. Synchronous, so a caller that must fail before consuming an
 * observation does not have to await. Throws on an `algo` this release does
 * not know — an unverifiable manifest must not read as a valid one.
 */
export function manifestContentDigest(manifest: SignedManifest): string {
  const { contentHash: _contentHash, algo, ...rest } = manifest
  void _contentHash
  if (algo === undefined || algo === 'sha256-content') return legacyContentDigest(rest)
  if (algo === 'sha256-rfc8785') {
    return createHash('sha256').update(canonicalString(rest), 'utf8').digest('hex')
  }
  throw new Error(`pre-registration: unrecognized manifest hash algo '${String(algo)}'`)
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
  return manifestContentDigest(m) === m.contentHash
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
    throw new Error('evaluateHypothesis: manifest content hash mismatch (tampered)')
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
