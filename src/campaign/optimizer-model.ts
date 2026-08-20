import { assertServedModelPolicy, type ServedModelPolicy } from '../integrity/served-model'
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
  /**
   * Served-model acceptance for every proxied call. Default `'exact'`, which
   * rejects any substitution with a 502 to the child.
   * `'allow-within-family'` accepts a different model of the same provider
   * family; it keeps family-level claims valid and forfeits per-model claims.
   */
  servedModelPolicy?: ServedModelPolicy
  /**
   * Also expose this metered model over the Anthropic Messages API
   * (`POST /v1/messages`) on the loopback proxy. Required for GEPA agent
   * engines that drive a `claude` CLI subprocess. Agent engines are chatty:
   * size `budget.maxRequests` for tens of calls per engine run. Default: false.
   */
  anthropicEndpoint?: boolean
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
  assertServedModelPolicy(value.servedModelPolicy, `${label}.servedModelPolicy`)
  if (value.anthropicEndpoint !== undefined && typeof value.anthropicEndpoint !== 'boolean') {
    throw new Error(`${label}.anthropicEndpoint must be a boolean`)
  }
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
    ...(value.servedModelPolicy ? { servedModelPolicy: value.servedModelPolicy } : {}),
    ...(value.anthropicEndpoint === undefined
      ? {}
      : { anthropicEndpoint: value.anthropicEndpoint }),
  }
}
