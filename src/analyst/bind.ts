/**
 * bindAnalyst — compile an `AnalystDefinition` into a runnable arm.
 *
 * The definition declares protocol (question, task text, reply grammar,
 * evidence projection, budget, repair turns); the transport binding supplies
 * execution (a bridge endpoint, or the caller-owned model path). Each
 * projection mode dispatches to the same strategy its arm's entry point runs,
 * so a compiled definition and the historical creator send byte-identical
 * requests — the definition parity suite asserts this per arm.
 *
 * A projection × transport pair with no strategy fails loud with
 * `AnalystExpressivenessError` naming the pair: an arm shape this layer cannot
 * express must be reported, never approximated.
 */

import type { CustomTokenPricing } from '../cost-ledger'
import type { AnalystBenchmarkRunner } from './benchmark'
import { runChunkedAnalystDefinition } from './benchmark-public-model'
import { runReplVariableAnalystDefinition } from './benchmark-public-rlm'
import type { PublicAnalystBenchmarkModelConfig } from './benchmark-public-types'
import { runInlineAnalystDefinition } from './benchmark-runner-prime'
import { type AnalystDefinition, AnalystExpressivenessError } from './definition'
import type { PrimeBridgeTransport } from './prime-bridge-transport'
import type { AnalystRunInputs } from './types'

/** Execution half of a binding: who actually reaches the model. */
export type AnalystTransportBinding =
  | {
      /** An OpenAI-compatible cli-bridge endpoint (inline projections). */
      readonly kind: 'prime-bridge'
      readonly baseUrl: string
      readonly model: string
      readonly transport?: PrimeBridgeTransport
      readonly pricing?: CustomTokenPricing
    }
  | {
      /** The caller-owned model path (chunked and repl-variable projections). */
      readonly kind: 'model-owner'
      readonly config: PublicAnalystBenchmarkModelConfig
    }

/**
 * Compile a definition plus a transport binding into a runnable arm. Dispatch
 * is total over the expressible pairs; everything else is a loud refusal.
 */
export function bindAnalyst<TRow, TAssignment, TBlock>(
  definition: AnalystDefinition<TRow, TAssignment, TBlock>,
  transports: AnalystTransportBinding,
): AnalystBenchmarkRunner<AnalystRunInputs> {
  const mode = definition.projection.mode
  if (mode === 'inline' && transports.kind === 'prime-bridge') {
    return runInlineAnalystDefinition(definition, {
      baseUrl: transports.baseUrl,
      model: transports.model,
      ...(transports.transport ? { transport: transports.transport } : {}),
      ...(transports.pricing ? { pricing: transports.pricing } : {}),
    })
  }
  if (mode === 'chunked' && transports.kind === 'model-owner') {
    return runChunkedAnalystDefinition(definition, transports.config)
  }
  if (mode === 'repl-variable' && transports.kind === 'model-owner') {
    return runReplVariableAnalystDefinition(
      // The repl-variable strategy is written against the engine's raw-finding
      // row type; the definition's own row declaration carries it.
      definition as Parameters<typeof runReplVariableAnalystDefinition>[0],
      transports.config,
    )
  }
  throw new AnalystExpressivenessError(
    `no strategy compiles a '${mode}' projection over a '${transports.kind}' transport; ` +
      `definition '${definition.id}' cannot be expressed by this layer yet`,
  )
}
