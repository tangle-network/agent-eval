/**
 * Verifiable reward channel.
 *
 * For RL on coding / math / theorem-proving / structured-output tasks, the
 * reward signal is *decidable* — a test passes or fails, a proof checks or
 * doesn't, an output validates against a schema or doesn't. These rewards
 * are dramatically more useful for RL training than LLM-judge scores
 * because they don't drift, can't be Goodhart-gamed by the policy in the
 * same way, and don't require a separate calibration loop.
 *
 * The `MultiLayerVerifier` already produces this signal — it just doesn't
 * surface it in a shape that's clean enough for RL training. This module
 * wraps the verifier output so consumers can:
 *
 *   1. Extract a clean `VerifiableReward` from a `VerificationReport`
 *   2. Distinguish *deterministic* rewards (compile, test, schema) from
 *      *probabilistic* rewards (judge) so they can be weighted differently
 *      in the RL training step
 *   3. Filter `RunRecord[]` to only those with a verifiable reward,
 *      producing the clean training set that DeepSeek-R1-style GRPO and
 *      AlphaProof-style search both depend on
 *
 * Why this matters: every credible 2025-2026 frontier RL result on coding
 * agents leans on verifiable reward (DeepSeek-R1 GRPO on test pass-rate,
 * o-series RL on math/code, AlphaProof on Lean kernel checking). Mixing
 * judge scores into the reward signal poisons the gradient. This module
 * is the seam.
 */

import type { LayerResult, VerificationReport } from '../multi-layer-verifier'
import type { RunRecord } from '../run-record'

export type VerifiableRewardSource =
  | 'compile' // typecheck / build / lint passed
  | 'test' // unit / integration test pass-rate
  | 'schema' // structured output validates
  | 'sandbox' // sandbox exec exit code
  | 'judge' // LLM judge — probabilistic, included for completeness
  | 'composite' // weighted blend across multiple of the above

export interface VerifiableReward {
  /** Scalar in [0, 1]. The RL training signal. */
  value: number
  /** What produced the reward — different sources have different determinism. */
  source: VerifiableRewardSource
  /**
   * Determinism class. `'deterministic'` rewards are repeatable byte-for-byte
   * given the same inputs (compile, test, schema validation, sandbox exit code).
   * `'probabilistic'` rewards depend on a stochastic component (LLM judge).
   * Mixing these in the same training batch without separation is a known
   * footgun in production RLHF pipelines.
   */
  determinism: 'deterministic' | 'probabilistic'
  /**
   * Confidence in the reward value. For deterministic sources this is 1.0
   * (the bit either flipped or didn't). For judge sources this is the
   * judge-reported confidence or — when missing — a calibrated prior.
   */
  confidence: number
  /** The layer / judge id that produced the signal, for provenance. */
  origin: string
  /**
   * Per-source contribution to `value`, keyed by layer/judge id. Single-source
   * rewards carry one entry (`{ [origin]: value }`); composite rewards carry
   * every contributing layer's score — the anti-scalar-collapse surface RL
   * consumers weight per-source instead of trusting one blended number.
   */
  components: Record<string, number>
  /**
   * @deprecated Read `components` for per-source reward values. Kept for
   * published-API compatibility: single-source rewards carry the layer's
   * diagnostics here (e.g. `{ tests_passed: 7 }`); composite rewards carry
   * the same per-layer scores `components` now holds.
   */
  breakdown?: Record<string, number>
}

export interface VerifiableRewardExtractionOptions {
  /**
   * Which layers count as deterministic-reward sources. The verifier doesn't
   * tag layers as "this is verifiable"; the caller declares it via this list
   * (or via the layer name → source mapping). Default treats common names
   * (`install`, `typecheck`, `build`, `lint`, `test`, `compile`, `schema`,
   * `sandbox`) as deterministic.
   */
  deterministicLayers?: string[]
  /**
   * Map layer name → reward source. Defaults to a sensible string-match.
   */
  sourceFor?: (layerName: string) => VerifiableRewardSource
  /**
   * Whether to fall back to a probabilistic (judge) reward when no
   * deterministic layer produced a numeric score. Default `true`. Set to
   * `false` for "deterministic-only" training pipelines that should
   * discard runs without a verifiable signal.
   */
  fallbackToJudge?: boolean
  /**
   * Default confidence for probabilistic (judge) rewards when the judge
   * doesn't report one. Default `0.7`.
   */
  judgeConfidenceFloor?: number
}

const DEFAULT_DETERMINISTIC_LAYERS = new Set([
  'install',
  'typecheck',
  'build',
  'lint',
  'test',
  'compile',
  'schema',
  'sandbox',
  'unit_tests',
  'integration_tests',
])

const DEFAULT_SOURCE_FOR = (name: string): VerifiableRewardSource => {
  const lower = name.toLowerCase()
  if (lower.includes('test')) return 'test'
  if (
    lower.includes('compile') ||
    lower.includes('build') ||
    lower.includes('typecheck') ||
    lower.includes('lint')
  )
    return 'compile'
  if (lower.includes('schema')) return 'schema'
  if (lower.includes('sandbox')) return 'sandbox'
  if (lower.includes('judge') || lower.includes('semantic')) return 'judge'
  return 'composite'
}

/**
 * Extract a `VerifiableReward` from a `VerificationReport`.
 *
 * Strategy: prefer the deterministic layers (in order: test → compile →
 * schema → sandbox), fall back to the judge layer if `fallbackToJudge` is
 * true, return `null` if no signal qualifies. When multiple deterministic
 * layers contribute, return a `'composite'` source with a weighted blend.
 */
export function extractVerifiableReward(
  report: VerificationReport,
  opts: VerifiableRewardExtractionOptions = {},
): VerifiableReward | null {
  const deterministicSet = new Set(opts.deterministicLayers ?? [...DEFAULT_DETERMINISTIC_LAYERS])
  const sourceFor = opts.sourceFor ?? DEFAULT_SOURCE_FOR
  const fallbackToJudge = opts.fallbackToJudge ?? true
  const judgeFloor = opts.judgeConfidenceFloor ?? 0.7

  const deterministic = report.layers.filter(
    (l) => deterministicSet.has(l.layer) && typeof l.score === 'number' && Number.isFinite(l.score),
  )

  if (deterministic.length === 1) {
    const layer = deterministic[0]!
    const value = clamp01(layer.score!)
    return {
      value,
      source: sourceFor(layer.layer),
      determinism: 'deterministic',
      confidence: 1,
      origin: layer.layer,
      components: { [layer.layer]: value },
      breakdown: layerBreakdown(layer),
    }
  }

  if (deterministic.length > 1) {
    // Composite: weighted blend by `Layer.weight` if present, else equal.
    let num = 0
    let denom = 0
    const components: Record<string, number> = {}
    for (const l of deterministic) {
      const w = (l.detail?.weight as number | undefined) ?? 1
      num += w * (l.score ?? 0)
      denom += w
      components[l.layer] = l.score!
    }
    return {
      value: denom === 0 ? 0 : clamp01(num / denom),
      source: 'composite',
      determinism: 'deterministic',
      confidence: 1,
      origin: deterministic.map((l) => l.layer).join('+'),
      components,
      breakdown: { ...components },
    }
  }

  if (!fallbackToJudge) return null

  const judge =
    report.layers.find(
      (l) =>
        typeof l.score === 'number' && Number.isFinite(l.score) && sourceFor(l.layer) === 'judge',
    ) ?? report.layers.find((l) => typeof l.score === 'number' && Number.isFinite(l.score))

  if (!judge) return null

  const confFromDetail = judge.detail?.confidence as number | undefined
  const judgeValue = clamp01(judge.score!)
  return {
    value: judgeValue,
    source: 'judge',
    determinism: 'probabilistic',
    confidence: typeof confFromDetail === 'number' ? confFromDetail : judgeFloor,
    origin: judge.layer,
    components: { [judge.layer]: judgeValue },
    breakdown: layerBreakdown(judge),
  }
}

/**
 * Extract verifiable rewards from `RunRecord[]` produced via the
 * `verificationReportToRunRecord` adapter (which encodes per-layer scores
 * in `outcome.raw['layer.<name>']`). For records that don't carry layer
 * scores, returns `null` for that record.
 *
 * This is the canonical bridge from "campaign-shaped artifacts" to
 * "RL-training-ready reward signals": every record that has a clean
 * verifiable reward becomes a training datum, every record that doesn't
 * gets filtered out (or kept with `'probabilistic'` determinism for
 * separate downstream handling).
 */
export function extractVerifiableRewardsFromRecords(
  runs: RunRecord[],
  opts: VerifiableRewardExtractionOptions = {},
): Array<{ runId: string; reward: VerifiableReward | null }> {
  const sourceFor = opts.sourceFor ?? DEFAULT_SOURCE_FOR
  const deterministicSet = new Set(opts.deterministicLayers ?? [...DEFAULT_DETERMINISTIC_LAYERS])
  const fallbackToJudge = opts.fallbackToJudge ?? true
  const judgeFloor = opts.judgeConfidenceFloor ?? 0.7

  return runs.map((run) => {
    // Recover per-layer scores from outcome.raw['layer.<name>']
    const layerScores: Array<{ name: string; score: number }> = []
    for (const [k, v] of Object.entries(run.outcome.raw)) {
      if (
        k.startsWith('layer.') &&
        !k.includes('.', 6) &&
        typeof v === 'number' &&
        Number.isFinite(v)
      ) {
        layerScores.push({ name: k.slice('layer.'.length), score: v })
      }
    }
    const det = layerScores.filter((l) => deterministicSet.has(l.name))

    if (det.length === 1) {
      const layer = det[0]!
      const value = clamp01(layer.score)
      return {
        runId: run.runId,
        reward: {
          value,
          source: sourceFor(layer.name),
          determinism: 'deterministic',
          confidence: 1,
          origin: layer.name,
          components: { [layer.name]: value },
        },
      }
    }
    if (det.length > 1) {
      const value = det.reduce((s, l) => s + l.score, 0) / det.length
      const components: Record<string, number> = Object.fromEntries(
        det.map((l) => [l.name, l.score]),
      )
      return {
        runId: run.runId,
        reward: {
          value: clamp01(value),
          source: 'composite',
          determinism: 'deterministic',
          confidence: 1,
          origin: det.map((l) => l.name).join('+'),
          components,
          breakdown: { ...components },
        },
      }
    }
    if (!fallbackToJudge) return { runId: run.runId, reward: null }

    // Probabilistic fallback: use the run's primary score.
    const primary = run.outcome.holdoutScore ?? run.outcome.searchScore
    if (typeof primary !== 'number' || !Number.isFinite(primary)) {
      return { runId: run.runId, reward: null }
    }
    const primaryValue = clamp01(primary)
    return {
      runId: run.runId,
      reward: {
        value: primaryValue,
        source: 'judge',
        determinism: 'probabilistic',
        confidence: judgeFloor,
        origin: 'run.outcome.score',
        components: { 'run.outcome.score': primaryValue },
      },
    }
  })
}

/** Filter `RunRecord[]` to those with deterministic verifiable rewards. */
export function filterDeterministicallyRewarded(
  runs: RunRecord[],
  opts: VerifiableRewardExtractionOptions = {},
): Array<{ run: RunRecord; reward: VerifiableReward }> {
  const rewarded = extractVerifiableRewardsFromRecords(runs, { ...opts, fallbackToJudge: false })
  const out: Array<{ run: RunRecord; reward: VerifiableReward }> = []
  for (let i = 0; i < runs.length; i++) {
    const r = rewarded[i]!
    if (r.reward && r.reward.determinism === 'deterministic') {
      out.push({ run: runs[i]!, reward: r.reward })
    }
  }
  return out
}

// ── Helpers ──────────────────────────────────────────────────────────────

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0
  return Math.max(0, Math.min(1, x))
}

function layerBreakdown(l: LayerResult): Record<string, number> {
  const out: Record<string, number> = {}
  if (l.diagnostics) {
    for (const [k, v] of Object.entries(l.diagnostics)) {
      if (typeof v === 'number' && Number.isFinite(v)) out[k] = v
    }
  }
  return out
}
