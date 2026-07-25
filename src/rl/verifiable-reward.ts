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
import { isRealnessGated, observedScore, trainingScore } from '../rollout/reward'
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
  /**
   * The run carries `outcome.realness.gated` — the authenticity gate flagged
   * its success signal as faked.
   *
   * With the gate applied (the default) `value` and every `components` entry
   * are 0 on such a run; with `applyRealnessGate: false` the observed numbers
   * come back untouched and this flag is the only marker that they are not to
   * be trusted. Either way it distinguishes "measured a genuine failure" from
   * "claimed a success we refuse to believe", which a bare 0 cannot.
   */
  realnessGated?: boolean
  /**
   * Whether an authenticity screen COULD run on this reward at all — the same
   * distinction `RolloutOutcome.realness_screened` draws, for the same reason.
   *
   * `false` on every reward from `extractVerifiableReward`, because a
   * `VerificationReport` carries layer scores and nothing else: there is no
   * `outcome.realness` to consult, so no gate has run, and `realnessGated`
   * being absent there means "unknown", NOT "clean". Absent on the
   * `RunRecord` path when the record itself carries no realness verdict.
   *
   * This matters most exactly where it is easiest to miss: a report whose
   * deterministic layers all passed yields `determinism: 'deterministic'`,
   * `confidence: 1` — the highest-credibility reward this module can emit —
   * and a stubbed integration reporting green is precisely what a gamed run
   * looks like. Consumers driving training off this shape must screen the run
   * themselves; the flag is what tells them nobody has.
   */
  realnessScreened?: boolean
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
  /**
   * Whether the anti-Goodhart realness gate applies. Default `true`, and the
   * default is the one every training path must keep.
   *
   * Set `false` ONLY for detection and analysis. `rl/reward-hacking.ts` does,
   * for the same reason it reads `observedScore` for its proxy: it measures the
   * DIVERGENCE between the judge signal and the deterministic one, and a
   * deterministic reward that another gate already forced to 0 manufactures
   * exactly that divergence on exactly the gamed population. The detector would
   * then be re-reporting a verdict it was supposed to reach independently.
   */
  applyRealnessGate?: boolean
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
 *
 * NO realness gate is applied and none can be: a `VerificationReport` carries
 * layer scores and nothing about whether the run faked them — `realness` lives
 * on the `RunRecord`. Use `extractVerifiableRewardsFromRecords` for anything
 * that becomes training data; this signature is for scoring a report in hand.
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
      realnessScreened: false,
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
      realnessScreened: false,
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
    realnessScreened: false,
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
 *
 * The realness gate applies to EVERY channel here, and to the deterministic one
 * MOST. It is tempting to reason that a decidable signal cannot be gamed, so
 * the gate is redundant on it — that reasoning is backwards. `realness.gated`
 * means the run's success signal was FAKED, and a test suite reporting green on
 * a stubbed integration is precisely what that looks like: the deterministic
 * layer is the thing that got faked. Exporting it ungated hands a trainer the
 * highest-credibility reward the module can emit (`determinism: 'deterministic'`,
 * `confidence: 1`) for the one population the gate exists to catch. Pass
 * `applyRealnessGate: false` only to look at the ungated numbers for detection.
 */
export function extractVerifiableRewardsFromRecords(
  runs: RunRecord[],
  opts: VerifiableRewardExtractionOptions = {},
): Array<{ runId: string; reward: VerifiableReward | null }> {
  const sourceFor = opts.sourceFor ?? DEFAULT_SOURCE_FOR
  const deterministicSet = new Set(opts.deterministicLayers ?? [...DEFAULT_DETERMINISTIC_LAYERS])
  const fallbackToJudge = opts.fallbackToJudge ?? true
  const judgeFloor = opts.judgeConfidenceFloor ?? 0.7
  const applyGate = opts.applyRealnessGate ?? true

  return runs.map((run) => {
    const flagged = isRealnessGated(run)
    // Present only when the record carries an actual realness verdict. Absent
    // is the honest "unknown"; `false` is reserved for a producer that
    // declares it HAS no screen, which is the report-shaped path above.
    const screened = run.outcome.realness === undefined ? {} : ({ realnessScreened: true } as const)
    // Zeroed with `value`, never left at the measured number: `components`
    // exists so an RL consumer can re-weight per source, and a raw layer score
    // surviving there would let that re-weighting reconstruct the very reward
    // the gate just refused. The measured layer scores stay on
    // `run.outcome.raw['layer.*']`, which is where analysis reads them.
    const gate = (value: number): number => (applyGate && flagged ? 0 : value)
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
      const value = gate(clamp01(layer.score))
      return {
        runId: run.runId,
        reward: {
          value,
          source: sourceFor(layer.name),
          determinism: 'deterministic',
          confidence: 1,
          origin: layer.name,
          components: { [layer.name]: value },
          realnessGated: flagged,
          ...screened,
        },
      }
    }
    if (det.length > 1) {
      const value = gate(clamp01(det.reduce((s, l) => s + l.score, 0) / det.length))
      const components: Record<string, number> = Object.fromEntries(
        det.map((l) => [l.name, gate(l.score)]),
      )
      return {
        runId: run.runId,
        reward: {
          value,
          source: 'composite',
          determinism: 'deterministic',
          confidence: 1,
          origin: det.map((l) => l.name).join('+'),
          components,
          breakdown: { ...components },
          realnessGated: flagged,
          ...screened,
        },
      }
    }
    if (!fallbackToJudge) return { runId: run.runId, reward: null }

    // Probabilistic fallback: the run's primary score. `trainingScore` already
    // carries the gate, so a gamed run falls to 0 rather than earning the
    // judge's number; `observedScore` is the ungated reader the detection
    // opt-out asks for.
    const primary = applyGate ? trainingScore(run) : observedScore(run)
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
        realnessGated: flagged,
        ...screened,
      },
    }
  })
}

/**
 * Filter `RunRecord[]` to those with deterministic verifiable rewards.
 *
 * A realness-gated run is KEPT, at reward 0 with `realnessGated: true` — the
 * same rule GRPO uses on a gated line. 0 is the honest label for a faked
 * success and is usable signal, whereas dropping the run would move a group
 * baseline without saying so. (SFT differs: there every row is a target to
 * imitate, so a gated row is removed outright.)
 */
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
