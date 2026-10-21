/** Public paid-call, receipt, persistence, and reporting contracts. */
import type { CostLedger } from '../cost-ledger'

export type CostChannel = 'agent' | 'judge' | 'verifier' | 'analyst' | 'driver' | (string & {})

/** How a USD amount was obtained. */
export type CostProvenance =
  | { kind: 'observed'; usd: number }
  | { kind: 'estimated'; usd: number }
  | { kind: 'uncaptured'; usd: null }

/** Separate units and evidence for a matrix cell; credits are never USD. */
export interface CostBreakdown {
  router: CostProvenance
  sandbox: CostProvenance
  /** Standard model credits, before time-of-day discounts or MCP charges. */
  seatCredits:
    | { kind: 'estimated'; credits: number }
    | { kind: 'uncaptured'; credits: null; reason: string }
  /** Live source snapshots used by the estimates; never a package rate table. */
  sources: Array<{
    url: string
    readAt: string
    sha256: string
    rates: Record<string, number>
  }>
}

export interface CostUsage {
  inputTokens: number
  /** Includes reasoning tokens when the provider bills them as output. */
  outputTokens: number
  /** Reasoning-token subset of outputTokens, when reported. */
  reasoningTokens?: number
  /** Prompt tokens served from a provider cache. */
  cachedTokens?: number
  /** Prompt tokens written into a provider cache. */
  cacheWriteTokens?: number
}

export interface CostCallBase {
  callId: string
  channel: CostChannel
  phase: string
  actor: string
  model: string
  maximumCostUsd?: number
  tags?: Record<string, string>
  timestamp: number
}

export interface PendingCostCall extends CostCallBase {
  status: 'pending'
}

export interface PendingCostCallView extends PendingCostCall {
  state: 'active' | 'late' | 'interrupted'
}

export interface CostReceipt extends CostCallBase, CostUsage {
  costBreakdown?: CostBreakdown
  status: 'settled'
  costUsd: number
  costUnknown: boolean
  usageUnknown?: boolean
  /** Rates used to estimate cost locally. Absent when cost is provider-reported or unknown. */
  pricing?: {
    inputUsdPerThousand: number
    cachedInputUsdPerThousand?: number
    cacheWriteUsdPerThousand?: number
    outputUsdPerThousand: number
  }
  /** Cost reported by the provider, not a local token-price calculation. */
  actualCostUsd?: number
  /** Known non-provider amount supplied by an external executor. */
  estimatedCostUsd?: number
  /** Why the call failed. `'paid-call-failed'` is the ledger's own value for
   * recovery settles; a reconciling caller may record its own reason. */
  error?: string
}

export type CostLedgerRecord = PendingCostCall | CostReceipt

export interface CostReceiptInput extends CostUsage {
  costBreakdown?: CostBreakdown
  model: string
  /** Caller-supplied rates for a local estimate when the provider does not report billed cost. */
  customTokenPricing?: CustomTokenPricing
  actualCostUsd?: number
  /** A known estimate from an external executor that cannot provide token pricing. */
  estimatedCostUsd?: number
  costUnknown?: boolean
  usageUnknown?: boolean
}

/** Per-million token rates for a model or endpoint not covered by package pricing. */
export interface CustomTokenPricing {
  /** Non-cached input tokens. */
  inputUsdPerMillion: number
  /** Cache-read tokens. Falls back to the normal input rate when omitted. */
  cachedInputUsdPerMillion?: number
  /** Cache-creation or cache-write tokens. Falls back to the normal input rate when omitted. */
  cacheWriteUsdPerMillion?: number
  outputUsdPerMillion: number
}

export type MaximumCharge =
  | { externallyEnforcedMaximumUsd: number }
  | ({
      customTokenPricing: CustomTokenPricing
    } & Pick<CostUsage, 'inputTokens' | 'outputTokens' | 'cachedTokens' | 'cacheWriteTokens'>)
  | ({ model: string } & CostUsage)

export interface RunPaidCallInput<T> {
  callId?: string
  channel: CostChannel
  phase: string
  actor: string
  /** Used before a provider receipt exists and on failures without one. */
  model?: string
  tags?: Record<string, string>
  signal?: AbortSignal
  /** Provider-enforced dollar maximum, or maximum token usage with known pricing. Required when capped. */
  maximumCharge?: MaximumCharge
  /** `callId` can be forwarded as the provider's idempotency key. */
  execute(signal: AbortSignal, callId: string): Promise<T>
  receipt(value: T): CostReceiptInput
  receiptFromError?(error: Error): CostReceiptInput | undefined
}

export type PaidCallResult<T> =
  | { succeeded: true; callId: string; value: T; receipt: CostReceipt }
  | { succeeded: false; callId?: string; error: Error; receipt?: CostReceipt }

export interface ChannelRollup {
  channel: CostChannel
  calls: number
  inputTokens: number
  outputTokens: number
  reasoningTokens?: number
  cachedTokens: number
  cacheWriteTokens?: number
  costUsd: number
  unpricedCalls: number
  unknownUsageCalls: number
}

export interface CostLedgerSummary {
  costBreakdown?: CostBreakdown
  totalCalls: number
  pendingCalls: number
  unresolvedCalls: number
  reservedCostUsd: number
  inputTokens: number
  outputTokens: number
  reasoningTokens?: number
  cachedTokens: number
  cacheWriteTokens?: number
  totalCostUsd: number
  costProvenance: CostProvenance
  byChannel: ChannelRollup[]
  unpricedModels: string[]
  fullyPriced: boolean
  usageComplete: boolean
  accountingComplete: boolean
  incompleteReasons: string[]
}

export interface CostLedgerFilter {
  channel?: CostChannel
  phase?: string
  tags?: Record<string, string>
}

export interface CostLedgerWaitOptions {
  /** Maximum time to wait for active provider calls. Default 5 seconds. */
  timeoutMs?: number
  /** Wait only for calls matching this attribution filter. */
  filter?: CostLedgerFilter
}

/** Append-only storage. `append` must atomically reject stale revisions. */
export interface CostLedgerPersistence {
  read(): { revision: string; events: string }
  append(expectedRevision: string, event: string): string | undefined
}

export interface CostLedgerOptions {
  costCeilingUsd?: number
  persistence?: CostLedgerPersistence
  /** Import already-settled receipts without admitting new paid work. */
  receipts?: readonly CostReceipt[]
}

/** Public callback surface for a shared cost ledger.
 *
 * Declaration bundles may expose this type through multiple package subpaths.
 * Keeping callback contracts structural lets those subpaths compose while the
 * concrete {@link CostLedger} retains its private durable state.
 */
export type CostLedgerHandle = Pick<
  CostLedger,
  Exclude<keyof CostLedger, 'listPending' | 'waitForIdle'>
> &
  Partial<Pick<CostLedger, 'listPending' | 'waitForIdle'>>
