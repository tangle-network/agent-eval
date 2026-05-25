/**
 * @experimental
 *
 * `runProductionLoop` — the full self-improvement preset. Runs the
 * optimization loop (population × generations) then evaluates the winner
 * against a baseline via the gate, then optionally opens a PR.
 *
 * Hard-refuses unsafe configurations:
 *   - `tracing: 'off'` when `autoOnPromote !== 'none'` (unauditable)
 *   - `autoOnPromote: 'config'` — DEFERRED to Pass B; v0.40 only ships
 *     `'pr'` and `'none'`.
 */

import { openAutoPr } from '../auto-pr'
import { runOptimization } from './run-optimization'
import type { RunOptimizationOptions, RunOptimizationResult } from './run-optimization'
import type { CampaignResult, Gate, Scenario } from '../types'

export interface RunProductionLoopOptions<TScenario extends Scenario, TArtifact>
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

export interface RunProductionLoopResult<TArtifact, TScenario extends Scenario>
  extends RunOptimizationResult<TArtifact, TScenario> {
  baselineOnHoldout: CampaignResult<TArtifact, TScenario>
  winnerOnHoldout: CampaignResult<TArtifact, TScenario>
  gateResult: Awaited<ReturnType<Gate<TArtifact, TScenario>['decide']>>
  prResult?: ReturnType<typeof openAutoPr>
}

export async function runProductionLoop<TScenario extends Scenario, TArtifact>(
  opts: RunProductionLoopOptions<TScenario, TArtifact>,
): Promise<RunProductionLoopResult<TArtifact, TScenario>> {
  // ── Safety pre-flight ─────────────────────────────────────────────
  // biome-ignore lint/suspicious/noExplicitAny: Pass A reserved field for Pass B Shape B
  if ((opts as any).autoOnPromote === 'config') {
    throw new Error('runProductionLoop: autoOnPromote=\'config\' is deferred to Pass B (requires shadow deploy + rollback + ensemble judges). Use \'pr\' or \'none\' in v0.40.')
  }
  if (opts.tracing === 'off' && opts.autoOnPromote !== 'none') {
    throw new Error('runProductionLoop: tracing=\'off\' is forbidden when autoOnPromote != \'none\'. A self-promoting loop without traces is unauditable by construction.')
  }
  if (opts.autoOnPromote === 'pr' && (!opts.ghOwner || !opts.ghRepo)) {
    throw new Error('runProductionLoop: autoOnPromote=\'pr\' requires ghOwner + ghRepo.')
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
    dispatch: (scenario, ctx) => opts.dispatchWithSurface(optimization.winnerSurface, scenario, ctx),
    runDir: `${opts.runDir}/holdout-winner`,
  })

  // ── (3) gate verdict ───────────────────────────────────────────────
  const candidateArtifacts = new Map<string, TArtifact>()
  const baselineArtifacts = new Map<string, TArtifact>()
  const judgeScores = new Map<string, Record<string, { composite: number; dimensions: Record<string, number>; notes: string }>>()
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
