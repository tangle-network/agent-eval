/** GEPA objectives, bounded engine or Omni recipe, and optimizer execution owner. */
import type {
  GepaEngineRun,
  GepaOptimizationRecipe,
} from '../../src/campaign/gepa-optimization-method'
import { gepaOptimizationMethod } from '../../src/campaign/gepa-optimization-method'
import { loadOptimizerExecutionOwner } from '../../examples/_shared/optimizer-execution-owner'
import {
  FAMILY,
  RECIPE_KIND,
  SEED,
  MODEL,
  PRICING,
  MAX_EVALUATIONS,
  MAX_PROPOSER_COST_USD,
  GEPA_TIMEOUT_MS,
  REFLECTION_MINIBATCH_SIZE,
  GEPA_PYTHON,
  CONTRACT_BLOCK,
} from './configuration'
import type { GepaAnalystScenario, GepaAnalystArtifact, GoldMassWeight } from './contract'

export async function createCampaignMethod(
  selectionScenarios: readonly GepaAnalystScenario[],
  goldMassWeight: GoldMassWeight,
) {
  const optimizerExecution = await loadOptimizerExecutionOwner(MODEL)

  const round2Objective =
    'Rewrite the analysis policy of a recursive coding-trace analyst so it localizes every ' +
    'incorrect assistant step (contiguous failure blocks) more accurately. Per case, the ' +
    'quality score is the harmonic mean of labeled-issue recall and finding precision, ' +
    'averaged with critical-step accuracy when defined; that score is multiplied by the ' +
    "case's gold-mass weight (labeled incorrect-step count / pool max), so cases with many " +
    'labeled incorrect steps carry proportionally more of the optimization signal — this ' +
    'matches the micro-F1 benchmark headline. Evaluation evidence carries per-case counts ' +
    '(tp = labeled issues matched, fp = findings tied to no labeled issue, fn = labeled ' +
    'issues missed) plus the missed issue ids: use the counts, not just the scalar, to ' +
    'decide what to change — high fn concentrated in wide blocks means under-flagging block ' +
    'spans; high fp means over-flagging correct steps. The candidate is the complete ' +
    'instruction string: an analysis policy followed by a fixed output contract. The ' +
    'output-contract block must be preserved BYTE-IDENTICAL as the final section of the ' +
    'candidate — it defines the machine-parsed subject grammar (incorrect-steps-<first>-' +
    '<last>-<escape>-consequence-<n>) and the block caps, and any candidate missing it ' +
    'verbatim scores 0 without being executed. Edit only the policy text above the contract.'
  const familyObjective =
    'Rewrite the analysis policy of a recursive coding-trace analyst so it localizes every ' +
    'incorrect assistant step (contiguous failure blocks) in long OpenHands and Terminus2 ' +
    'trajectories (median 48 steps, roughly double the trajectories the current policy was ' +
    'tuned on). Per case, the quality score is the harmonic mean of labeled-issue recall ' +
    'and finding precision, averaged with critical-step accuracy when defined; the ' +
    'optimized signal is the plain mean of that per-case score — every case counts ' +
    'equally. Measured failure profile of the current policy on these agent families: ' +
    '(1) mislocalization dominates — nearly half the labeled gold mass is missed with ' +
    'every citation more than 2 steps away, yet crediting the existing citations at any ' +
    'distance would roughly double the score, so the analyst finds real incidents but ' +
    'reports the wrong steps; (2) under-enumeration — about 1.6 predicted blocks per run ' +
    'against about 3.0 labeled blocks per case, capping recall near 55% before any ' +
    'localization error; (3) early anchoring — predictions sit earlier in the trajectory ' +
    'than the labels (predicted start fraction p50 about 0.5 versus gold about 0.67): the ' +
    'analyst commits to the first convincing incident and never reaches the mid-late ' +
    'segment where the labels live. Evaluation evidence carries per-case counts (tp = ' +
    'labeled issues matched, fp = findings tied to no labeled issue, fn = labeled issues ' +
    'missed) plus the missed issue ids: use the counts, not just the scalar, to decide ' +
    'what to change. The candidate is the complete instruction string: an analysis policy ' +
    'followed by a fixed output contract. The output-contract block must be preserved ' +
    'BYTE-IDENTICAL as the final section of the candidate — it defines the machine-parsed ' +
    'subject grammar (incorrect-steps-<first>-<last>-<escape>-consequence-<n>) and the ' +
    'block caps, and any candidate missing it verbatim scores 0 without being executed. ' +
    'Edit only the policy text above the contract.'

  /**
   * Family budget geometry — how one engine run's numbers are derived.
   *
   * gepa 0.1.4 checks its metric-call budget only once per iteration-loop
   * pass, so after a passing check it can still spend one full iteration:
   * parent minibatch + proposed minibatch + (on acceptance) a full valset
   * evaluation. If the callback's hard cap equals GEPA's own target, that
   * boundary overshoot hits the cap, the callback returns HTTP 429, and
   * raise_on_exception kills the whole run (measured on both smoke shapes).
   *
   * The fix is headroom, not tolerance: the callback cap exceeds the
   * upstream target by exactly one worst-case iteration burst. The bridge
   * derates the upstream limit by maxConcurrency - 1, so maxConcurrency
   * serves here as the headroom knob only — engineConfig.engine.parallel is
   * false, execution stays strictly serial (every gepa parallel path gates
   * on that flag, and serial calls also keep the z.ai seat far below its
   * ~5-concurrent 429 limit), and the injected max_workers value is inert.
   *
   * Cost stays bounded by the callback cap (upstream + burst) and the run
   * cost ceiling; GEPA stops at the first boundary at or past its target.
   */
  const boundaryBurst = 2 * REFLECTION_MINIBATCH_SIZE + selectionScenarios.length
  const familyEngineRun = (upstreamEvaluations: number, runSeed: number): GepaEngineRun => ({
    engine: 'gepa',
    maxEvaluations: upstreamEvaluations + boundaryBurst,
    maxProposerCostUsd: MAX_PROPOSER_COST_USD,
    maxConcurrency: boundaryBurst + 1,
    engineConfig: {
      engine: {
        capture_stdio: false,
        parallel: false,
        raise_on_exception: true,
        seed: runSeed,
      },
      reflection: {
        reflection_minibatch_size: REFLECTION_MINIBATCH_SIZE,
        skip_perfect_score: false,
      },
    },
  })
  let recipe: GepaOptimizationRecipe
  if (FAMILY && RECIPE_KIND === 'omni') {
    // Same total upstream evaluation budget as the engine recipe, split
    // across GEPA's official Omni composition: two explore stages then a
    // continuation that starts from the explore winner. maxWorkers 1 keeps
    // the explore stages sequential.
    const exploreEvaluations = Math.max(1, Math.round(MAX_EVALUATIONS * 0.24))
    const continueEvaluations = MAX_EVALUATIONS - 2 * exploreEvaluations
    if (continueEvaluations < 1) {
      throw new Error(
        `--max-evaluations ${MAX_EVALUATIONS} cannot fund the omni recipe (needs 2 explore stages + a continuation)`,
      )
    }
    recipe = {
      kind: 'omni',
      explore: [
        familyEngineRun(exploreEvaluations, SEED + 101),
        familyEngineRun(exploreEvaluations, SEED + 102),
      ],
      continueWith: familyEngineRun(continueEvaluations, SEED + 103),
      maxWorkers: 1,
    }
  } else if (FAMILY) {
    recipe = { kind: 'engine', run: familyEngineRun(MAX_EVALUATIONS, SEED) }
  } else {
    recipe = {
      kind: 'engine',
      run: {
        engine: 'gepa',
        maxEvaluations: MAX_EVALUATIONS,
        maxProposerCostUsd: MAX_PROPOSER_COST_USD,
        maxConcurrency: 1,
        engineConfig: {
          engine: {
            capture_stdio: false,
            max_workers: 1,
            parallel: false,
            raise_on_exception: true,
            seed: SEED,
          },
          reflection: {
            reflection_minibatch_size: REFLECTION_MINIBATCH_SIZE,
            skip_perfect_score: false,
          },
        },
      },
    }
  }

  const method = gepaOptimizationMethod<GepaAnalystScenario, GepaAnalystArtifact>({
    name: FAMILY ? `gepa-analyst-family-r3-${RECIPE_KIND}` : 'gepa-analyst-policy-r2',
    objective: FAMILY ? familyObjective : round2Objective,
    background:
      `The frozen output contract (must appear verbatim at the end of every candidate):\n` +
      `${CONTRACT_BLOCK}`,
    evaluationId: FAMILY
      ? 'codetracebench-analyst-instructions-r3-oht2'
      : 'codetracebench-analyst-instructions-r2',
    recipe,
    optimizer: {
      model: MODEL,
      ...optimizerExecution,
      budget: {
        maxCostUsd: MAX_PROPOSER_COST_USD,
        maxRequests: 120,
        maxRequestBytes: 4_000_000,
        maxResponseBytes: 4_000_000,
        maxOutputTokensPerRequest: 16_384,
        maxReasoningTokensPerRequest: 32_768,
        pricing: PRICING,
      },
    },
    timeoutMs: GEPA_TIMEOUT_MS,
    describeScenario: (scenario) => ({
      id: scenario.id,
      trajectoryId: scenario.trajectoryId,
      pool: scenario.pool,
      stratum: scenario.stratum,
      goldMass: scenario.goldMass,
      maxBlockWidth: scenario.maxBlockWidth,
    }),
    describeArtifact: (artifact, scenario) => ({
      rawSubjects: artifact.rawSubjects.slice(0, 24),
      scoredFindings: artifact.findings.length,
      counts: artifact.matchCounts,
      missedIssueIds: artifact.missedIssueIds.slice(0, 24),
      goldMassWeight: goldMassWeight(scenario),
      ...(artifact.contractViolation ? { contractViolation: true } : {}),
      ...(artifact.executionError ? { executionError: artifact.executionError } : {}),
      ...(artifact.blockDiagnostics ? { blockDiagnostics: artifact.blockDiagnostics } : {}),
    }),
    runner: { command: GEPA_PYTHON },
  })

  return { method, recipe, boundaryBurst }
}
