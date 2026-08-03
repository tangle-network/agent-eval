import type { ExternalOptimizerModelCall } from '../../src/campaign'

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
 * Load the caller's execution owner without teaching Agent Eval about provider
 * credentials. Discovery supplies a module backed by Runtime and an exact
 * AgentProfile; other products may supply their own execution package.
 */
export async function loadOptimizerExecutionOwner(
  model: string,
): Promise<OptimizerExecutionOwner> {
  const moduleSpecifier = process.env.OPTIMIZER_EXECUTION_OWNER_MODULE?.trim()
  if (!moduleSpecifier) {
    throw new Error(
      'Set OPTIMIZER_EXECUTION_OWNER_MODULE to a module exporting createOptimizerExecutionOwner(model).',
    )
  }
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
