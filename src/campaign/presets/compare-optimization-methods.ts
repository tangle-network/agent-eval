/**
 * Compare optimization methods on shared train, selection, and test data.
 * Optimizers receive only train and selection data. After every optimizer
 * finishes, their selected surfaces are measured on the same untouched test
 * data and compared with paired confidence intervals.
 */

export {
  type ComparisonCost,
  combineComparisonCosts,
  costFromLedgerSummary,
  type OptimizationTokenUsage,
  optimizationTokenUsageFromSummary,
} from '../optimization-cost'
export { assertOptimizationResult } from '../optimization-method'
export { compareOptimizationMethods } from './optimization-method-comparison'
export type {
  CompareOptimizationMethodsOptions,
  OptimizationMethod,
  OptimizationMethodComparison,
  OptimizationMethodComposition,
  OptimizationMethodInput,
  OptimizationMethodPairwise,
  OptimizationMethodProvenance,
  OptimizationMethodResult,
  OptimizationMethodRunOptions,
  OptimizationMethodScore,
  OptimizationModuleSource,
  OptimizationPackageSource,
  OptimizationPythonRuntime,
} from './optimization-method-types'
