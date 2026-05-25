/**
 * @experimental
 *
 * `runImprovementLoop` — the full closed-loop improvement preset. Runs the
 * optimization loop (population × generations) then evaluates the winner
 * against a baseline via the gate, then optionally opens a PR.
 *
 * Distinguished from `runLoop` in `@tangle-network/agent-runtime`, which is
 * the tactical driver↔worker conversation loop for a single session.
 * `runImprovementLoop` is the strategic closed feedback loop across many
 * campaigns over time.
 *
 * Hard-refuses unsafe configurations:
 *   - `tracing: 'off'` when any mutator is wired (loop is unauditable)
 *   - `autoOnPromote: 'config'` — DEFERRED to Pass B; v0.40 only ships
 *     `'pr'` and `'none'`.
 */

import { openAutoPr } from '../auto-pr'
import type { CampaignResult, Gate, Scenario } from '../types'
import type { RunOptimizationOptions, RunOptimizationResult } from './run-optimization'
import { runOptimization } from './run-optimization'

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
  renderPromotedDiff?: (winnerSurface: string, baselineSurface: string) => string
}

export interface RunImprovementLoopResult<TArtifact, TScenario extends Scenario>
  extends RunOptimizationResult<TArtifact, TScenario> {
  baselineOnHoldout: CampaignResult<TArtifact, TScenario>
  winnerOnHoldout: CampaignResult<TArtifact, TScenario>
  gateResult: Awaited<ReturnType<Gate<TArtifact, TScenario>['decide']>>
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
  // Tighter than Phase 2: refuse tracing=off whenever a mutator is wired,
  // not just when autoOnPromote != 'none'. An optimizer without traces
  // cannot produce attribution-grade findings, even if no PR opens.
  if (opts.tracing === 'off' && opts.mutator) {
    throw new Error(
      "runImprovementLoop: tracing='off' is forbidden when a mutator is wired. The improvement loop without traces is unattributable; findings cannot be cited back to spans.",
    )
  }
  if (opts.autoOnPromote === 'pr' && (!opts.ghOwner || !opts.ghRepo)) {
    throw new Error("runImprovementLoop: autoOnPromote='pr' requires ghOwner + ghRepo.")
  }

  // ── (1) optimization loop produces a winner ────────────────────────
  const optimization = await runOptimization(opts)

  // ── (2) baseline + winner re-scored on the holdout set ─────────────
  const { runCampaign } = await import('../run-campaign')

  const baselineOnHoldout = await runCampaign<TScenario, TArtifact>({
    ...opts,
    scenarios: opts.holdoutScenarios,
    dispatch: (scenario, ctx) => opts.dispatchWithSurface(opts.baselineSurface, scenario, ctx),
    runDir: `${opts.runDir}/holdout-baseline`,
  })

  const winnerOnHoldout = await runCampaign<TScenario, TArtifact>({
    ...opts,
    scenarios: opts.holdoutScenarios,
    dispatch: (scenario, ctx) =>
      opts.dispatchWithSurface(optimization.winnerSurface, scenario, ctx),
    runDir: `${opts.runDir}/holdout-winner`,
  })

  // ── (3) gate verdict ───────────────────────────────────────────────
  const candidateArtifacts = new Map<string, TArtifact>()
  const baselineArtifacts = new Map<string, TArtifact>()
  const judgeScores = new Map<
    string,
    Record<string, { composite: number; dimensions: Record<string, number>; notes: string }>
  >()
  for (const cell of winnerOnHoldout.cells) {
    candidateArtifacts.set(cell.cellId, cell.artifact)
    judgeScores.set(cell.cellId, cell.judgeScores)
  }
  for (const cell of baselineOnHoldout.cells) {
    baselineArtifacts.set(cell.cellId, cell.artifact)
    const prior = judgeScores.get(cell.cellId) ?? {}
    judgeScores.set(cell.cellId, { ...prior, ...cell.judgeScores })
  }

  const gateResult = await opts.gate.decide({
    candidateArtifacts,
    baselineArtifacts,
    judgeScores,
    scenarios: opts.holdoutScenarios,
    cost: {
      candidate: winnerOnHoldout.aggregates.totalCostUsd,
      baseline: baselineOnHoldout.aggregates.totalCostUsd,
    },
    signal: new AbortController().signal,
  })

  // ── (4) auto-PR when gate ships ────────────────────────────────────
  let prResult: ReturnType<typeof openAutoPr> | undefined
  if (opts.autoOnPromote === 'pr' && gateResult.decision === 'ship') {
    const render = opts.renderPromotedDiff ?? defaultRenderDiff
    const promotedDiff = render(optimization.winnerSurface, opts.baselineSurface)
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
    prResult,
  }
}

function defaultRenderDiff(winnerSurface: string, baselineSurface: string): string {
  const lines: string[] = []
  lines.push('--- baseline')
  lines.push('+++ winner')
  const baseLines = baselineSurface.split('\n')
  const winLines = winnerSurface.split('\n')
  for (const l of baseLines) lines.push(`- ${l}`)
  for (const l of winLines) lines.push(`+ ${l}`)
  return lines.join('\n')
}
