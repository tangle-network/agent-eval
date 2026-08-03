import {
  assertExternalOptimizerModelBudget,
  type ExternalOptimizerModelBudget,
  type ExternalOptimizerModelCall,
} from './external-optimizer-process'

export type OptimizerModelBudget = ExternalOptimizerModelBudget

/** One metered model path supplied by the package that owns execution. */
export interface OpenAICompatibleOptimizerModel {
  model: string
  budget: OptimizerModelBudget
  /** Caller-owned execution path, such as Runtime's exact AgentProfile adapter. */
  call: ExternalOptimizerModelCall
  /** Stable public identity included in resumable-run compatibility. */
  callRef: string
}

export function assertOptimizerModel(value: OpenAICompatibleOptimizerModel, label: string): void {
  if (!value || typeof value !== 'object') {
    throw new Error(`${label} is required`)
  }
  for (const [field, item] of [
    ['model', value.model],
    ['callRef', value.callRef],
  ] as const) {
    if (typeof item !== 'string' || !item.trim() || item.trim() !== item) {
      throw new Error(`${label}.${field} must be trimmed and non-empty`)
    }
  }
  if (typeof value.call !== 'function') throw new Error(`${label}.call must be a function`)
  assertExternalOptimizerModelBudget(value.budget, `${label}.budget`)
}

export function snapshotOptimizerModel(
  value: OpenAICompatibleOptimizerModel,
): OpenAICompatibleOptimizerModel {
  return {
    model: value.model,
    budget: structuredClone(value.budget),
    call: value.call,
    callRef: value.callRef,
  }
}
