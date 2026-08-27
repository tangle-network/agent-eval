import type { LlmClientOptions } from '../../llm-client'
import { defaultProductionGate } from '../gates/default-production-gate'
import {
  type FapoProposerOptions,
  fapoProposer,
  type ParameterCandidate,
  parameterSweepProposer,
} from '../proposers/fapo'
import { gepaProposer } from '../proposers/gepa'
import { skillOptProposer } from '../proposers/skill-opt'
import type { Scenario, SurfaceProposer } from '../types'
import {
  costFromLedgerSummary,
  type OptimizationMethod,
  type OptimizationMethodRunOptions,
} from './compare-optimization-methods'
import { type RunImprovementLoopOptions, runImprovementLoop } from './run-improvement-loop'
import { runSkillOpt } from './run-skill-opt'

export interface BuiltinOptimizationMethodConfig<
  TScenario extends Scenario = Scenario,
  TArtifact = unknown,
> {
  llm: LlmClientOptions
  model: string
  target: string
  /** Override shared method-run settings for this method only. */
  runOptions?: OptimizationMethodRunOptions<TScenario, TArtifact>
  /** Override the comparison seed for this method only. */
  seed?: number
  /** GEPA population per generation. Default 2. */
  populationSize?: number
  /** GEPA generations. Default 3. */
  maxGenerations?: number
  /** SkillOpt epochs. Default 6. */
  maxEpochs?: number
  mutationPrimitives?: string[]
  /** Static findings passed to each GEPA candidate-generation call. */
  findings?: unknown[]
  /** Recompute findings after each GEPA generation. */
  analyzeGeneration?: RunImprovementLoopOptions<TScenario, TArtifact>['analyzeGeneration']
  /** Optional analysis report passed to candidate generation. */
  report?: unknown
}

/** GEPA, reflection-only (single-parent, no Pareto combine). */
export function gepaReflectionMethod<TScenario extends Scenario, TArtifact>(
  config: BuiltinOptimizationMethodConfig<TScenario, TArtifact>,
  name = 'gepa-reflection',
): OptimizationMethod<TScenario, TArtifact> {
  return gepaMethod(config, false, name)
}

/** GEPA with the Pareto frontier and complementary-parent combination. */
export function gepaParetoMethod<TScenario extends Scenario, TArtifact>(
  config: BuiltinOptimizationMethodConfig<TScenario, TArtifact>,
  name = 'gepa-pareto',
): OptimizationMethod<TScenario, TArtifact> {
  return gepaMethod(config, true, name)
}

function gepaMethod<TScenario extends Scenario, TArtifact>(
  config: BuiltinOptimizationMethodConfig<TScenario, TArtifact>,
  combineParents: boolean,
  name: string,
): OptimizationMethod<TScenario, TArtifact> {
  return improvementLoopMethod(config, name, () =>
    gepaProposer({
      llm: config.llm,
      model: config.model,
      target: config.target,
      combineParents,
      ...(config.mutationPrimitives ? { mutationPrimitives: config.mutationPrimitives } : {}),
    }),
  )
}

/** SkillOpt patch-mode hill climb. */
export function skillOptMethod<TScenario extends Scenario, TArtifact>(
  config: BuiltinOptimizationMethodConfig<TScenario, TArtifact>,
  name = 'skill-opt',
): OptimizationMethod<TScenario, TArtifact> {
  return {
    name,
    async optimize(input) {
      const started = Date.now()
      if (typeof input.baselineSurface !== 'string') {
        throw new Error(`${name}: SkillOpt requires a string baselineSurface`)
      }
      const proposer = skillOptProposer({
        llm: config.llm,
        model: config.model,
        target: config.target,
      })
      const result = await runSkillOpt<TScenario, TArtifact>({
        ...input.runOptions,
        ...(config.runOptions ?? {}),
        baselineSurface: input.baselineSurface,
        dispatchWithSurface: input.dispatchWithSurface,
        judges: [...input.judges],
        proposer,
        trainScenarios: [...input.trainScenarios],
        selectionScenarios: [...input.selectionScenarios],
        maxEpochs: config.maxEpochs ?? 6,
        runDir: `${input.runDir}/loop`,
        seed: config.seed ?? input.seed,
      })
      return {
        winnerSurface: result.winnerSurface,
        cost: costFromLedgerSummary(result.cost),
        durationMs: Date.now() - started,
      }
    },
  }
}

export interface FapoOptimizationMethodConfig<TScenario extends Scenario, TArtifact>
  extends BuiltinOptimizationMethodConfig<TScenario, TArtifact> {
  /** Override the prompt-level proposer. Default: GEPA with Pareto parents. */
  promptProposer?: SurfaceProposer
  /** Parameter/config-level proposer. If omitted, `parameterCandidates` builds one. */
  parameterProposer?: SurfaceProposer
  /** Structural/code-level proposer, typically supplied by agent-runtime. */
  structuralProposer?: SurfaceProposer
  /** Convenience: build a parameter sweep from these candidates. */
  parameterCandidates?: readonly ParameterCandidate[]
  /** FAPO policy settings: scope, reviewer, and plateau thresholds. */
  fapo?: Omit<
    FapoProposerOptions,
    'proposers' | 'promptProposer' | 'parameterProposer' | 'structuralProposer'
  >
}

/** Build one method that runs the complete FAPO escalation policy. */
export function fapoEscalationMethod<TScenario extends Scenario, TArtifact>(
  config: FapoOptimizationMethodConfig<TScenario, TArtifact>,
  name = 'fapo-escalation',
): OptimizationMethod<TScenario, TArtifact> {
  return improvementLoopMethod(config, name, () => {
    const promptProposer =
      config.promptProposer ??
      gepaProposer({
        llm: config.llm,
        model: config.model,
        target: config.target,
        combineParents: true,
        ...(config.mutationPrimitives ? { mutationPrimitives: config.mutationPrimitives } : {}),
      })
    const parameterProposer =
      config.parameterProposer ??
      (config.parameterCandidates
        ? parameterSweepProposer({ candidates: config.parameterCandidates })
        : undefined)
    return fapoProposer({
      ...(config.fapo ?? {}),
      promptProposer,
      ...(parameterProposer ? { parameterProposer } : {}),
      ...(config.structuralProposer ? { structuralProposer: config.structuralProposer } : {}),
    })
  })
}

function improvementLoopMethod<TScenario extends Scenario, TArtifact>(
  config: BuiltinOptimizationMethodConfig<TScenario, TArtifact>,
  name: string,
  createProposer: () => SurfaceProposer,
): OptimizationMethod<TScenario, TArtifact> {
  return {
    name,
    async optimize(input) {
      const started = Date.now()
      const result = await runImprovementLoop<TScenario, TArtifact>({
        ...input.runOptions,
        ...(config.runOptions ?? {}),
        scenarios: [...input.trainScenarios],
        holdoutScenarios: [...input.selectionScenarios],
        baselineSurface: input.baselineSurface,
        dispatchWithSurface: input.dispatchWithSurface,
        judges: [...input.judges],
        proposer: createProposer(),
        populationSize: config.populationSize ?? 2,
        maxGenerations: config.maxGenerations ?? 3,
        gate: defaultProductionGate<TArtifact, TScenario>({
          holdoutScenarios: [...input.selectionScenarios],
          deltaThreshold: 0,
        }),
        autoOnPromote: 'none',
        runDir: `${input.runDir}/loop`,
        seed: config.seed ?? input.seed,
        ...(config.findings !== undefined ? { findings: config.findings } : {}),
        ...(config.analyzeGeneration ? { analyzeGeneration: config.analyzeGeneration } : {}),
        ...(config.report !== undefined ? { report: config.report } : {}),
      })
      return {
        winnerSurface:
          result.gateResult.decision === 'ship' ? result.winnerSurface : input.baselineSurface,
        cost: costFromLedgerSummary(result.cost),
        durationMs: Date.now() - started,
      }
    },
  }
}
