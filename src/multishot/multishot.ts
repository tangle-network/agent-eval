// Multi-turn driver-agent simulation with inline tool execution.
//
// The driver = LLM acting as the persona (reactive, non-deterministic).
// The agent = the product agent under test, executed by the caller-supplied
// transport with the profile's systemPrompt + the configured tools.
// Tool calls execute inline via the configured executors and feed back
// into the agent's message log so the agent integrates the result.
//
// agent-eval owns no model transport: every leg runs on a MultishotTransport
// the caller supplies, so no provider credential enters this package.

import type { AgentProfile } from '@tangle-network/agent-interface'
import { runMultishotConversation } from './conversation'
import type {
  MultishotPersona,
  MultishotResult,
  MultishotShape,
  MultishotToolDefinition,
  MultishotToolExecutor,
  MultishotTransport,
} from './types'

export interface RunMultishotOptions<TPersona extends MultishotPersona> {
  profile: AgentProfile
  persona: TPersona
  /** Persona-shaping callbacks. Optional — omitted callbacks are derived from
   *  the profile + persona payload, so a pure-profile call works. */
  shape?: MultishotShape<TPersona>
  /** Tool definitions advertised to the agent. Defaults to delegate_research + delegate_code. */
  tools?: MultishotToolDefinition[]
  /** Map from tool name → executor invoked inline when the agent emits a tool_call. */
  toolExecutors?: Record<string, MultishotToolExecutor>
  /** Map from tool name → artifact type label written into MultishotArtifact.type.
   *  Tools without a mapping still execute, but their results aren't surfaced as
   *  typed artifacts (only as tool messages in the transcript). */
  artifactTypeFor?: (toolName: string) => string | undefined
  maxTurns?: number
  agentModel?: string
  driverModel?: string
  /** Fallback driver models tried when the primary simulated-user model returns empty twice. */
  driverFallbackModels?: string[]
  /** Maximum output tokens for the first agent call in each assistant turn. */
  agentMaxTokens?: number
  /** Maximum output tokens for agent follow-up calls after tool results. */
  toolFollowupMaxTokens?: number
  /** Maximum output tokens for each simulated-user driver response. */
  driverMaxTokens?: number
  /** Maximum tool calls the agent may dispatch inside one assistant turn. */
  maxToolDispatches?: number
  /** Caller-owned execution for the agent leg. Every agent inference step
   *  runs through this function; `agentModel` names the model it receives. */
  agentTransport: MultishotTransport
  /** Caller-owned execution for the simulated-user driver leg. Driver model
   *  fallback rotation still applies — the transport receives each candidate
   *  model in turn. */
  driverTransport: MultishotTransport
  /** Caller-owned execution for the specialist leg the tool executors run.
   *  Defaults to `agentTransport`. */
  toolTransport?: MultishotTransport
  signal?: AbortSignal
}

/** One multishot shot — the conversation engine `runMultishotMatrix` invokes
 *  once per cell. `runMultishot` is the default implementation.
 *
 *  An alternative engine (a graph-backed conversation, a replay of a recorded
 *  transcript, a sandbox-hosted agent) implements this exact signature and
 *  reaches the matrix through `RunMultishotMatrixOptions.runShot`. The matrix
 *  keeps every other cell mechanic — cell fan-out, concurrency, the cost
 *  ceiling, the judge slots, the cell composite, and the per-cell writers — so
 *  swapping the engine needs no copy of the cell body. */
export type MultishotShot<TPersona extends MultishotPersona> = (
  opts: RunMultishotOptions<TPersona>,
) => Promise<MultishotResult>

/** The package's reference conversation engine, and the referent of three
 *  things that stop working without it.
 *
 *  1. `runMultishotMatrix` runs it as the per-cell engine when the caller names
 *     no `runShot`, so the matrix always has an engine to run.
 *  2. `golden.test.ts` proves the frozen records against it on every run, and
 *     perturbs it to prove the records detect a change. Records checked only
 *     against a replay of themselves prove nothing.
 *  3. The repo's recording command names it as `--engine`. The script defaults
 *     no engine, so a version records whichever one the caller names — and a
 *     record set minted from a consumer's engine would let a product's wiring
 *     define this package's frozen contract.
 *
 *  An alternative engine reaches the matrix through `runShot` and reaches the
 *  records through `assertMultishotGoldenScenario`. Neither seam removes the
 *  three roles above. */
export async function runMultishot<TPersona extends MultishotPersona>(
  opts: RunMultishotOptions<TPersona>,
): Promise<MultishotResult> {
  return runMultishotConversation(opts, async (conversation) => {
    for (let turn = 0; turn < conversation.maxTurns; turn++) {
      await conversation.agentTurn(turn)
      if (turn < conversation.maxTurns - 1) await conversation.driverTurn(turn)
    }
  })
}
