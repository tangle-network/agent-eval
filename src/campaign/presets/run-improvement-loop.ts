/**
 * `runImprovementLoop` — the gated-promotion shell around the improvement
 * loop body (`runOptimization`). Proposes candidate surfaces via the
 * `SurfaceProposer`, re-scores the winner against the baseline on a
 * holdout set, runs the release gate, and optionally opens a PR.
 *
 * Role vocabulary (see docs/design/loop-taxonomy.md):
 *   - PROPOSER   = the `SurfaceProposer` (evolutionary GEPA mutator OR
 *                  reflective analyst). Proposes candidate SURFACES — the
 *                  worker's system prompt / tool config — NOT conversation
 *                  turns.
 *   - MEASUREMENT= `runCampaign`. Scores one surface by running the worker
 *                  (via `dispatch`) over scenarios and judging the output.
 *   - WORKER     = the agent harness in the sandbox, invoked behind the
 *                  topology-opaque `dispatch` seam — never referenced here.
 *
 * Distinct from `runLoop` in `@tangle-network/agent-runtime`, which is the
 * INNER conversation loop (execution driver ↔ workers in a sandbox). `runImprovementLoop`
 * is the OUTER loop: it improves the surface that those workers run.
 *
 * Hard-refuses unsafe configurations:
 *   - `tracing: 'off'` when a proposer is wired (improvement is unattributable)
 *   - `autoOnPromote: 'config'` — DEFERRED to Pass B; v0.40 only ships
 *     `'pr'` and `'none'`.
 */

import { openAutoPr } from '../auto-pr'
import { campaignCoverage, formatCoverageFailures } from '../coverage'
import type { CampaignResult, Gate, MutableSurface, Scenario } from '../types'
import type { RunOptimizationOptions, RunOptimizationResult } from './run-optimization'
import { runOptimization, surfaceHash } from './run-optimization'

/** Default per-cell dispatch deadline (10 min). Generous enough that only a
 *  true hang trips it; a single agent turn that legitimately needs longer can
 *  raise `dispatchTimeoutMs`. Without it, one stalled dispatch hangs the loop
 *  (and the CI job above it) forever with no diagnostic. */
const DEFAULT_DISPATCH_TIMEOUT_MS = 600_000

export type RunImprovementLoopOptions<
  TScenario extends Scenario,
  TArtifact,
> = RunOptimizationOptions<TScenario, TArtifact> & {
  /** Holdout scenarios kept OUT of the training optimization pool — used
   *  ONLY to score baseline vs winner for the gate. */
  holdoutScenarios: TScenario[]
  /** Promotion gate. Substrate strongly recommends `defaultProductionGate`
   *  for production wiring (composes red-team / reward-hacking / canary /
   *  heldout). */
  gate: Gate<TArtifact, TScenario>
  /** What to do when the gate ships:
   *   - `'pr'`: open a PR via `openAutoPr`
   *   - `'none'`: just report — caller decides what to do with the winner
   *  v0.40 does NOT support `'config'` (live-runtime self-mutation) —
   *  deferred to Pass B behind safety stack. */
  autoOnPromote: 'pr' | 'none'
  /** GH owner / repo for the auto-PR. Required when autoOnPromote === 'pr'. */
  ghOwner?: string
  ghRepo?: string
  /** Optional render override — substrate writes a diff-shaped surface; pass
   *  a function to format the promoted surface differently. */
  renderPromotedDiff?: (winnerSurface: MutableSurface, baselineSurface: MutableSurface) => string
  /** Placebo control. When supplied AND the winner differs from baseline, the
   *  loop scores a THIRD holdout arm: the winner surface with its content
   *  footprint-matched-blanked by this function (typically via `neutralizeText`).
   *  Its scores are exposed to the gate as `ctx.neutralizedJudgeScores`, letting
   *  a `neutralizationGate` reject a win whose lift survives blanking the content
   *  (decorative — driven by footprint, not content). Costs one extra holdout
   *  campaign; omit to skip. Return a byte/layout-matched blank of the winner. */
  neutralize?: (winnerSurface: MutableSurface, baselineSurface: MutableSurface) => MutableSurface
}

export interface RunImprovementLoopResult<TArtifact, TScenario extends Scenario>
  extends RunOptimizationResult<TArtifact, TScenario> {
  baselineOnHoldout: CampaignResult<TArtifact, TScenario>
  winnerOnHoldout: CampaignResult<TArtifact, TScenario>
  gateResult: Awaited<ReturnType<Gate<TArtifact, TScenario>['decide']>>
  /** Unified baseline→winner surface diff. Computed UNCONDITIONALLY (not only
   *  when `autoOnPromote === 'pr'`) so the diff that the gate decided on is
   *  always present on the result + in the emitted provenance record. Empty
   *  string when winner == baseline (no change to diff). */
  promotedDiff: string
  prResult?: ReturnType<typeof openAutoPr>
}

/**
 * Gated-promotion shell over `runOptimization`: scores the winner against the baseline on a holdout set, runs the release gate, and optionally opens a PR.
 */
export async function runImprovementLoop<TScenario extends Scenario, TArtifact>(
  opts: RunImprovementLoopOptions<TScenario, TArtifact>,
): Promise<RunImprovementLoopResult<TArtifact, TScenario>> {
  // ── Safety pre-flight ─────────────────────────────────────────────
  if ((opts as { autoOnPromote?: string }).autoOnPromote === 'config') {
    throw new Error(
      "runImprovementLoop: autoOnPromote='config' is deferred to Pass B (requires shadow deploy + rollback + ensemble judges). Use 'pr' or 'none' in v0.40.",
    )
  }
  // Refuse tracing=off whenever a proposer is wired. An improvement loop
  // without traces is unattributable — its candidate surfaces cannot be
  // cited back to the spans that motivated them, and the dataset flywheel
  // (LabeledScenarioStore) that GEPA optimizes against goes unfed.
  if (opts.tracing === 'off' && opts.proposer) {
    throw new Error(
      "runImprovementLoop: tracing='off' is forbidden when a proposer is wired. The improvement loop without traces is unattributable; candidate surfaces cannot be cited back to spans and the optimization dataset goes unfed.",
    )
  }
  if (opts.autoOnPromote === 'pr' && (!opts.ghOwner || !opts.ghRepo)) {
    throw new Error("runImprovementLoop: autoOnPromote='pr' requires ghOwner + ghRepo.")
  }
  // train ∩ holdout must be empty. runOptimization trains on `opts.scenarios`;
  // the gate scores baseline-vs-winner ONLY on `opts.holdoutScenarios`. A shared
  // scenario means the optimizer adapted to a gate scenario, so the lift the gate
  // then reports is measured on data the optimization already saw — memorization
  // read as generalization. Fail loud before any rollout, not with an inflated
  // gate decision. (Mirrors the runSkillOpt train/holdout guard.)
  const holdoutIds = new Set(opts.holdoutScenarios.map((s) => s.id))
  const leaked = opts.scenarios.filter((s) => holdoutIds.has(s.id)).map((s) => s.id)
  if (leaked.length > 0) {
    throw new Error(
      `runImprovementLoop: training scenarios and holdoutScenarios must be disjoint (overlap: [${leaked.join(
        ', ',
      )}]) — a shared scenario leaks the held-out gate axis into the optimization, inflating reported lift.`,
    )
  }

  // Per-cell dispatch deadline applied to EVERY campaign in the loop
  // (optimization + both holdout passes). A single non-settling dispatch — a
  // stalled model request, an exhausted runtime resource, a stream that never
  // closes — must fail its cell loud, not hang the whole loop (and the CI job)
  // indefinitely. Caller-overridable; default is generous so only true hangs
  // trip it.
  const dispatchTimeoutMs = opts.dispatchTimeoutMs ?? DEFAULT_DISPATCH_TIMEOUT_MS

  // ── (1) optimization loop produces a winner ────────────────────────
  const optimization = await runOptimization({ ...opts, dispatchTimeoutMs })

  // No candidate beat the training baseline ⇒ the "winner" IS the baseline
  // (empty diff). Re-scoring the baseline against ITSELF on the holdout and
  // gating the resulting model noise as "lift" is a false positive — it
  // promotes nothing and reports run-to-run variance as an improvement. Detect
  // it up front: skip the redundant winner-holdout pass and force a `hold`.
  const winnerIsBaseline = optimization.winnerSurfaceHash === surfaceHash(opts.baselineSurface)

  // ── (2) baseline + winner re-scored on the holdout set ─────────────
  const { runCampaign } = await import('../run-campaign')

  const baselineOnHoldout = await runCampaign<TScenario, TArtifact>({
    ...opts,
    dispatchTimeoutMs,
    scenarios: opts.holdoutScenarios,
    dispatch: (scenario, ctx) => opts.dispatchWithSurface(opts.baselineSurface, scenario, ctx),
    runDir: `${opts.runDir}/holdout-baseline`,
  })

  // When the winner == baseline, scoring it again would just be a second noisy
  // sample of the same surface. Reuse the baseline holdout — the gate is forced
  // to `hold` below regardless, and we save a full campaign.
  const winnerOnHoldout = winnerIsBaseline
    ? baselineOnHoldout
    : await runCampaign<TScenario, TArtifact>({
        ...opts,
        dispatchTimeoutMs,
        scenarios: opts.holdoutScenarios,
        dispatch: (scenario, ctx) =>
          opts.dispatchWithSurface(optimization.winnerSurface, scenario, ctx),
        runDir: `${opts.runDir}/holdout-winner`,
      })

  // A final comparison is valid only when both arms scored every designed
  // (scenario × rep) cell with the same complete judge set. Otherwise an arm
  // can appear to improve by silently dropping its hardest cell or failed
  // judge. This is the same exact-denominator check used during optimization.
  const requireJudgeScore = (opts.judges?.length ?? 0) > 0
  const reps = opts.reps ?? 1
  const assertCompleteHoldout = (
    arm: string,
    campaign: CampaignResult<TArtifact, TScenario>,
  ): void => {
    const coverage = campaignCoverage(
      campaign.cells,
      opts.holdoutScenarios,
      reps,
      requireJudgeScore,
    )
    if (!coverage.complete) {
      throw new Error(
        `runImprovementLoop: ${arm} holdout is incomplete ` +
          `(${coverage.scorableCellIds.length}/${coverage.expectedCellIds.length} designed cells scorable) — ` +
          `${formatCoverageFailures(coverage)}. Refusing to compare unequal holdout results.`,
      )
    }
  }
  assertCompleteHoldout('baseline', baselineOnHoldout)
  assertCompleteHoldout('winner', winnerOnHoldout)

  // ── (3) gate verdict ───────────────────────────────────────────────
  // Candidate + baseline share cellIds (same holdout scenarios), so their
  // judge scores MUST stay in separate maps — merging them collapses the
  // holdout delta to zero and the gate can never ship a real improvement.
  type ScoreMap = Map<
    string,
    Record<string, { composite: number; dimensions: Record<string, number>; notes: string }>
  >
  const candidateArtifacts = new Map<string, TArtifact>()
  const baselineArtifacts = new Map<string, TArtifact>()
  const judgeScores: ScoreMap = new Map()
  const baselineJudgeScores: ScoreMap = new Map()
  for (const cell of winnerOnHoldout.cells) {
    candidateArtifacts.set(cell.cellId, cell.artifact)
    judgeScores.set(cell.cellId, cell.judgeScores)
  }
  for (const cell of baselineOnHoldout.cells) {
    baselineArtifacts.set(cell.cellId, cell.artifact)
    baselineJudgeScores.set(cell.cellId, cell.judgeScores)
  }

  // ── (3a) placebo arm ───────────────────────────────────────────────
  // When a `neutralize` fn is wired and the winner actually changed something,
  // score a third holdout arm: the winner surface with its content
  // footprint-matched-blanked. A `neutralizationGate` reads these scores to
  // reject a win whose lift survives blanking the content (decorative — driven
  // by the added footprint, not the content). Skipped for a no-op winner (there
  // is no content to blank) and when no `neutralize` is supplied.
  let neutralizedArtifacts: Map<string, TArtifact> | undefined
  let neutralizedJudgeScores: ScoreMap | undefined
  if (opts.neutralize && !winnerIsBaseline) {
    const neutralizedSurface = opts.neutralize(optimization.winnerSurface, opts.baselineSurface)
    const neutralizedOnHoldout = await runCampaign<TScenario, TArtifact>({
      ...opts,
      dispatchTimeoutMs,
      scenarios: opts.holdoutScenarios,
      dispatch: (scenario, ctx) => opts.dispatchWithSurface(neutralizedSurface, scenario, ctx),
      runDir: `${opts.runDir}/holdout-neutralized`,
    })
    assertCompleteHoldout('neutralized', neutralizedOnHoldout)
    neutralizedArtifacts = new Map<string, TArtifact>()
    neutralizedJudgeScores = new Map()
    for (const cell of neutralizedOnHoldout.cells) {
      neutralizedArtifacts.set(cell.cellId, cell.artifact)
      neutralizedJudgeScores.set(cell.cellId, cell.judgeScores)
    }
  }

  // No-op guard: a winner identical to the baseline has nothing to promote, so
  // it never reaches the gate — otherwise the gate scores baseline-vs-itself,
  // sees model noise as a delta, and can "ship" an empty diff (the observed
  // false positive: a +4 held-out "lift" with `diff: ''`). Force `hold`.
  const gateResult = winnerIsBaseline
    ? {
        decision: 'hold' as const,
        reasons: [
          'no candidate beat the training baseline — winner == baseline (empty diff); nothing to promote',
        ],
        contributingGates: [
          { name: 'no-op-guard', passed: false, detail: { winnerIsBaseline: true } },
        ],
        delta: 0,
      }
    : await opts.gate.decide({
        candidateArtifacts,
        baselineArtifacts,
        judgeScores,
        baselineJudgeScores,
        neutralizedArtifacts,
        neutralizedJudgeScores,
        scenarios: opts.holdoutScenarios,
        cost: {
          candidate: winnerOnHoldout.aggregates.totalCostUsd,
          baseline: baselineOnHoldout.aggregates.totalCostUsd,
        },
        signal: new AbortController().signal,
      })

  // ── (4) baseline→winner diff (always) + auto-PR when gate ships ────
  // The diff is computed UNCONDITIONALLY — it's the human-auditable record of
  // what the loop actually changed, needed for the provenance artifact whether
  // or not a PR is opened. winner == baseline ⇒ empty diff (nothing changed).
  const render = opts.renderPromotedDiff ?? defaultRenderDiff
  const promotedDiff =
    optimization.winnerSurfaceHash === surfaceHash(opts.baselineSurface)
      ? ''
      : render(optimization.winnerSurface, opts.baselineSurface)

  let prResult: ReturnType<typeof openAutoPr> | undefined
  if (opts.autoOnPromote === 'pr' && gateResult.decision === 'ship') {
    prResult = openAutoPr({
      result: winnerOnHoldout,
      gate: gateResult,
      promotedDiff,
      ghOwner: opts.ghOwner!,
      ghRepo: opts.ghRepo!,
    })
  }

  return {
    ...optimization,
    baselineOnHoldout,
    winnerOnHoldout,
    gateResult,
    promotedDiff,
    prResult,
  }
}

/**
 * Default surface diff renderer: produces a unified baseline/winner text diff for prompt surfaces or a worktree-ref summary for code surfaces.
 */
export function defaultRenderDiff(
  winnerSurface: MutableSurface,
  baselineSurface: MutableSurface,
): string {
  // Code surfaces aren't text-diffable here — the diff lives in git. Render
  // the worktree/base refs + summary so the PR body points at the change.
  if (typeof winnerSurface !== 'string' || typeof baselineSurface !== 'string') {
    const fmt = (s: MutableSurface): string =>
      typeof s === 'string'
        ? '(prompt surface)'
        : `worktree=${s.worktreeRef}${s.baseRef ? ` base=${s.baseRef}` : ''}${s.summary ? `\n${s.summary}` : ''}`
    return `--- baseline\n${fmt(baselineSurface)}\n+++ winner\n${fmt(winnerSurface)}`
  }
  const lines: string[] = []
  lines.push('--- baseline')
  lines.push('+++ winner')
  for (const l of baselineSurface.split('\n')) lines.push(`- ${l}`)
  for (const l of winnerSurface.split('\n')) lines.push(`+ ${l}`)
  return lines.join('\n')
}
