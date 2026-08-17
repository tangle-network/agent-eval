import type { Scenario } from '../types'
import {
  assertCompleteOptimizationHistory,
  type OptimizationHistoryReceipt,
  verifyOptimizationHistoryReceipt,
} from '../optimization-history'
import {
  compareOptimizationMethods,
  type CompareOptimizationMethodsOptions,
  type OptimizationMethod,
  type OptimizationMethodComparison,
  type OptimizationMethodInput,
  type OptimizationMethodResult,
} from './compare-optimization-methods'

export type OptimizationHistoryPolicy = 'allow-missing' | 'require-complete'

export interface HistoryAwareOptimizationMethodResult extends OptimizationMethodResult {
  /** Content-addressed index over the canonical search ledger for this run. */
  history?: OptimizationHistoryReceipt
}

export interface HistoryAwareOptimizationMethod<
  TScenario extends Scenario = Scenario,
  TArtifact = unknown,
> extends Omit<OptimizationMethod<TScenario, TArtifact>, 'optimize'> {
  optimize(
    input: OptimizationMethodInput<TScenario, TArtifact>,
  ): Promise<HistoryAwareOptimizationMethodResult>
}

export interface OptimizationMethodHistoryCoverage {
  readonly methodName: string
  readonly status: 'complete' | 'incomplete' | 'missing'
  readonly reasons: readonly string[]
  readonly receipt?: OptimizationHistoryReceipt
}

export interface OptimizationHistoryCoverage {
  readonly policy: OptimizationHistoryPolicy
  readonly allComplete: boolean
  readonly methods: readonly OptimizationMethodHistoryCoverage[]
}

export interface OptimizationMethodComparisonWithHistory extends OptimizationMethodComparison {
  /** Complete history coverage in the same method order supplied by the caller. */
  readonly optimizationHistory: OptimizationHistoryCoverage
}

export interface CompareOptimizationMethodsWithHistoryOptions<
  TScenario extends Scenario,
  TArtifact,
> extends Omit<CompareOptimizationMethodsOptions<TScenario, TArtifact>, 'methods'> {
  methods: HistoryAwareOptimizationMethod<TScenario, TArtifact>[]
  /**
   * `allow-missing` preserves the original comparison behavior while reporting
   * coverage. `require-complete` refuses before final-test scoring unless every
   * method returns a terminal, denominator-complete search history receipt.
   */
  historyPolicy?: OptimizationHistoryPolicy
}

/**
 * Compare methods through the existing untouched-test engine while retaining
 * and optionally requiring each method's complete canonical search history.
 *
 * This is additive: `compareOptimizationMethods()` remains unchanged. The
 * wrapper intercepts only method results, verifies their receipts, strips the
 * additional field before delegating, and joins coverage back onto the result.
 */
export async function compareOptimizationMethodsWithHistory<
  TScenario extends Scenario,
  TArtifact,
>(
  options: CompareOptimizationMethodsWithHistoryOptions<TScenario, TArtifact>,
): Promise<OptimizationMethodComparisonWithHistory> {
  const historyPolicy = options.historyPolicy ?? 'allow-missing'
  if (historyPolicy !== 'allow-missing' && historyPolicy !== 'require-complete') {
    throw new TypeError(`unknown optimization history policy '${String(historyPolicy)}'`)
  }

  const observed = new Map<string, OptimizationMethodHistoryCoverage>()
  const wrappedMethods: OptimizationMethod<TScenario, TArtifact>[] = options.methods.map(
    (method) => ({
      name: method.name,
      async optimize(input) {
        const { history, ...result } = await method.optimize(input)
        let coverage: OptimizationMethodHistoryCoverage
        if (history === undefined) {
          coverage = Object.freeze({
            methodName: method.name,
            status: 'missing',
            reasons: Object.freeze(['history receipt is missing']),
          })
        } else {
          verifyOptimizationHistoryReceipt(history)
          if (history.methodName !== method.name) {
            throw new Error(
              `optimization history for method '${method.name}' belongs to '${history.methodName}'`,
            )
          }
          coverage = Object.freeze({
            methodName: method.name,
            status: history.historyComplete ? 'complete' : 'incomplete',
            reasons: Object.freeze([...history.incompleteReasons]),
            receipt: history,
          })
        }
        observed.set(method.name, coverage)
        if (historyPolicy === 'require-complete') {
          assertCompleteOptimizationHistory(method.name, history)
        }
        return result
      },
    }),
  )

  const { methods: _methods, historyPolicy: _historyPolicy, ...comparisonOptions } = options
  const comparison = await compareOptimizationMethods({
    ...comparisonOptions,
    methods: wrappedMethods,
  })
  const methods = Object.freeze(
    options.methods.map(
      (method) =>
        observed.get(method.name) ??
        Object.freeze({
          methodName: method.name,
          status: 'missing' as const,
          reasons: Object.freeze(['method completed without an observed history result']),
        }),
    ),
  )
  return {
    ...comparison,
    optimizationHistory: Object.freeze({
      policy: historyPolicy,
      allComplete: methods.every((method) => method.status === 'complete'),
      methods,
    }),
  }
}
