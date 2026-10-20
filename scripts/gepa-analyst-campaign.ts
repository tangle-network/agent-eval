/**
 * GEPA campaign over the recursive CodeTraceBench analyst instructions.
 *
 * Surface: the full RLM instruction string. The output-contract block (the
 * subject grammar and block caps) is frozen: a candidate that does not contain
 * it verbatim as its final section scores 0 without spending a model call,
 * because a rewritten contract breaks the subject encoding and produces
 * parse-zero scores that are indistinguishable from bad analysis.
 *
 * Two scenario sources, selected by `--scenario-family`:
 *
 * Default (mini-SWE, round 2): the SPENT dev-32 and holdout-1 pools
 * (32 labeled-positive scenarios), stratified by gold-block width, scored by
 * the judge composite multiplied by the case's gold-mass weight.
 *
 * `--scenario-family oht2` (round 3): the TUNING-LEGAL OpenHands + Terminus2
 * dev pools. Labeled-positive rows only, both families mixed, per-family
 * seeded sample: 12 train + 8 selection per family (24 train / 16 selection,
 * disjoint). The selected traj_ids are GEPA-SPENT and recorded in a committed
 * split-plan (`benchmarks/trace-analysis/oht2-family-gepa-20260803/`);
 * certification cuts must exclude them, and every run re-derives the split and
 * refuses to start if it drifts from the committed plan. The score is the
 * plain per-case judge composite (f1 averaged with critical-step accuracy when
 * defined) with no gold-mass weighting; selection readouts report plain macro
 * and pooled micro side by side. `--recipe engine` (default) runs one bounded
 * GEPA engine; `--recipe omni` runs GEPA's official Omni composition
 * (two explore stages, then a continuation seeded by the explore winner) on
 * the same total evaluation budget — Omni requires the GEPA source venv
 * (`.venv-gepa-source`).
 *
 * Every training or selection evaluation returns per-case TP/FP/FN counts and
 * missed issue ids through the artifact evidence, so reflection sees the count
 * structure behind each scalar.
 *
 * Usage:
 *   # family split plan only, no spend, no venvs needed:
 *   pnpm exec tsx scripts/gepa-analyst-campaign.ts --scenario-family oht2 --plan
 *   # family smoke (3 scenarios, 3 evaluations, real provider — take the
 *   # measurement mutex first):
 *   until mkdir /tmp/ctb-llm-mutex.lock 2>/dev/null; do sleep 20; done; \
 *     trap 'rmdir /tmp/ctb-llm-mutex.lock' EXIT; \
 *     ZAI_GLM_API_KEY=... pnpm exec tsx scripts/gepa-analyst-campaign.ts \
 *       --scenario-family oht2 --smoke
 *   # full family run, detached, with archival on completion:
 *   setsid nohup bash -c 'until mkdir /tmp/ctb-llm-mutex.lock 2>/dev/null; do sleep 20; done; \
 *     trap "rmdir /tmp/ctb-llm-mutex.lock" EXIT; \
 *     ZAI_GLM_API_KEY=... pnpm exec tsx scripts/gepa-analyst-campaign.ts --scenario-family oht2; \
 *     rsync -a /dev/shm/mp-tg3-gepa-family-engine/ ~/bench-cache/ctb-20260801/gepa-family-engine/' \
 *     > /dev/shm/mp-tg3-gepa-family-engine.log 2>&1 &
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { sha256Digest } from '../src/analyst/benchmark-verification-artifacts'
import type {
  OptimizationMethodInput,
  OptimizationMethodRunOptions,
} from '../src/campaign/presets/compare-optimization-methods'
import { createRunCostLedger, fsCampaignStorage } from '../src/campaign/storage'
import {
  FAMILY,
  RUN_DIR,
  ROUND,
  SEED,
  MAX_EVALUATIONS,
  COST_CEILING_USD,
  ANALYSIS_TIMEOUT_MS,
  DSPY_PYTHON,
  GEPA_PYTHON,
  GEPA_VENV_HINT,
  BASELINE,
} from './gepa-analyst/configuration'
import type { GepaAnalystScenario, GepaAnalystArtifact } from './gepa-analyst/contract'
import { prepareCampaignScenarios } from './gepa-analyst/scenarios'
import { createCampaignEvaluation } from './gepa-analyst/evaluation'
import { createCampaignMethod } from './gepa-analyst/method'
import { writeCampaignSummary } from './gepa-analyst/summary'

async function main(): Promise<void> {
  mkdirSync(RUN_DIR, { recursive: true })
  const storage = fsCampaignStorage()
  const costLedger = createRunCostLedger({
    storage,
    runDir: join(RUN_DIR, 'cost'),
    costCeilingUsd: COST_CEILING_USD,
  })

  const prepared = await prepareCampaignScenarios()
  if (!prepared) return
  const {
    scenarios, poolProvenance, trainScenarios, selectionScenarios,
    stratification, maxGoldMass, storesById,
  } = prepared

  /**
   * Round 2 weights the composite by gold mass so the optimized mean tracks
   * micro-F1. The family campaign scores the plain per-case composite: every
   * case counts equally, and the weight is identically 1.
   */
  const goldMassWeight = FAMILY
    ? () => 1
    : (scenario: Pick<GepaAnalystScenario, 'goldMass'>) => scenario.goldMass / maxGoldMass

  if (!existsSync(DSPY_PYTHON)) {
    throw new Error(
      `${DSPY_PYTHON} is missing — run: cd clients/python && uv sync --frozen --extra dspy`,
    )
  }
  if (!existsSync(GEPA_PYTHON)) {
    throw new Error(`${GEPA_PYTHON} is missing — run: ${GEPA_VENV_HINT}`)
  }

  const { dispatchWithSurface, judge } = createCampaignEvaluation(
    costLedger, storesById, goldMassWeight,
  )
  const { method, recipe, boundaryBurst } = await createCampaignMethod(
    selectionScenarios, goldMassWeight,
  )

  const runOptions: OptimizationMethodRunOptions<GepaAnalystScenario, GepaAnalystArtifact> = {
    expectUsage: 'off',
    storage,
    dispatchTimeoutMs: ANALYSIS_TIMEOUT_MS + 300_000,
  }
  const input: OptimizationMethodInput<GepaAnalystScenario, GepaAnalystArtifact> = {
    baselineSurface: BASELINE,
    trainScenarios,
    selectionScenarios,
    dispatchWithSurface,
    judges: [judge],
    runDir: RUN_DIR,
    seed: SEED,
    runOptions,
    costLedger,
  }

  console.log(
    `[gepa-analyst-r${ROUND}] starting GEPA: recipe=${recipe.kind} ` +
      `maxEvaluations=${MAX_EVALUATIONS}${FAMILY ? ` boundaryBurst=${boundaryBurst}` : ''} ` +
      `runDir=${RUN_DIR}`,
  )
  const started = Date.now()
  const result = await method.optimize(input)
  const winner = result.winnerSurface
  if (typeof winner !== 'string') throw new Error('winner surface is not a string')
  const winnerSha256 = sha256Digest(winner)
  const baselineSha256 = sha256Digest(BASELINE)
  writeFileSync(join(RUN_DIR, 'winner-instructions.txt'), winner)
  console.log(
    `[gepa-analyst-r${ROUND}] optimize done in ${((Date.now() - started) / 60_000).toFixed(1)}min ` +
      `evaluations=${result.provenance?.evaluationCount} winnerSha=${winnerSha256}`,
  )

  await writeCampaignSummary({
    scenarios, poolProvenance, trainScenarios, selectionScenarios, stratification,
    maxGoldMass, goldMassWeight, dispatchWithSurface, judge, recipe, boundaryBurst,
    result, winner, winnerSha256, baselineSha256, started, costLedger,
  })
}

main().catch((error) => {
  console.error('[gepa-analyst] FAILED:', error)
  process.exitCode = 1
})
