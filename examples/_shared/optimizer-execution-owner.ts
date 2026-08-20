import {
  createOpenAiCompatibleExecutionOwner,
  type ExternalOptimizerModelCall,
} from '../../src/campaign'
import type { CustomTokenPricing } from '../../src/cost-ledger'
import { optionalNonNegativeNumberEnv } from './env'

export interface OptimizerExecutionOwner {
  /** Stable public identity for the exact execution configuration. */
  callRef: string
  /** Model request executed by the package that owns execution. */
  call: ExternalOptimizerModelCall
}

interface OptimizerExecutionOwnerModule {
  createOptimizerExecutionOwner?: (
    model: string,
  ) => OptimizerExecutionOwner | Promise<OptimizerExecutionOwner>
}

/**
 * Resolve the execution owner for optimizer-model calls.
 *
 * `OPTIMIZER_EXECUTION_OWNER_MODULE` selects a caller-owned execution package;
 * Discovery supplies a module backed by Runtime and an exact AgentProfile.
 * When it is unset, the owner is the package's OpenAI-compatible transport,
 * built from the `LLM_BASE_URL` and `LLM_API_KEY` the examples already use.
 * Optional `PRICE_IN_PER_M` and `PRICE_OUT_PER_M` supply cost estimates when
 * the endpoint omits billed cost.
 */
export async function loadOptimizerExecutionOwner(
  model: string,
): Promise<OptimizerExecutionOwner> {
  const moduleSpecifier = process.env.OPTIMIZER_EXECUTION_OWNER_MODULE?.trim()
  if (!moduleSpecifier) return defaultExecutionOwner(model)
  const loaded = (await import(moduleSpecifier)) as OptimizerExecutionOwnerModule
  if (typeof loaded.createOptimizerExecutionOwner !== 'function') {
    throw new Error(
      'OPTIMIZER_EXECUTION_OWNER_MODULE must export createOptimizerExecutionOwner(model).',
    )
  }
  const owner = await loaded.createOptimizerExecutionOwner(model)
  if (
    !owner ||
    typeof owner !== 'object' ||
    typeof owner.call !== 'function' ||
    typeof owner.callRef !== 'string' ||
    !owner.callRef.trim() ||
    owner.callRef.trim() !== owner.callRef
  ) {
    throw new Error('createOptimizerExecutionOwner(model) returned an invalid execution owner.')
  }
  return owner
}

function defaultExecutionOwner(model: string): OptimizerExecutionOwner {
  const baseUrl = (process.env.LLM_BASE_URL || process.env.TANGLE_ROUTER_URL || '').trim()
  const apiKey = (process.env.LLM_API_KEY || process.env.TANGLE_API_KEY || '').trim()
  const missing = [
    ...(baseUrl ? [] : ['LLM_BASE_URL (or TANGLE_ROUTER_URL)']),
    ...(apiKey ? [] : ['LLM_API_KEY (or TANGLE_API_KEY)']),
  ]
  if (missing.length > 0) {
    throw new Error(
      `The default optimizer execution owner requires: ${missing.join(', ')}. ` +
        'Set them, or set OPTIMIZER_EXECUTION_OWNER_MODULE to a module exporting createOptimizerExecutionOwner(model).',
    )
  }
  const inputUsdPerMillion = optionalNonNegativeNumberEnv('PRICE_IN_PER_M')
  const outputUsdPerMillion = optionalNonNegativeNumberEnv('PRICE_OUT_PER_M')
  const cachedInputUsdPerMillion = optionalNonNegativeNumberEnv('PRICE_CACHED_IN_PER_M')
  const cacheWriteUsdPerMillion = optionalNonNegativeNumberEnv('PRICE_CACHE_WRITE_IN_PER_M')
  const pricing: CustomTokenPricing | undefined =
    inputUsdPerMillion === undefined || outputUsdPerMillion === undefined
      ? undefined
      : {
          inputUsdPerMillion,
          ...(cachedInputUsdPerMillion === undefined ? {} : { cachedInputUsdPerMillion }),
          ...(cacheWriteUsdPerMillion === undefined ? {} : { cacheWriteUsdPerMillion }),
          outputUsdPerMillion,
        }
  return {
    callRef: `openai-compatible:${baseUrl}:${model}`,
    call: createOpenAiCompatibleExecutionOwner({
      baseUrl,
      apiKey,
      model,
      ...(pricing ? { pricing } : {}),
    }),
  }
}
