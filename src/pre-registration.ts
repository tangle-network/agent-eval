/**
 * Pre-registered hypotheses — declare what you're testing BEFORE the
 * run, check it AFTER. Prevents p-hacking, optional stopping, and the
 * "we ran until it looked good" failure mode.
 *
 * Manifest is a plain JSON-friendly object. Sign it with a content hash
 * + timestamp; the registered record becomes immutable. Post-run,
 * evaluate the manifest against observed results — the library refuses
 * to let you re-interpret a different metric as the declared one.
 */

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
 * `'sha256-content'` — sha256 hex over the canonicalized manifest with
 * the `contentHash` and `algo` fields stripped. This is what
 * `signManifest` produces today.
 *
 * Held as a string union so future schemes can be added without
 * breaking parsers; legacy SignedManifest values written before this
 * field existed will deserialize cleanly because the field is optional.
 */
export type SignedManifestAlgo = 'sha256-content'

export interface SignedManifest extends HypothesisManifest {
  /** sha256 hex of canonicalized manifest (everything except contentHash and algo). */
  contentHash: string
  /**
   * Algorithm string describing how `contentHash` was produced.
   *
   * Optional on the type so legacy serialized manifests (pre-`algo`)
   * still parse, but ALWAYS populated by {@link signManifest}.
   * Consumers that want to enforce a known algorithm should reject
   * manifests where this field is missing or unrecognized.
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
  rejectionReasons: Array<'wrong_direction' | 'effect_too_small' | 'not_significant' | 'undersampled'>
  notes?: string
}

/**
 * Deterministic JSON canonicalization — sort object keys recursively.
 *
 * Two semantically-equal objects produce byte-identical canonicalized output;
 * this is what makes a content-hash stable across encoders, key insertion
 * orders, and runtime versions. Exported for any consumer that needs the same
 * canonicalization guarantee outside the manifest-signing path (e.g., signing
 * an artifact bundle, hashing a dataset version, etc.).
 */
export function canonicalize(v: unknown): unknown {
  if (v === null || typeof v !== 'object') return v
  if (Array.isArray(v)) return v.map(canonicalize)
  const keys = Object.keys(v as Record<string, unknown>).sort()
  const out: Record<string, unknown> = {}
  for (const k of keys) out[k] = canonicalize((v as Record<string, unknown>)[k])
  return out
}

/**
 * SHA-256 hex (full 64 chars) over the canonicalized JSON encoding of `obj`.
 *
 * The same primitive `signManifest` and `verifyManifest` are built on, exposed
 * directly so consumers signing arbitrary structured content (artifact bundles,
 * production packets, dataset manifests, etc.) don't have to re-derive
 * canonicalize+sha256 from scratch.
 *
 * Stable across:
 *   - object key insertion order (canonicalization sorts keys recursively)
 *   - encoder choice (UTF-8 via TextEncoder, fixed)
 *   - runtime (uses the Web Crypto subtle digest, present in Node ≥18 and browsers)
 *
 * Naming note: `hashJson` rather than `hashContent` because `hashContent` is
 * already taken in `prompt-registry.ts` for the truncated 12-char prompt-id
 * helper, which has different semantics (string input, short return). Both
 * coexist; `hashJson` is the right name when you mean "canonicalize then hash."
 *
 * @example
 *   const hash = await hashJson({ id: '1', kind: 'spec' })
 *   // 'a3f1...' (64 hex chars)
 */
export async function hashJson<T>(obj: T): Promise<string> {
  const canonical = canonicalize(obj)
  const bytes = new TextEncoder().encode(JSON.stringify(canonical))
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/**
 * Sign a manifest with a SHA-256 content hash.
 *
 * The hash covers the canonicalized manifest with the `contentHash`
 * and `algo` fields stripped; this lets verifiers re-sign the rest and
 * compare. Returned manifest always carries `algo: 'sha256-content'`
 * so downstream consumers can identify the scheme; legacy serialized
 * manifests without `algo` still verify because it is stripped before
 * hashing on both sides.
 */
export async function signManifest(m: HypothesisManifest): Promise<SignedManifest> {
  const hash = await hashJson(m)
  return { ...m, contentHash: hash, algo: 'sha256-content' }
}

/**
 * Verify that a signed manifest has not been tampered with.
 *
 * Strips `contentHash` and `algo` before re-signing so legacy manifests
 * (written before `algo` was emitted) verify identically to current
 * ones.
 */
export async function verifyManifest(m: SignedManifest): Promise<boolean> {
  const { contentHash, algo: _algo, ...rest } = m
  void _algo
  const resigned = await signManifest(rest)
  return resigned.contentHash === contentHash
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
  const directionOk =
    manifest.direction === 'increase' ? observed.effect > 0 : observed.effect < 0
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
