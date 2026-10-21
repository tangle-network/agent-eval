/** Run-wide paid-call admission and durable call state. */

import type {
  CostLedgerFilter,
  CostLedgerOptions,
  CostLedgerPersistence,
  CostLedgerRecord,
  CostLedgerSummary,
  CostLedgerWaitOptions,
  CostReceipt,
  CostReceiptInput,
  MaximumCharge,
  PaidCallResult,
  PendingCostCall,
  PendingCostCallView,
  RunPaidCallInput,
} from './cost-ledger/contract'
import {
  CostAccountingIncompleteError,
  CostCallConflictError,
  CostCeilingReachedError,
  CostLedgerPersistenceError,
  CostReceiptCaptureError,
  CostReservationExceededError,
} from './cost-ledger/errors'
import type { CostCallEvent, CostLedgerEvent } from './cost-ledger/journal'
import { parseEvents, validateTransition } from './cost-ledger/journal'
import { costForTokenPricing, costForUsage } from './cost-ledger/pricing'
import {
  buildReceipt,
  clonePendingCall,
  cloneReceipt,
  cloneRecord,
  matches,
  parseImportedReceipt,
  validateAttribution,
} from './cost-ledger/receipts'
import { summarizeCostLedger } from './cost-ledger/summary'
import { assertNonNegative, assertString, assertTimeout, toError } from './cost-ledger/validation'
import { ValidationError } from './errors'

export type {
  ChannelRollup,
  CostBreakdown,
  CostChannel,
  CostLedgerFilter,
  CostLedgerHandle,
  CostLedgerOptions,
  CostLedgerPersistence,
  CostLedgerRecord,
  CostLedgerSummary,
  CostLedgerWaitOptions,
  CostProvenance,
  CostReceipt,
  CostReceiptInput,
  CostUsage,
  CustomTokenPricing,
  MaximumCharge,
  PaidCallResult,
  PendingCostCall,
  PendingCostCallView,
  RunPaidCallInput,
} from './cost-ledger/contract'
export {
  CostAccountingIncompleteError,
  CostCallConflictError,
  CostCeilingReachedError,
  CostLedgerPersistenceError,
  CostReceiptCaptureError,
  CostReservationExceededError,
} from './cost-ledger/errors'
export type { CostResult } from './cost-ledger/pricing'
export { costForTokenPricing, costForUsage, modelPriceKey } from './cost-ledger/pricing'

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
      this.ensureCostLimitPersisted(callId)

      const maximumCostUsd = this.resolveMaximum(input.maximumCharge)
      const existing = this.records.get(callId)
      if (existing) {
        return {
          succeeded: false,
          callId,
          error: new CostCallConflictError(
            existing.status === 'pending'
              ? `CostLedger: callId '${callId}' is unresolved and must be reconciled before retry`
              : `CostLedger: callId '${callId}' already exists`,
            { callId },
          ),
        }
      }

      if (!pending) {
        while (true) {
          if (this.records.has(callId)) {
            return {
              succeeded: false,
              callId,
              error: new CostCallConflictError(`CostLedger: callId '${callId}' already exists`),
            }
          }
          const admission = this.admissionState()
          if (admission.unresolvedCalls > 0) {
            return {
              succeeded: false,
              callId,
              error: new CostAccountingIncompleteError(
                `CostLedger: ${admission.unresolvedCalls} unresolved call(s) must be reconciled before new paid work`,
              ),
            }
          }
          if (this.costCeilingUsd === undefined) break
          if (admission.budgetBreached) {
            return {
              succeeded: false,
              callId,
              error: new CostAccountingIncompleteError(
                `CostLedger: a settled call exceeded its enforced maximum; refusing paid call '${input.actor}' during '${input.phase}'`,
              ),
            }
          }
          // A settled call whose cost the provider left unknown is charged its
          // reserved maximum here, so the ceiling is enforced against a real
          // upper bound and one under-reported response cannot let later calls
          // silently exceed the budget — while still permitting them.
          const { committedCostUsd } = admission
          if (committedCostUsd + maximumCostUsd! > this.costCeilingUsd) {
            return {
              succeeded: false,
              callId,
              error: new CostCeilingReachedError(
                this.costCeilingUsd,
                committedCostUsd,
                maximumCostUsd!,
                input.phase,
                input.actor,
              ),
            }
          }
          if (
            committedCostUsd + admission.reservedCostUsd + maximumCostUsd! <=
            this.costCeilingUsd
          ) {
            break
          }
          await this.waitForReservationRelease(input.signal)
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
      }
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
    const hasActiveMatch = (): boolean =>
      [...this.activeCallIds].some((callId) => {
        const record = this.records.get(callId)
        return record !== undefined && matches(record, options.filter)
      })
    if (!hasActiveMatch()) return true
    const timeoutMs = options.timeoutMs ?? 5_000
    assertTimeout(timeoutMs, 'waitForIdle.timeoutMs')
    return new Promise<boolean>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const finish = (settled: boolean): void => {
        this.idleWaiters.delete(onIdle)
        if (timer !== undefined) clearTimeout(timer)
        resolve(settled)
      }
      const onIdle = (): void => {
        if (!hasActiveMatch()) finish(true)
      }
      this.idleWaiters.add(onIdle)
      timer = setTimeout(() => finish(false), timeoutMs)
      onIdle()
    })
  }

  /** Settle a call left pending by a crashed process after reconciling with the provider. */
  reconcile(
    callId: string,
    observed: CostReceiptInput,
    options: { failed?: boolean; error?: string } = {},
  ): CostReceipt {
    const pending = this.records.get(callId)
    if (pending?.status !== 'pending') {
      throw new CostCallConflictError(`CostLedger: no pending call '${callId}'`)
    }
    if (this.activeCallIds.has(callId)) {
      throw new CostCallConflictError(`CostLedger: call '${callId}' is still active`)
    }
    this.ensureCostLimitPersisted(callId)
    return this.commitReceipt(
      pending,
      observed,
      options.failed === true || options.error !== undefined,
      options.error,
    )
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
    return summarizeCostLedger(records, this.activeCallIds, this.lateCallIds)
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
            this.commitReceipt(pending, observed ?? unknownReceipt(pending.model), true)
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
    for (const resolve of [...this.idleWaiters]) resolve()
  }

  private async waitForReservationRelease(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw abortError(signal)
    await new Promise<void>((resolve, reject) => {
      let finished = false
      const finish = (error?: Error): void => {
        if (finished) return
        finished = true
        this.idleWaiters.delete(onRelease)
        signal?.removeEventListener('abort', onAbort)
        if (error) reject(error)
        else resolve()
      }
      const onRelease = (): void => finish()
      const onAbort = (): void => finish(abortError(signal!))
      this.idleWaiters.add(onRelease)
      signal?.addEventListener('abort', onAbort, { once: true })
      if (this.activeCallIds.size === 0) onRelease()
    })
  }

  private commitOutcome<T>(
    pending: PendingCostCall,
    error: Error,
    observed: CostReceiptInput,
  ): PaidCallResult<T> {
    try {
      const receipt = this.commitReceipt(pending, observed, true)
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
      const receipt = this.commitReceipt(pending, unknownReceipt(pending.model), true)
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
    failed = false,
    error?: string,
  ): CostReceipt {
    const receipt = buildReceipt(pending, observed, failed, error)
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

  /** Compute admission totals in record order without building reporting rollups. */
  private admissionState() {
    let unresolvedCalls = 0
    let reservedCostUsd = 0
    let committedCostUsd = 0
    let budgetBreached = false
    for (const record of this.records.values()) {
      if (record.status === 'pending') {
        if (!this.activeCallIds.has(record.callId) || this.lateCallIds.has(record.callId)) {
          unresolvedCalls += 1
        }
        reservedCostUsd += record.maximumCostUsd ?? 0
      } else {
        if (record.maximumCostUsd !== undefined && record.costUsd > record.maximumCostUsd) {
          budgetBreached = true
        }
        // Unknown settled costs consume their reserved maximum for admission.
        committedCostUsd += record.costUnknown
          ? (record.maximumCostUsd ?? record.costUsd)
          : record.costUsd
      }
    }
    return { unresolvedCalls, reservedCostUsd, committedCostUsd, budgetBreached }
  }

  private appendRecord(record: CostLedgerRecord): void {
    const callId = record.callId
    const receipt = record.status === 'settled' ? record : undefined
    validateTransition(this.records, record)
    const event: CostCallEvent =
      record.status === 'settled'
        ? { version: 2, record: cloneReceipt(record) }
        : { version: 1, record: clonePendingCall(record) }
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

function paidFailure<T>(callId: string, error: Error, receipt?: CostReceipt): PaidCallResult<T> {
  return {
    succeeded: false,
    callId,
    error,
    ...(receipt ? { receipt: cloneReceipt(receipt) } : {}),
  }
}
