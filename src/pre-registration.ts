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

export interface SignedManifest extends HypothesisManifest {
  /** sha256 hex of canonicalized manifest (everything except contentHash). */
  contentHash: string
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

export async function signManifest(m: HypothesisManifest): Promise<SignedManifest> {
  const canonical = canonicalize(m)
  const bytes = new TextEncoder().encode(JSON.stringify(canonical))
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes)
  const hash = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
  return { ...m, contentHash: hash }
}

/** Verify that a signed manifest has not been tampered with. */
export async function verifyManifest(m: SignedManifest): Promise<boolean> {
  const { contentHash, ...rest } = m
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

function canonicalize(v: unknown): unknown {
  if (v === null || typeof v !== 'object') return v
  if (Array.isArray(v)) return v.map(canonicalize)
  const keys = Object.keys(v as Record<string, unknown>).sort()
  const out: Record<string, unknown> = {}
  for (const k of keys) out[k] = canonicalize((v as Record<string, unknown>)[k])
  return out
}
