import { z } from 'zod'
import { ValidationError } from './errors'
import { estimateCost, isModelPriced, resolveModelPricing } from './metrics'

export type CostChannel = 'agent' | 'judge' | 'verifier' | 'analyst' | 'driver' | (string & {})

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

interface CostCallBase {
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
  status: 'settled'
  costUsd: number
  costUnknown: boolean
  usageUnknown?: boolean
  pricing?: {
    inputUsdPerThousand: number
    outputUsdPerThousand: number
  }
  actualCostUsd?: number
  error?: string
}

export type CostLedgerRecord = PendingCostCall | CostReceipt

/** @deprecated Read-only compatibility shape. New paid work uses `runPaidCall`. */
export type CostLedgerEntry = Omit<
  CostReceipt,
  'status' | 'callId' | 'phase' | 'actor' | 'maximumCostUsd' | 'usageUnknown' | 'pricing' | 'error'
>

export interface CostReceiptInput extends CostUsage {
  model: string
  actualCostUsd?: number
  costUnknown?: boolean
  usageUnknown?: boolean
}

/** Per-million token rates for a model or endpoint not covered by package pricing. */
export interface CustomTokenPricing {
  inputUsdPerMillion: number
  outputUsdPerMillion: number
}

export type MaximumCharge =
  | { externallyEnforcedMaximumUsd: number }
  | ({ customTokenPricing: CustomTokenPricing } & Pick<CostUsage, 'inputTokens' | 'outputTokens'>)
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

export class CostCeilingReachedError extends ValidationError {
  constructor(
    ceilingUsd: number,
    committedAndReservedUsd: number,
    requestedUsd: number,
    phase: string,
    actor: string,
  ) {
    super(
      `CostLedger: reserving ${requestedUsd} for '${actor}' during '${phase}' would exceed ceiling ${ceilingUsd} with ${committedAndReservedUsd} already committed or reserved`,
    )
  }
}

export class CostAccountingIncompleteError extends ValidationError {}

export class CostReservationExceededError extends ValidationError {
  constructor(actor: string, actualUsd: number, maximumUsd: number) {
    super(
      `CostLedger: '${actor}' charged ${actualUsd}, exceeding its enforced maximum ${maximumUsd}`,
    )
  }
}

export class CostCallConflictError extends ValidationError {
  readonly callId?: string
  readonly receipt?: CostReceipt

  constructor(
    message: string,
    options: { callId?: string; receipt?: CostReceipt; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.callId = options.callId
    this.receipt = options.receipt ? cloneReceipt(options.receipt) : undefined
  }
}

export class CostLedgerPersistenceError extends ValidationError {
  readonly callId?: string
  readonly receipt?: CostReceipt

  constructor(cause: unknown, callId?: string, receipt?: CostReceipt) {
    super(
      `CostLedger: failed to persist${callId ? ` call '${callId}'` : ''}: ${toError(cause).message}`,
      { cause },
    )
    this.callId = callId
    this.receipt = receipt ? cloneReceipt(receipt) : undefined
  }
}

export class CostReceiptCaptureError extends ValidationError {
  readonly callId: string
  readonly receipt?: CostReceipt
  readonly receiptError: Error

  constructor(callId: string, cause: unknown, receiptError: unknown, receipt?: CostReceipt) {
    super(`CostLedger: could not capture the provider receipt for call '${callId}'`, { cause })
    this.callId = callId
    this.receipt = receipt ? cloneReceipt(receipt) : undefined
    this.receiptError = toError(receiptError)
  }
}

interface CostCallEventV1 {
  version: 1
  record: CostLedgerRecord
}

interface CostCallEventV2 {
  version: 2
  record: CostReceipt
}

interface CompletedTasksEvent {
  version: 1
  completedTasks: number
}

interface CostLimitEvent {
  version: 1
  costCeilingUsd: number
}

type CostCallEvent = CostCallEventV1 | CostCallEventV2
type CostLedgerEvent = CostCallEvent | CompletedTasksEvent | CostLimitEvent

/** Run-wide paid-call admission, durable call state, receipts, and summaries. */
export class CostLedger {
  private readonly records = new Map<string, CostLedgerRecord>()
  private readonly activeCallIds = new Set<string>()
  private readonly lateCallIds = new Set<string>()
  private readonly idleWaiters = new Set<() => void>()
  private completedTasks = 0
  private revision = 'memory'
  private costLimitPersisted = false
  readonly costCeilingUsd?: number
  private readonly persistence?: CostLedgerPersistence

  constructor(input?: number | CostLedgerOptions) {
    const options = typeof input === 'number' ? { costCeilingUsd: input } : (input ?? {})
    this.persistence = options.persistence
    if (options.costCeilingUsd !== undefined) {
      assertNonNegative(options.costCeilingUsd, 'costCeilingUsd')
    }

    let persistedCostCeilingUsd: number | undefined
    if (this.persistence) {
      let stored: ReturnType<CostLedgerPersistence['read']>
      try {
        stored = this.persistence.read()
      } catch (cause) {
        throw new CostLedgerPersistenceError(cause)
      }
      assertString(stored.revision, 'persistence revision')
      this.revision = stored.revision
      const restored = parseEvents(stored.events)
      for (const record of restored.records) this.records.set(record.callId, record)
      this.completedTasks = restored.completedTasks
      persistedCostCeilingUsd = restored.costCeilingUsd
    }

    if (
      options.costCeilingUsd !== undefined &&
      persistedCostCeilingUsd !== undefined &&
      options.costCeilingUsd !== persistedCostCeilingUsd
    ) {
      throw new ValidationError(
        `CostLedger: requested cost ceiling ${options.costCeilingUsd} does not match persisted ceiling ${persistedCostCeilingUsd}`,
      )
    }
    this.costCeilingUsd = persistedCostCeilingUsd ?? options.costCeilingUsd
    this.costLimitPersisted =
      !this.persistence ||
      this.costCeilingUsd === undefined ||
      persistedCostCeilingUsd !== undefined

    if (
      this.costCeilingUsd !== undefined &&
      [...this.records.values()].some(
        (record) => record.status === 'pending' && record.maximumCostUsd === undefined,
      )
    ) {
      throw new ValidationError('CostLedger: capped event log contains an unbounded pending call')
    }

    if (options.receipts?.length) {
      const imported = options.receipts.map((receipt, index) =>
        parseImportedReceipt(receipt, `imported receipt ${index + 1}`),
      )
      this.ensureCostLimitPersisted()
      for (const receipt of imported) this.appendRecord(receipt)
    }
  }

  async runPaidCall<T>(input: RunPaidCallInput<T>): Promise<PaidCallResult<T>> {
    let callId: string | undefined
    let pending: PendingCostCall | undefined
    try {
      callId = resolveCallId(input.callId)
      validateAttribution(input)
      if (input.signal?.aborted) {
        return { succeeded: false, callId, error: abortError(input.signal) }
      }
      if (this.records.has(callId)) {
        return {
          succeeded: false,
          callId,
          error: new CostCallConflictError(`CostLedger: callId '${callId}' already exists`),
        }
      }
      this.ensureCostLimitPersisted(callId)

      const summary = this.summary()
      if (summary.unresolvedCalls > 0) {
        return {
          succeeded: false,
          callId,
          error: new CostAccountingIncompleteError(
            `CostLedger: ${summary.unresolvedCalls} unresolved call(s) must be reconciled before new paid work`,
          ),
        }
      }

      const maximumCostUsd = this.resolveMaximum(input.maximumCharge)
      if (this.costCeilingUsd !== undefined && this.hasIncompleteSettledCall()) {
        return {
          succeeded: false,
          callId,
          error: new CostAccountingIncompleteError(
            `CostLedger: accounting is incomplete; refusing paid call '${input.actor}' during '${input.phase}'`,
          ),
        }
      }
      if (this.costCeilingUsd !== undefined) {
        const committedAndReserved = summary.totalCostUsd + summary.reservedCostUsd
        if (committedAndReserved + maximumCostUsd! > this.costCeilingUsd) {
          return {
            succeeded: false,
            callId,
            error: new CostCeilingReachedError(
              this.costCeilingUsd,
              committedAndReserved,
              maximumCostUsd!,
              input.phase,
              input.actor,
            ),
          }
        }
      }

      pending = {
        status: 'pending',
        callId,
        channel: input.channel,
        phase: input.phase,
        actor: input.actor,
        model: pendingModel(input),
        ...(maximumCostUsd === undefined ? {} : { maximumCostUsd }),
        ...(input.tags ? { tags: { ...input.tags } } : {}),
        timestamp: Date.now(),
      }
      this.appendRecord(pending)
      this.activeCallIds.add(callId)
    } catch (error) {
      return { succeeded: false, ...(callId ? { callId } : {}), error: toError(error) }
    }

    try {
      return await this.execute(input, pending)
    } catch (error) {
      return { succeeded: false, callId: pending.callId, error: toError(error) }
    } finally {
      if (!this.lateCallIds.has(pending.callId)) this.releaseActiveCall(pending.callId)
    }
  }

  /** Wait until every call started by this ledger has produced a durable outcome. */
  async waitForIdle(options: CostLedgerWaitOptions = {}): Promise<boolean> {
    if (this.activeCallIds.size === 0) return true
    const timeoutMs = options.timeoutMs ?? 5_000
    assertTimeout(timeoutMs, 'waitForIdle.timeoutMs')
    return new Promise<boolean>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const finish = (settled: boolean): void => {
        this.idleWaiters.delete(onIdle)
        if (timer !== undefined) clearTimeout(timer)
        resolve(settled)
      }
      const onIdle = (): void => finish(true)
      this.idleWaiters.add(onIdle)
      timer = setTimeout(() => finish(false), timeoutMs)
      if (this.activeCallIds.size === 0) onIdle()
    })
  }

  /** Settle a call left pending by a crashed process after reconciling with the provider. */
  reconcile(
    callId: string,
    observed: CostReceiptInput,
    options: { error?: string } = {},
  ): CostReceipt {
    const pending = [...this.records.values()].find(
      (record): record is PendingCostCall =>
        record.callId === callId && record.status === 'pending',
    )
    if (!pending) throw new CostCallConflictError(`CostLedger: no pending call '${callId}'`)
    if (this.activeCallIds.has(callId)) {
      throw new CostCallConflictError(`CostLedger: call '${callId}' is still active`)
    }
    this.ensureCostLimitPersisted(callId)
    return this.commitReceipt(pending, observed, options.error)
  }

  list(filter?: CostLedgerFilter): CostReceipt[] {
    return [...this.records.values()]
      .filter((record): record is CostReceipt => record.status === 'settled')
      .filter((receipt) => matches(receipt, filter))
      .map(cloneReceipt)
  }

  /** Read pending calls without exposing mutable ledger state. */
  listPending(filter?: CostLedgerFilter): PendingCostCallView[] {
    return [...this.records.values()]
      .filter((record): record is PendingCostCall => record.status === 'pending')
      .filter((record) => matches(record, filter))
      .map((record) => ({
        ...clonePendingCall(record),
        state: this.lateCallIds.has(record.callId)
          ? 'late'
          : this.activeCallIds.has(record.callId)
            ? 'active'
            : 'interrupted',
      }))
  }

  summary(filter?: CostLedgerFilter): CostLedgerSummary {
    const records = [...this.records.values()].filter((record) => matches(record, filter))
    const pending = records.filter(
      (record): record is PendingCostCall => record.status === 'pending',
    )
    const receipts = records.filter((record): record is CostReceipt => record.status === 'settled')
    const byChannel = new Map<string, ChannelRollup>()
    const unpriced = new Set<string>()
    const incompleteReasons: string[] = pending.map(
      (record) => `call '${record.callId}' for '${record.actor}' is pending`,
    )
    let inputTokens = 0
    let outputTokens = 0
    let reasoningTokens = 0
    let cachedTokens = 0
    let cacheWriteTokens = 0
    let totalCostUsd = 0

    for (const receipt of receipts) {
      inputTokens += receipt.inputTokens
      outputTokens += receipt.outputTokens
      reasoningTokens += receipt.reasoningTokens ?? 0
      cachedTokens += receipt.cachedTokens ?? 0
      cacheWriteTokens += receipt.cacheWriteTokens ?? 0
      totalCostUsd += receipt.costUsd
      if (receipt.costUnknown) {
        unpriced.add(receipt.model)
        incompleteReasons.push(
          receipt.error ?? `cost unknown for '${receipt.actor}' using '${receipt.model}'`,
        )
      }
      if (receipt.usageUnknown) {
        incompleteReasons.push(
          `token usage unknown for '${receipt.actor}' using '${receipt.model}'`,
        )
      }
      if (receipt.maximumCostUsd !== undefined && receipt.costUsd > receipt.maximumCostUsd) {
        incompleteReasons.push(
          `'${receipt.actor}' charged ${receipt.costUsd}, exceeding its enforced maximum ${receipt.maximumCostUsd}`,
        )
      }
      const rollup = byChannel.get(receipt.channel) ?? emptyRollup(receipt.channel)
      rollup.calls += 1
      rollup.inputTokens += receipt.inputTokens
      rollup.outputTokens += receipt.outputTokens
      rollup.reasoningTokens = (rollup.reasoningTokens ?? 0) + (receipt.reasoningTokens ?? 0)
      rollup.cachedTokens += receipt.cachedTokens ?? 0
      rollup.cacheWriteTokens = (rollup.cacheWriteTokens ?? 0) + (receipt.cacheWriteTokens ?? 0)
      rollup.costUsd += receipt.costUsd
      if (receipt.costUnknown) rollup.unpricedCalls += 1
      if (receipt.usageUnknown) rollup.unknownUsageCalls += 1
      byChannel.set(receipt.channel, rollup)
    }

    return {
      totalCalls: receipts.length,
      pendingCalls: pending.length,
      unresolvedCalls: pending.filter(
        (record) => !this.activeCallIds.has(record.callId) || this.lateCallIds.has(record.callId),
      ).length,
      reservedCostUsd: pending.reduce((sum, record) => sum + (record.maximumCostUsd ?? 0), 0),
      inputTokens,
      outputTokens,
      reasoningTokens,
      cachedTokens,
      cacheWriteTokens,
      totalCostUsd,
      byChannel: [...byChannel.values()].sort((a, b) => a.channel.localeCompare(b.channel)),
      unpricedModels: [...unpriced].sort(),
      fullyPriced: unpriced.size === 0,
      usageComplete: pending.length === 0 && receipts.every((receipt) => !receipt.usageUnknown),
      accountingComplete: incompleteReasons.length === 0,
      incompleteReasons: [...new Set(incompleteReasons)],
    }
  }

  markCompleted(count = 1): void {
    if (!Number.isInteger(count) || count < 0) {
      throw new ValidationError(
        `CostLedger.markCompleted: count must be a non-negative integer, got ${count}`,
      )
    }
    if (count === 0) return
    this.ensureCostLimitPersisted()
    this.appendEvent({ version: 1, completedTasks: count })
    this.completedTasks += count
  }

  costPerCompletedTask(): number | null {
    return this.completedTasks === 0 ? null : this.summary().totalCostUsd / this.completedTasks
  }

  private async execute<T>(
    input: RunPaidCallInput<T>,
    pending: PendingCostCall,
  ): Promise<PaidCallResult<T>> {
    const signal = input.signal ?? new AbortController().signal
    if (signal.aborted) {
      return this.commitOutcome(pending, abortError(signal), {
        model: pending.model,
        inputTokens: 0,
        outputTokens: 0,
        actualCostUsd: 0,
      })
    }

    const operation = Promise.resolve().then(() => input.execute(signal, pending.callId))
    const settled = await settle(operation, signal)
    if (settled.kind === 'aborted') {
      this.lateCallIds.add(pending.callId)
      this.captureLateOutcome(input, pending, operation)
      return paidFailure(pending.callId, abortError(signal))
    }
    if (settled.kind === 'error') {
      let observed: CostReceiptInput | undefined
      try {
        observed = input.receiptFromError?.(settled.error)
      } catch (receiptError) {
        return this.captureFailure(pending, settled.error, receiptError)
      }
      return this.commitOutcome(pending, settled.error, observed ?? unknownReceipt(pending.model))
    }

    try {
      const receipt = this.commitReceipt(pending, input.receipt(settled.value))
      if (receipt.maximumCostUsd !== undefined && receipt.costUsd > receipt.maximumCostUsd) {
        return paidFailure(
          pending.callId,
          new CostReservationExceededError(pending.actor, receipt.costUsd, receipt.maximumCostUsd),
          receipt,
        )
      }
      return { succeeded: true, callId: pending.callId, value: settled.value, receipt }
    } catch (receiptError) {
      if (
        receiptError instanceof CostLedgerPersistenceError ||
        receiptError instanceof CostCallConflictError
      ) {
        return paidFailure(pending.callId, receiptError)
      }
      return this.captureFailure(pending, receiptError, receiptError)
    }
  }

  private captureLateOutcome<T>(
    input: RunPaidCallInput<T>,
    pending: PendingCostCall,
    operation: Promise<T>,
  ): void {
    void operation
      .then(
        (value) => {
          if (this.records.get(pending.callId)?.status !== 'pending') return
          try {
            this.commitReceipt(pending, input.receipt(value))
          } catch {
            // A failed durable settlement leaves the reservation pending and blocks new paid work.
          }
        },
        (cause) => {
          if (this.records.get(pending.callId)?.status !== 'pending') return
          const error = toError(cause)
          try {
            const observed = input.receiptFromError?.(error)
            this.commitReceipt(pending, observed ?? unknownReceipt(pending.model), error.message)
          } catch (receiptError) {
            if (
              receiptError instanceof CostLedgerPersistenceError ||
              receiptError instanceof CostCallConflictError
            ) {
              return
            }
            this.captureFailure(pending, error, receiptError)
          }
        },
      )
      .finally(() => {
        this.lateCallIds.delete(pending.callId)
        this.releaseActiveCall(pending.callId)
      })
  }

  private releaseActiveCall(callId: string): void {
    this.activeCallIds.delete(callId)
    if (this.activeCallIds.size > 0) return
    for (const resolve of this.idleWaiters) resolve()
    this.idleWaiters.clear()
  }

  private commitOutcome<T>(
    pending: PendingCostCall,
    error: Error,
    observed: CostReceiptInput,
  ): PaidCallResult<T> {
    try {
      const receipt = this.commitReceipt(pending, observed, error.message)
      return paidFailure(pending.callId, error, receipt)
    } catch (receiptError) {
      if (
        receiptError instanceof CostLedgerPersistenceError ||
        receiptError instanceof CostCallConflictError
      ) {
        return paidFailure(pending.callId, receiptError)
      }
      return this.captureFailure(pending, error, receiptError)
    }
  }

  private captureFailure<T>(
    pending: PendingCostCall,
    cause: unknown,
    receiptError: unknown,
  ): PaidCallResult<T> {
    try {
      const receipt = this.commitReceipt(
        pending,
        unknownReceipt(pending.model),
        toError(receiptError).message,
      )
      return paidFailure(
        pending.callId,
        new CostReceiptCaptureError(pending.callId, cause, receiptError, receipt),
        receipt,
      )
    } catch (error) {
      const typed = error instanceof Error ? error : toError(error)
      return paidFailure(pending.callId, typed)
    }
  }

  private commitReceipt(
    pending: PendingCostCall,
    observed: CostReceiptInput,
    error?: string,
  ): CostReceipt {
    const receipt = buildReceipt(pending, observed, error)
    if (this.records.get(pending.callId)?.status !== 'pending') {
      throw new CostCallConflictError(`CostLedger: call '${pending.callId}' is not pending`)
    }
    this.appendRecord(receipt)
    return cloneReceipt(receipt)
  }

  private resolveMaximum(maximum: MaximumCharge | undefined): number | undefined {
    if (!maximum) {
      if (this.costCeilingUsd !== undefined) {
        throw new CostAccountingIncompleteError(
          'CostLedger: capped paid calls require a hard maximumCharge before execution',
        )
      }
      return undefined
    }
    if ('externallyEnforcedMaximumUsd' in maximum) {
      assertNonNegative(
        maximum.externallyEnforcedMaximumUsd,
        'maximumCharge.externallyEnforcedMaximumUsd',
      )
      return maximum.externallyEnforcedMaximumUsd
    }
    if ('customTokenPricing' in maximum) {
      return costForTokenPricing(maximum.customTokenPricing, maximum)
    }
    const priced = costForUsage(maximum.model, maximum)
    if (priced.costUnknown) {
      if (this.costCeilingUsd !== undefined) {
        throw new CostAccountingIncompleteError(
          `CostLedger: cannot reserve unpriced model '${maximum.model}' in a capped run`,
        )
      }
      return undefined
    }
    return priced.costUsd
  }

  private hasIncompleteSettledCall(): boolean {
    return [...this.records.values()].some(
      (record) =>
        record.status === 'settled' &&
        (record.costUnknown ||
          record.usageUnknown ||
          (record.maximumCostUsd !== undefined && record.costUsd > record.maximumCostUsd)),
    )
  }

  private appendRecord(record: CostLedgerRecord): void {
    const callId = record.callId
    const receipt = record.status === 'settled' ? record : undefined
    validateTransition(this.records, record)
    const event: CostCallEvent =
      record.status === 'settled' &&
      (record.reasoningTokens !== undefined || record.cacheWriteTokens !== undefined)
        ? { version: 2, record: cloneReceipt(record) }
        : { version: 1, record: cloneRecord(record) }
    this.appendEvent(event, callId, receipt)
    this.records.set(callId, cloneRecord(record))
  }

  private ensureCostLimitPersisted(callId?: string): void {
    if (this.costLimitPersisted || this.costCeilingUsd === undefined) return
    this.appendEvent({ version: 1, costCeilingUsd: this.costCeilingUsd }, callId)
    this.costLimitPersisted = true
  }

  private appendEvent(event: CostLedgerEvent, callId?: string, receipt?: CostReceipt): void {
    try {
      if (this.persistence) {
        const nextRevision = this.persistence.append(this.revision, `${JSON.stringify(event)}\n`)
        if (nextRevision === undefined) {
          throw new CostCallConflictError(
            `CostLedger: persisted revision changed while writing call '${callId}'`,
            { callId, receipt },
          )
        }
        assertString(nextRevision, 'persistence revision')
        this.revision = nextRevision
      }
    } catch (cause) {
      if (cause instanceof CostCallConflictError) throw cause
      throw new CostLedgerPersistenceError(cause, callId, receipt)
    }
  }
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

/** Return the canonical pricing-table key, or null when the model is unpriced. */
export function modelPriceKey(model: string): string | null {
  return isModelPriced(model) ? model : null
}

export interface CostResult {
  costUsd: number
  costUnknown: boolean
}

export function costForUsage(model: string, usage: CostUsage): CostResult {
  assertUsage(usage)
  if (!resolveModelPricing(model)) return { costUsd: 0, costUnknown: true }
  return {
    costUsd: estimateCost(
      usage.inputTokens + (usage.cachedTokens ?? 0) + (usage.cacheWriteTokens ?? 0),
      usage.outputTokens,
      model,
    ),
    costUnknown: false,
  }
}

/** Price input and output token counts with caller-supplied per-million rates. */
export function costForTokenPricing(
  pricing: CustomTokenPricing,
  usage: Pick<CostUsage, 'inputTokens' | 'outputTokens'>,
): number {
  assertTokenCount(usage.inputTokens, 'usage.inputTokens')
  assertTokenCount(usage.outputTokens, 'usage.outputTokens')
  assertNonNegative(pricing.inputUsdPerMillion, 'pricing.inputUsdPerMillion')
  assertNonNegative(pricing.outputUsdPerMillion, 'pricing.outputUsdPerMillion')
  return (
    (usage.inputTokens / 1_000_000) * pricing.inputUsdPerMillion +
    (usage.outputTokens / 1_000_000) * pricing.outputUsdPerMillion
  )
}

type Settled<T> =
  | { kind: 'value'; value: T }
  | { kind: 'error'; error: Error }
  | { kind: 'aborted' }

async function settle<T>(promise: Promise<T>, signal: AbortSignal): Promise<Settled<T>> {
  return await new Promise((resolve) => {
    let done = false
    const finish = (value: Settled<T>): void => {
      if (done) return
      done = true
      signal.removeEventListener('abort', onAbort)
      resolve(value)
    }
    const onAbort = () => finish({ kind: 'aborted' })
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
    promise.then(
      (value) => finish({ kind: 'value', value }),
      (error) => finish({ kind: 'error', error: toError(error) }),
    )
  })
}

function buildReceipt(
  pending: PendingCostCall,
  observed: CostReceiptInput,
  error?: string,
): CostReceipt {
  assertUsage(observed)
  assertString(observed.model, 'receipt.model')
  const estimated = costForUsage(observed.model, observed)
  const hasActual = observed.actualCostUsd !== undefined
  if (hasActual && observed.costUnknown === true) {
    throw new ValidationError(
      'CostLedger: a receipt cannot have both actualCostUsd and costUnknown=true',
    )
  }
  if (hasActual) assertNonNegative(observed.actualCostUsd!, 'actualCostUsd')
  const usageUnknown = observed.usageUnknown === true
  const costUnknown =
    observed.costUnknown === true || (!hasActual && (usageUnknown || estimated.costUnknown))
  const resolvedPricing = !hasActual && !costUnknown ? resolveModelPricing(observed.model) : null
  return parseReceipt(
    {
      status: 'settled',
      callId: pending.callId,
      channel: pending.channel,
      phase: pending.phase,
      actor: pending.actor,
      model: observed.model,
      inputTokens: observed.inputTokens,
      outputTokens: observed.outputTokens,
      ...(observed.reasoningTokens === undefined
        ? {}
        : { reasoningTokens: observed.reasoningTokens }),
      ...(observed.cachedTokens === undefined ? {} : { cachedTokens: observed.cachedTokens }),
      ...(observed.cacheWriteTokens === undefined
        ? {}
        : { cacheWriteTokens: observed.cacheWriteTokens }),
      costUsd: costUnknown ? 0 : hasActual ? observed.actualCostUsd! : estimated.costUsd,
      costUnknown,
      usageUnknown,
      ...(resolvedPricing
        ? {
            pricing: {
              inputUsdPerThousand: resolvedPricing.input,
              outputUsdPerThousand: resolvedPricing.output,
            },
          }
        : {}),
      ...(hasActual ? { actualCostUsd: observed.actualCostUsd } : {}),
      ...(pending.maximumCostUsd === undefined ? {} : { maximumCostUsd: pending.maximumCostUsd }),
      ...(error ? { error } : {}),
      ...(pending.tags ? { tags: { ...pending.tags } } : {}),
      timestamp: pending.timestamp,
    },
    'provider receipt',
  )
}

const NonEmptyString = z.string().refine((value) => value.trim().length > 0, 'must be non-empty')
const TokenCount = z.number().int().nonnegative().finite()
const NonNegative = z.number().nonnegative().finite()
const Positive = z.number().positive().finite()
const Tags = z.record(NonEmptyString, z.string())
const CostPricingSchema = z.strictObject({
  inputUsdPerThousand: Positive,
  outputUsdPerThousand: Positive,
})
const CostCallBaseShape = {
  callId: NonEmptyString,
  channel: NonEmptyString,
  phase: NonEmptyString,
  actor: NonEmptyString,
  model: NonEmptyString,
  maximumCostUsd: NonNegative.optional(),
  tags: Tags.optional(),
  timestamp: NonNegative,
}
const PendingCostCallSchema = z.strictObject({
  status: z.literal('pending'),
  ...CostCallBaseShape,
})
const CostReceiptBaseShape = {
  status: z.literal('settled'),
  ...CostCallBaseShape,
  inputTokens: TokenCount,
  outputTokens: TokenCount,
  cachedTokens: TokenCount.optional(),
  costUsd: NonNegative,
  costUnknown: z.boolean(),
  usageUnknown: z.boolean().default(false),
  pricing: CostPricingSchema.optional(),
  actualCostUsd: NonNegative.optional(),
  error: z.string().optional(),
}
const LegacyCostReceiptSchema = z
  .strictObject(CostReceiptBaseShape)
  .superRefine((receipt, ctx) => validateCostReceipt(receipt, ctx))
const CostReceiptSchema = z
  .strictObject({
    ...CostReceiptBaseShape,
    reasoningTokens: TokenCount.optional(),
    cacheWriteTokens: TokenCount.optional(),
  })
  .superRefine((receipt, ctx) => validateCostReceipt(receipt, ctx))

function validateCostReceipt(
  receipt: CostUsage & {
    costUsd: number
    costUnknown: boolean
    usageUnknown: boolean
    pricing?: NonNullable<CostReceipt['pricing']>
    actualCostUsd?: number
  },
  ctx: z.RefinementCtx,
): void {
  if (receipt.reasoningTokens !== undefined && receipt.reasoningTokens > receipt.outputTokens) {
    ctx.addIssue({ code: 'custom', message: 'reasoningTokens must not exceed outputTokens' })
  }

  if (receipt.actualCostUsd !== undefined) {
    if (receipt.costUnknown || receipt.costUsd !== receipt.actualCostUsd) {
      ctx.addIssue({ code: 'custom', message: 'actual cost must be known and equal costUsd' })
    }
    if (receipt.pricing !== undefined) {
      ctx.addIssue({ code: 'custom', message: 'actual cost must not include estimated pricing' })
    }
    return
  }

  if (receipt.costUnknown) {
    if (receipt.costUsd !== 0) {
      ctx.addIssue({ code: 'custom', message: 'unknown cost must have costUsd 0' })
    }
    if (receipt.pricing !== undefined) {
      ctx.addIssue({ code: 'custom', message: 'unknown cost must not include estimated pricing' })
    }
    return
  }

  if (receipt.usageUnknown) {
    ctx.addIssue({ code: 'custom', message: 'known estimated cost requires known usage' })
  }
  if (!receipt.pricing) {
    ctx.addIssue({ code: 'custom', message: 'known estimated cost requires a pricing snapshot' })
    return
  }

  const expected = costFromPricing(receipt, receipt.pricing)
  if (receipt.costUsd !== expected) {
    ctx.addIssue({
      code: 'custom',
      message: `estimated cost ${receipt.costUsd} does not match pricing snapshot ${expected}`,
    })
  }
}

const CostLedgerEventSchema = z.union([
  z.strictObject({
    version: z.literal(1),
    record: z.union([PendingCostCallSchema, LegacyCostReceiptSchema]),
  }),
  z.strictObject({
    version: z.literal(2),
    record: CostReceiptSchema,
  }),
  z.strictObject({
    version: z.literal(1),
    completedTasks: TokenCount,
  }),
  z.strictObject({
    version: z.literal(1),
    costCeilingUsd: NonNegative,
  }),
])

function parseEvents(serialized: string): {
  records: CostLedgerRecord[]
  completedTasks: number
  costCeilingUsd?: number
} {
  const records = new Map<string, CostLedgerRecord>()
  let completedTasks = 0
  let costCeilingUsd: number | undefined
  let lineNumber = 0
  try {
    for (const line of serialized.split('\n')) {
      if (!line.trim()) continue
      lineNumber += 1
      const event = CostLedgerEventSchema.parse(JSON.parse(line)) as CostLedgerEvent
      if ('record' in event) {
        const record = event.record
        validateTransition(records, record)
        records.set(record.callId, cloneRecord(record))
      } else if ('completedTasks' in event) {
        completedTasks += event.completedTasks
        if (!Number.isSafeInteger(completedTasks)) {
          throw new ValidationError('CostLedger: completed task count exceeds safe integer range')
        }
      } else {
        if (costCeilingUsd !== undefined) {
          throw new ValidationError('CostLedger: duplicate persisted cost ceiling')
        }
        costCeilingUsd = event.costCeilingUsd
      }
    }
    return {
      records: [...records.values()],
      completedTasks,
      ...(costCeilingUsd === undefined ? {} : { costCeilingUsd }),
    }
  } catch (cause) {
    throw new ValidationError(
      `CostLedger: invalid persisted event ${lineNumber || 1}: ${validationMessage(cause)}`,
      { cause },
    )
  }
}

function validateTransition(
  records: ReadonlyMap<string, CostLedgerRecord>,
  record: CostLedgerRecord,
): void {
  const current = records.get(record.callId)
  if (!current) return
  if (record.status === 'pending' || current.status === 'settled') {
    throw new CostCallConflictError(`CostLedger: duplicate callId '${record.callId}'`)
  }
  if (!sameAttribution(current, record)) {
    throw new ValidationError(`CostLedger: receipt attribution changed for call '${record.callId}'`)
  }
}

function sameAttribution(before: CostCallBase, after: CostCallBase): boolean {
  return (
    before.channel === after.channel &&
    before.phase === after.phase &&
    before.actor === after.actor &&
    before.maximumCostUsd === after.maximumCostUsd &&
    before.timestamp === after.timestamp &&
    JSON.stringify(before.tags ?? {}) === JSON.stringify(after.tags ?? {})
  )
}

function parseReceipt(value: unknown, path: string): CostReceipt {
  try {
    return CostReceiptSchema.parse(value) as CostReceipt
  } catch (cause) {
    throw new ValidationError(`CostLedger: invalid ${path}: ${validationMessage(cause)}`, { cause })
  }
}

function parseImportedReceipt(value: unknown, path: string): CostReceipt {
  if (typeof value !== 'object' || value === null) return parseReceipt(value, path)
  const candidate = { ...value } as Record<string, unknown>
  if (
    candidate.status === 'settled' &&
    candidate.actualCostUsd === undefined &&
    candidate.costUnknown === false &&
    candidate.pricing === undefined &&
    typeof candidate.model === 'string'
  ) {
    const pricing = resolveModelPricing(candidate.model)
    if (pricing) {
      candidate.pricing = {
        inputUsdPerThousand: pricing.input,
        outputUsdPerThousand: pricing.output,
      }
    }
  }
  return parseReceipt(candidate, path)
}

function validateAttribution(
  input: Pick<RunPaidCallInput<unknown>, 'channel' | 'phase' | 'actor' | 'model' | 'tags'>,
): void {
  assertString(input.channel, 'channel')
  assertString(input.phase, 'phase')
  assertString(input.actor, 'actor')
  if (input.model !== undefined) assertString(input.model, 'model')
  if (input.tags !== undefined) {
    const parsed = Tags.safeParse(input.tags)
    if (!parsed.success)
      throw new ValidationError(`CostLedger: invalid tags: ${parsed.error.message}`)
  }
}

function matches(record: CostCallBase, filter: CostLedgerFilter | undefined): boolean {
  if (!filter) return true
  if (filter.channel !== undefined && record.channel !== filter.channel) return false
  if (filter.phase !== undefined && record.phase !== filter.phase) return false
  return Object.entries(filter.tags ?? {}).every(([key, value]) => record.tags?.[key] === value)
}

function cloneRecord(record: CostLedgerRecord): CostLedgerRecord {
  if (record.status === 'settled') return cloneReceipt(record)
  return clonePendingCall(record)
}

function clonePendingCall(record: PendingCostCall): PendingCostCall {
  const { tags, ...rest } = record
  return { ...rest, ...(tags ? { tags: { ...tags } } : {}) }
}

function cloneReceipt(receipt: CostReceipt): CostReceipt {
  const { pricing, tags, ...rest } = receipt
  return {
    ...rest,
    ...(tags ? { tags: { ...tags } } : {}),
    ...(pricing ? { pricing: { ...pricing } } : {}),
  }
}

function costFromPricing(usage: CostUsage, pricing: NonNullable<CostReceipt['pricing']>): number {
  return (
    ((usage.inputTokens + (usage.cachedTokens ?? 0) + (usage.cacheWriteTokens ?? 0)) / 1000) *
      pricing.inputUsdPerThousand +
    (usage.outputTokens / 1000) * pricing.outputUsdPerThousand
  )
}

function emptyRollup(channel: CostChannel): ChannelRollup {
  return {
    channel,
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cachedTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
    unpricedCalls: 0,
    unknownUsageCalls: 0,
  }
}

function pendingModel(input: RunPaidCallInput<unknown>): string {
  if (input.model) return input.model
  if (input.maximumCharge && 'model' in input.maximumCharge) return input.maximumCharge.model
  return 'unknown'
}

function unknownReceipt(model: string): CostReceiptInput {
  return { model, inputTokens: 0, outputTokens: 0, costUnknown: true, usageUnknown: true }
}

function resolveCallId(input: string | undefined): string {
  if (input !== undefined) {
    assertString(input, 'callId')
    return input
  }
  if (typeof globalThis.crypto?.randomUUID !== 'function') {
    throw new ValidationError('CostLedger: crypto.randomUUID is required when callId is omitted')
  }
  return globalThis.crypto.randomUUID()
}

function abortError(signal: AbortSignal): Error {
  const reason = (signal as { reason?: unknown }).reason
  if (reason instanceof Error) return reason
  const error = new Error('CostLedger: paid call aborted')
  error.name = 'AbortError'
  return error
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

function paidFailure<T>(callId: string, error: Error, receipt?: CostReceipt): PaidCallResult<T> {
  return {
    succeeded: false,
    callId,
    error,
    ...(receipt ? { receipt: cloneReceipt(receipt) } : {}),
  }
}

function validationMessage(cause: unknown): string {
  return cause instanceof z.ZodError ? z.prettifyError(cause) : toError(cause).message
}

function assertUsage(usage: CostUsage): void {
  assertTokenCount(usage.inputTokens, 'inputTokens')
  assertTokenCount(usage.outputTokens, 'outputTokens')
  if (usage.reasoningTokens !== undefined) {
    assertTokenCount(usage.reasoningTokens, 'reasoningTokens')
    if (usage.reasoningTokens > usage.outputTokens) {
      throw new ValidationError('CostLedger: reasoningTokens must not exceed outputTokens')
    }
  }
  if (usage.cachedTokens !== undefined) assertTokenCount(usage.cachedTokens, 'cachedTokens')
  if (usage.cacheWriteTokens !== undefined) {
    assertTokenCount(usage.cacheWriteTokens, 'cacheWriteTokens')
  }
}

function assertTokenCount(value: unknown, name: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new ValidationError(
      `CostLedger: ${name} must be a non-negative integer, got ${String(value)}`,
    )
  }
}

function assertNonNegative(value: unknown, name: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new ValidationError(
      `CostLedger: ${name} must be a non-negative finite number, got ${String(value)}`,
    )
  }
}

function assertTimeout(value: unknown, name: string): asserts value is number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > 2_147_483_647
  ) {
    throw new ValidationError(
      `CostLedger: ${name} must be a non-negative safe integer no greater than 2147483647, got ${String(value)}`,
    )
  }
}

function assertString(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ValidationError(`CostLedger: ${name} must be a non-empty string`)
  }
}
