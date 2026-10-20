import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import type { CostChannel, CostLedgerHandle } from '../cost-ledger'
import { errorMessage as toErrorMessage } from '../errors'
import { assertServedModelPolicy, type ServedModelPolicy } from '../integrity/served-model'
import {
  assertExternalOptimizerModelBudget,
  type ExternalOptimizerModelBudget,
  type ExternalOptimizerModelCall,
  type ExternalOptimizerModelExecutionObservation,
  type ExternalOptimizerModelProxy,
  type ExternalOptimizerWireCounts,
} from './external-optimizer-contracts'
import {
  closeServer,
  listenLocal,
  sendJsonIfOpen,
  waitForActiveHandlers,
} from './external-optimizer-http'
import {
  ModelExecutionPersistenceError,
  type ModelProxyWire,
} from './external-optimizer-model-contract'
import { handleModelProxyRequest } from './external-optimizer-model-handler'

type ExternalOptimizerModelProxyArgs = {
  call: ExternalOptimizerModelCall
  callRef: string
  recordExecution: (observation: ExternalOptimizerModelExecutionObservation) => void
  model: string
  budget: ExternalOptimizerModelBudget
  /** Served-model acceptance for every proxied call. Default `'exact'`. */
  servedModelPolicy?: ServedModelPolicy
  costLedger: CostLedgerHandle
  phase: string
  actor: string
  /** Cost-ledger channel. Defaults to `optimizer`. */
  channel?: CostChannel
  tags?: Record<string, string>
  /** Deterministic ledger identity for a single-request proxy. */
  callId?: string
  /**
   * Also serve `POST /v1/messages` (Anthropic Messages API) for `claude` CLI
   * children. The route translates onto the same owner call and receipt
   * pipeline; without the flag it stays 404. Default: false.
   */
  anthropicEndpoint?: boolean
  initialUsage?: {
    requests: number
    /** Known billed subtotal. Omit when prior billed USD is unknown. */
    costUsd?: number
  }
  signal?: AbortSignal
}

/**
 * Put an OpenAI-compatible optimizer behind the shared cost ledger.
 *
 * The child process receives only a loopback URL and an ephemeral token. The
 * package that owns execution receives a validated immutable request through
 * `call`; Eval receives no provider credential. Every request reserves its
 * conservative byte-count input bound plus the declared output cap before the
 * owner is invoked exactly once.
 */
export async function startExternalOptimizerModelProxy(
  args: ExternalOptimizerModelProxyArgs,
): Promise<ExternalOptimizerModelProxy> {
  assertModelProxyConfig(args)
  args.signal?.throwIfAborted()
  const token = randomLocalToken()
  let requestCount = 0
  let successfulCompletionCount = 0
  const wireCounts: Record<ModelProxyWire, ExternalOptimizerWireCounts> = {
    openai: { requestAttempts: 0, successfulCompletions: 0 },
    anthropic: { requestAttempts: 0, successfulCompletions: 0 },
  }
  let modelCallInvocations = 0
  let executionRecordCount = 0
  let executionSequence = 0
  const failures: Error[] = []
  let totalRequestCount = args.initialUsage?.requests ?? 0
  let committedForBudget = args.initialUsage?.costUsd ?? 0
  let reservedForBudget = 0
  let accepting = true
  let closePromise: Promise<void> | undefined
  const activeControllers = new Set<AbortController>()
  const activeHandlers = new Set<Promise<void>>()

  const server = createServer((request, response) => {
    if (!accepting) {
      sendJsonIfOpen(response, 503, { error: 'external optimizer model proxy is closing' })
      return
    }

    const controller = new AbortController()
    const abortRequest = (): void => {
      request.destroy()
      response.destroy()
    }
    activeControllers.add(controller)
    controller.signal.addEventListener('abort', abortRequest, { once: true })

    let handler!: Promise<void>
    handler = handleModelProxyRequest({
      request,
      response,
      controller,
      token,
      args,
      nextReservation: (maximumCostUsd, wire) => {
        if (totalRequestCount >= args.budget.maxRequests) {
          return { accepted: false as const, reason: 'optimizer model request limit reached' }
        }
        if (
          args.budget.maxCostUsd !== undefined &&
          maximumCostUsd !== undefined &&
          committedForBudget + reservedForBudget + maximumCostUsd >
            args.budget.maxCostUsd + Number.EPSILON
        ) {
          return { accepted: false as const, reason: 'optimizer model cost limit reached' }
        }
        requestCount += 1
        wireCounts[wire].requestAttempts += 1
        totalRequestCount += 1
        reservedForBudget += maximumCostUsd ?? 0
        return { accepted: true as const }
      },
      settleReservation: (maximumCostUsd, chargedCostUsd) => {
        reservedForBudget = Math.max(0, reservedForBudget - (maximumCostUsd ?? 0))
        committedForBudget += chargedCostUsd ?? 0
      },
      recordSuccessfulCompletion: (wire) => {
        successfulCompletionCount += 1
        wireCounts[wire].successfulCompletions += 1
      },
      recordExecutionReceipt: (observation) => {
        try {
          args.recordExecution({ ...observation, sequence: executionSequence + 1 })
        } catch (error) {
          throw new ModelExecutionPersistenceError(
            `optimizer model execution evidence was not persisted: ${toErrorMessage(error)}`,
          )
        }
        executionSequence += 1
        executionRecordCount += 1
      },
      recordModelCallInvocation: () => {
        modelCallInvocations += 1
      },
      recordFailure: (error) => {
        failures.push(error)
      },
    }).finally(() => {
      controller.signal.removeEventListener('abort', abortRequest)
      activeControllers.delete(controller)
      activeHandlers.delete(handler)
    })
    activeHandlers.add(handler)
    void handler.catch(() => undefined)
  })
  const port = await listenLocal(server)
  const close = (): Promise<void> => {
    closePromise ??= closeModelProxy()
    return closePromise
  }
  const onAbort = (): void => {
    for (const controller of activeControllers) controller.abort(args.signal?.reason)
    void close().catch(() => undefined)
  }
  args.signal?.addEventListener('abort', onAbort, { once: true })
  if (args.signal?.aborted) onAbort()
  const assertExecutionComplete = (): void => {
    if (executionRecordCount !== modelCallInvocations) {
      throw new Error(
        `external optimizer model callback returned ${executionRecordCount} execution records for ${modelCallInvocations} invoked calls`,
      )
    }
  }
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    apiKey: token,
    requestAttempts: () => requestCount,
    successfulCompletions: () => successfulCompletionCount,
    wireUsage: () => ({
      openai: { ...wireCounts.openai },
      anthropic: { ...wireCounts.anthropic },
    }),
    assertExecutionComplete,
    failures: () => [...failures],
    close,
  }

  async function closeModelProxy(): Promise<void> {
    args.signal?.removeEventListener('abort', onAbort)
    accepting = false
    const closingServer = closeServer(server)
    server.closeIdleConnections?.()
    const [serverResult] = await Promise.allSettled([
      closingServer,
      waitForActiveHandlers(activeHandlers),
    ])
    if (activeControllers.size !== 0 || activeHandlers.size !== 0) {
      throw new Error('external optimizer model proxy closed with active request work')
    }
    let executionError: unknown
    try {
      assertExecutionComplete()
    } catch (error) {
      executionError = error
    }
    if (serverResult?.status === 'rejected' && executionError !== undefined) {
      throw new AggregateError(
        [serverResult.reason, executionError],
        'external optimizer model proxy close and execution evidence both failed',
      )
    }
    if (serverResult?.status === 'rejected') throw serverResult.reason
    if (executionError !== undefined) throw executionError
  }
}

function assertModelProxyConfig(args: {
  call: ExternalOptimizerModelCall
  callRef: string
  recordExecution: (observation: ExternalOptimizerModelExecutionObservation) => void
  model: string
  budget: ExternalOptimizerModelBudget
  servedModelPolicy?: ServedModelPolicy
  phase: string
  actor: string
  tags?: Record<string, string>
  callId?: string
  initialUsage?: {
    requests: number
    costUsd?: number
  }
}): void {
  assertServedModelPolicy(
    args.servedModelPolicy,
    'external optimizer model proxy: servedModelPolicy',
  )
  for (const [label, value] of [
    ['model', args.model],
    ['phase', args.phase],
    ['actor', args.actor],
  ] as const) {
    if (typeof value !== 'string' || !value.trim() || value.trim() !== value) {
      throw new Error(`external optimizer model proxy: ${label} must be trimmed and non-empty`)
    }
  }
  if (typeof args.call !== 'function') {
    throw new Error('external optimizer model proxy: call must be a function')
  }
  if (
    typeof args.callRef !== 'string' ||
    !args.callRef.trim() ||
    args.callRef.trim() !== args.callRef
  ) {
    throw new Error('external optimizer model proxy: callRef must be trimmed and non-empty')
  }
  if (typeof args.recordExecution !== 'function') {
    throw new Error('external optimizer model proxy: recordExecution must be a function')
  }
  if (args.callId !== undefined) {
    if (
      typeof args.callId !== 'string' ||
      !args.callId.trim() ||
      args.callId !== args.callId.trim()
    ) {
      throw new Error('external optimizer model proxy: callId must be trimmed and non-empty')
    }
    if (args.budget.maxRequests !== 1) {
      throw new Error('external optimizer model proxy: callId requires budget.maxRequests to be 1')
    }
  }
  assertExternalOptimizerModelBudget(args.budget, 'external optimizer model proxy: budget')
  if (args.tags !== undefined) {
    for (const [key, value] of Object.entries(args.tags)) {
      if (!key.trim() || key.trim() !== key || !value.trim() || value.trim() !== value) {
        throw new Error('external optimizer model proxy: tags must be trimmed and non-empty')
      }
    }
  }
  if (args.initialUsage !== undefined) {
    if (
      !Number.isSafeInteger(args.initialUsage.requests) ||
      args.initialUsage.requests < 0 ||
      (args.initialUsage.costUsd !== undefined &&
        (!Number.isFinite(args.initialUsage.costUsd) || args.initialUsage.costUsd < 0))
    ) {
      throw new Error(
        'external optimizer model proxy: initialUsage must contain non-negative requests and cost',
      )
    }
    if (
      args.initialUsage.requests > args.budget.maxRequests ||
      (args.budget.maxCostUsd !== undefined &&
        args.initialUsage.costUsd !== undefined &&
        args.initialUsage.costUsd > args.budget.maxCostUsd + Number.EPSILON)
    ) {
      throw new Error('external optimizer model proxy: initialUsage exceeds the configured budget')
    }
  }
}

function randomLocalToken(): string {
  return randomBytes(32).toString('hex')
}
