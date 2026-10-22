import type {
  ExternalOptimizerCallbackLimits,
  ExternalOptimizerResumeMode,
  ExternalOptimizerRunnerCommand,
} from './external-optimizer-process'
import {
  assertGepaOptimizationConfig,
  defaultGepaMethodName,
  snapshotGepaOptimizationConfig,
} from './gepa-optimization-config'
import {
  buildGepaOutcome,
  gepaCosts,
  prepareGepaRun,
  recordGepaSearchHistory,
  runBridge,
  verifyBridgeResult,
} from './gepa-optimization-run'
import type { OptimizationMethod } from './optimization-method'
import type { OpenAICompatibleOptimizerModel } from './optimizer-model'
import type { SearchRunIdentity } from './search-ledger-recording'
import type { Scenario } from './types'

/** Shared settings for one bounded GEPA engine invocation. */
export interface GepaEngineOptions {
  /** GEPA engine name. GEPA validates names available in its Python runtime. */
  engine: string
  /** Optional billed-USD stop. Omit when the execution owner reports USD as unknown. */
  maxProposerCostUsd?: number
  /** Maximum concurrent evaluations inside this engine. Default: 1. */
  maxConcurrency?: number
  /** Stop the engine after it reaches this score. */
  stopAtScore?: number
  /** Isolate agent-based engines. Default: true. */
  sandbox?: boolean
  /**
   * JSON-safe configuration for the registered GEPA engine.
   * Python callables and class instances cannot cross the process boundary.
   */
  engineConfig?: Record<string, unknown>
}

/** One independently budgeted GEPA engine invocation. */
export interface GepaEngineRun extends GepaEngineOptions {
  /** Maximum callback evaluations this engine may consume. */
  maxEvaluations: number
}

/** An engine in an adaptive run. All engines share the recipe evaluation limit. */
export type GepaAdaptiveEngineRun = GepaEngineOptions

/**
 * A direct mapping to a GEPA optimization recipe.
 *
 * GEPA owns every search and composition operation represented here. Tangle
 * supplies the candidate, data, execution callback, judges, and budgets.
 */
export type GepaOptimizationRecipe =
  | {
      kind: 'engine'
      run: GepaEngineRun
    }
  | {
      kind: 'sequential'
      runs: readonly GepaEngineRun[]
    }
  | {
      kind: 'adaptive-sequential'
      runs: readonly GepaAdaptiveEngineRun[]
      /** One evaluation budget shared by every adaptive stage. */
      maxEvaluations: number
      /** Switch engines after this many evaluations without improvement. */
      plateauEvaluations: number
      patience?: number
      minEvaluationsPerStage?: number
      improvementEpsilon?: number
      cycle?: boolean
      maxSwitches?: number
      maxConcurrency?: number
    }
  | {
      kind: 'best-of'
      runs: readonly GepaEngineRun[]
      maxWorkers?: number
    }
  | {
      kind: 'vote'
      runs: readonly GepaEngineRun[]
      maxWorkers?: number
    }
  | {
      kind: 'omni'
      explore: readonly GepaEngineRun[]
      continueWith: GepaEngineRun
      maxWorkers?: number
    }

/** The command that runs the Python GEPA bridge. */
export type GepaRunnerCommand = ExternalOptimizerRunnerCommand

export interface GepaOptimizationMethodConfig<TScenario extends Scenario, TArtifact = unknown> {
  /** Unique comparison-method name. Default identifies the GEPA recipe. */
  name?: string
  /** A direct GEPA recipe. */
  recipe: GepaOptimizationRecipe
  /** Plain-language goal shown to the external optimizer. */
  objective: string
  /** Stable identity for the dispatch, judges, model settings, and scoring logic. */
  evaluationId: string
  /** Optional bounded context about the surface and task. */
  background?: string
  /**
   * Public dotted Python modules imported before GEPA resolves engine names.
   * Each module should call GEPA's official `register_engine()` API at import.
   */
  engineModules?: readonly string[]
  /** Reject external candidates longer than this. Default: 200,000 characters. */
  maxCandidateChars?: number
  /** Reject serialized score evidence longer than this. Default: 100,000 characters. */
  maxEvidenceChars?: number
  /** Candidate-evaluation callback byte limits. Omitted fields use finite defaults. */
  evaluationCallbackLimits?: Partial<ExternalOptimizerCallbackLimits>
  /** End the bridge process after this many milliseconds. Default: 30 minutes. */
  timeoutMs?: number
  /**
   * OpenAI-compatible model used by standard GEPA reflection.
   * Calls pass through Agent Eval's local model proxy. Every recipe engine must
   * be `gepa` when this is set.
   */
  optimizer?: OpenAICompatibleOptimizerModel
  /**
   * Decide what the external optimizer may read for a train or selection case.
   * The returned value must be JSON-serializable. The final comparison cases
   * are not accepted by this API and cannot be serialized here.
   */
  describeScenario?: (scenario: TScenario) => unknown
  /** Optional bounded artifact evidence returned to GEPA after each evaluation. */
  describeArtifact?: (artifact: TArtifact, scenario: TScenario) => unknown
  /** Default: `never`. Compatible runs resume only when explicitly enabled. */
  resume?: ExternalOptimizerResumeMode
  /**
   * Required for resumable direct GEPA runs because upstream state uses Python
   * pickle. Enable only for state created locally in a directory you control.
   */
  trustResumeState?: boolean
  runner?: GepaRunnerCommand
  /**
   * Record GEPA's search into a search ledger and return the bounded receipt
   * on the method result, so a comparison under `searchHistoryPolicy:
   * 'require-complete'` accepts this method. The population becomes nodes and
   * `correlated` edges, and every callback evaluation becomes a cell.
   *
   * `identity` declares the immutable revisions and the model the ledger
   * requires and the bridge does not report. `path` defaults to
   * `<runDir>/search-ledger.jsonl`.
   */
  searchLedger?: { identity: SearchRunIdentity; path?: string }
}

/**
 * Turn an optional GEPA installation into an `OptimizationMethod`.
 *
 * GEPA receives only serialized train and selection cases. The caller's final
 * test partition stays inside `compareOptimizationMethods`, which invokes this
 * method without a test-set field. The local callback routes every candidate
 * evaluation through the same dispatch and judges used by other methods.
 */
/**
 * Environment for a bridge child that spawns `claude` CLI subprocesses.
 *
 * Both agent CLI engines start the CLI with the bridge's own environment, so
 * these variables travel bridge → engine → CLI. They merge AFTER
 * `removeCredentialEnvironment`: the ephemeral loopback token is the only
 * credential the child may see, and a caller-supplied ANTHROPIC_AUTH_TOKEN is
 * stripped like any other credential.
 */

export function gepaOptimizationMethod<TScenario extends Scenario, TArtifact>(
  config: GepaOptimizationMethodConfig<TScenario, TArtifact>,
): OptimizationMethod<TScenario, TArtifact> {
  assertGepaOptimizationConfig(config)
  config = snapshotGepaOptimizationConfig(config)
  const name = config.name ?? defaultGepaMethodName(config.recipe)

  return {
    name,
    async optimize(input) {
      const ctx = await prepareGepaRun(config, input, name)
      const { result, outputDir, modelProxy } = await runBridge(ctx)
      const population = verifyBridgeResult(ctx, result)
      const searchHistory = await recordGepaSearchHistory(ctx, result, population)
      const costs = gepaCosts(ctx, result, modelProxy)
      return buildGepaOutcome(ctx, result, outputDir, modelProxy, searchHistory, costs)
    },
  }
}
