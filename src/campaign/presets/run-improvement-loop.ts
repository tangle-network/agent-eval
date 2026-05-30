/**
 * @experimental
 *
 * `runImprovementLoop` — the gated-promotion shell around the improvement
 * loop body (`runOptimization`). Drives candidate surfaces via the
 * `ImprovementDriver`, re-scores the winner against the baseline on a
 * holdout set, runs the release gate, and optionally opens a PR.
 *
 * Role vocabulary (see docs/design/loop-taxonomy.md):
 *   - DRIVER     = the `ImprovementDriver` (evolutionary GEPA mutator OR
 *                  reflective analyst). Proposes candidate SURFACES — the
 *                  worker's system prompt / tool config — NOT conversation
 *                  turns.
 *   - MEASUREMENT= `runCampaign`. Scores one surface by running the worker
 *                  (via `dispatch`) over scenarios and judging the output.
 *   - WORKER     = the agent harness in the sandbox, invoked behind the
 *                  topology-opaque `dispatch` seam — never referenced here.
 *
 * Distinct from `runLoop` in `@tangle-network/agent-runtime`, which is the
 * INNER conversation loop (driver↔workers in a sandbox). `runImprovementLoop`
 * is the OUTER loop: it improves the surface that those workers run.
 *
 * Hard-refuses unsafe configurations:
 *   - `tracing: 'off'` when a driver is wired (improvement is unattributable)
 *   - `autoOnPromote: 'config'` — DEFERRED to Pass B; v0.40 only ships
 *     `'pr'` and `'none'`.
 */

import { openAutoPr } from '../auto-pr'
import type { CampaignResult, Gate, MutableSurface, Scenario } from '../types'
import type { RunOptimizationOptions, RunOptimizationResult } from './run-optimization'
import { runOptimization, surfaceHash } from './run-optimization'

/** Default per-cell dispatch deadline (10 min). Generous enough that only a
 *  true hang trips it; a single agent turn that legitimately needs longer can
 *  raise `dispatchTimeoutMs`. Without it, one stalled dispatch hangs the loop
 *  (and the CI job above it) forever with no diagnostic. */
const DEFAULT_DISPATCH_TIMEOUT_MS = 600_000

export interface RunImprovementLoopOptions<TScenario extends Scenario, TArtifact>
  extends RunOptimizationOptions<TScenario, TArtifact> {
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

export async function runImprovementLoop<TScenario extends Scenario, TArtifact>(
  opts: RunImprovementLoopOptions<TScenario, TArtifact>,
): Promise<RunImprovementLoopResult<TArtifact, TScenario>> {
  // ── Safety pre-flight ─────────────────────────────────────────────
  // biome-ignore lint/suspicious/noExplicitAny: Pass A reserved field for Pass B Shape B
  if ((opts as any).autoOnPromote === 'config') {
    throw new Error(
      "runImprovementLoop: autoOnPromote='config' is deferred to Pass B (requires shadow deploy + rollback + ensemble judges). Use 'pr' or 'none' in v0.40.",
    )
  }
  // Refuse tracing=off whenever a driver is wired. An improvement loop
  // without traces is unattributable — its candidate surfaces cannot be
  // cited back to the spans that motivated them, and the dataset flywheel
  // (LabeledScenarioStore) that GEPA optimizes against goes unfed.
  if (opts.tracing === 'off' && opts.driver) {
    throw new Error(
      "runImprovementLoop: tracing='off' is forbidden when a driver is wired. The improvement loop without traces is unattributable; candidate surfaces cannot be cited back to spans and the optimization dataset goes unfed.",
    )
  }
  if (opts.autoOnPromote === 'pr' && (!opts.ghOwner || !opts.ghRepo)) {
    throw new Error("runImprovementLoop: autoOnPromote='pr' requires ghOwner + ghRepo.")
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

  // Fail loud if the holdout produced nothing to score. Every holdout dispatch
  // or judge errored ⇒ the gate would read both means as 0, compute delta 0,
  // and silently "hold" on garbage — indistinguishable from a real no-lift
  // result. Refuse: surface the underlying failure instead.
  const scorable = (r: CampaignResult<TArtifact, TScenario>) =>
    r.cells.filter((c) => !c.error && c.artifact != null)
  const baseScorable = scorable(baselineOnHoldout)
  const winnerScorable = scorable(winnerOnHoldout)
  if (baseScorable.length === 0 || winnerScorable.length === 0) {
    const firstErr = (r: CampaignResult<TArtifact, TScenario>) =>
      r.cells.find((c) => c.error)?.error ?? 'unknown'
    throw new Error(
      `runImprovementLoop: holdout produced no scorable cells ` +
        `(baseline ${baseScorable.length}/${baselineOnHoldout.cells.length}, ` +
        `winner ${winnerScorable.length}/${winnerOnHoldout.cells.length}) — every holdout ` +
        `dispatch or judge failed. Refusing to emit a gate decision over an empty holdout. ` +
        `First baseline error: "${firstErr(baselineOnHoldout)}"; first winner error: "${firstErr(winnerOnHoldout)}".`,
    )
  }

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
