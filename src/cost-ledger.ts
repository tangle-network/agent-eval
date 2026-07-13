import { ValidationError } from './errors'
import { estimateCost, isModelPriced, resolveModelPricing } from './metrics'

export type CostChannel = 'agent' | 'judge' | 'verifier' | 'analyst' | 'driver' | (string & {})

export interface CostUsage {
  inputTokens: number
  outputTokens: number
  cachedTokens?: number
}

/** The only durable accounting row. Unknown or unterminated calls are rows too,
 *  so resumed totals cannot silently forget work that may have cost money. */
export interface CostReceipt extends CostUsage {
  model: string
  channel: CostChannel
  phase: string
  actor: string
  costUsd: number
  costUnknown: boolean
  actualCostUsd?: number
  maximumCostUsd?: number
  terminationConfirmed: boolean
  error?: string
  tags?: Record<string, string>
  timestamp: number
}

export interface CostReceiptInput extends CostUsage {
  model: string
  actualCostUsd?: number
  costUnknown?: boolean
}

export type MaximumCharge = { providerLimitUsd: number } | ({ model: string } & CostUsage)

export interface RunPaidCallInput<T> {
  channel: CostChannel
  phase: string
  actor: string
  /** Used on failures that return no provider receipt. */
  model?: string
  tags?: Record<string, string>
  signal?: AbortSignal
  /** Hard provider charge limit, or maximum priced token usage. Required when capped. */
  maximumCharge?: MaximumCharge
  execute(signal: AbortSignal): Promise<T>
  receipt(value: T): CostReceiptInput
  receiptFromError?(error: Error): CostReceiptInput | undefined
}

export type PaidCallResult<T> =
  | { succeeded: true; value: T; receipt: CostReceipt }
  | { succeeded: false; error: Error; receipt?: CostReceipt }

export interface ChannelRollup {
  channel: CostChannel
  calls: number
  inputTokens: number
  outputTokens: number
  cachedTokens: number
  costUsd: number
  unpricedCalls: number
}

export interface CostLedgerSummary {
  totalCalls: number
  inputTokens: number
  outputTokens: number
  cachedTokens: number
  totalCostUsd: number
  byChannel: ChannelRollup[]
  unpricedModels: string[]
  fullyPriced: boolean
  accountingComplete: boolean
  incompleteReasons: string[]
}

export interface CostLedgerFilter {
  channel?: CostChannel
  phase?: string
  tags?: Record<string, string>
}

export interface CostLedgerPersistence {
  read(): string | undefined
  write(content: string): void
}

export interface CostLedgerOptions {
  costCeilingUsd?: number
  persistence?: CostLedgerPersistence
  resume?: boolean
  /** Import already-observed receipts without admitting new paid work. */
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
      `CostLedger: '${actor}' charged ${actualUsd}, exceeding its declared maximum ${maximumUsd}`,
    )
  }
}

/** Run-wide paid-call admission, durable receipts, and summaries. */
export class CostLedger {
  private readonly receipts: CostReceipt[] = []
  private reservedUsd = 0
  private completedTasks = 0
  readonly costCeilingUsd?: number
  private readonly persistence?: CostLedgerPersistence

  constructor(input?: number | CostLedgerOptions) {
    const options = typeof input === 'number' ? { costCeilingUsd: input } : (input ?? {})
    this.costCeilingUsd = options.costCeilingUsd
    this.persistence = options.persistence
    if (this.costCeilingUsd !== undefined) {
      assertNonNegative(this.costCeilingUsd, 'costCeilingUsd')
    }
    if (this.persistence) {
      if (options.resume === false) this.persistence.write('')
      else this.receipts.push(...parseReceipts(this.persistence.read()))
    }
    if (options.receipts) this.receipts.push(...options.receipts.map(cloneReceipt))
  }

  runPaidCall<T>(input: RunPaidCallInput<T>): Promise<PaidCallResult<T>> {
    if (this.costCeilingUsd === undefined) return this.execute(input)
    const maximumCostUsd = this.resolveMaximum(input.maximumCharge)
    if (maximumCostUsd instanceof Error) {
      return Promise.resolve({ succeeded: false, error: maximumCostUsd })
    }
    const summary = this.summary()
    if (!summary.accountingComplete) {
      return Promise.resolve({
        succeeded: false,
        error: new CostAccountingIncompleteError(
          `CostLedger: accounting is incomplete; refusing paid call '${input.actor}' during '${input.phase}'`,
        ),
      })
    }
    const committedAndReserved = summary.totalCostUsd + this.reservedUsd
    if (committedAndReserved + maximumCostUsd > this.costCeilingUsd) {
      return Promise.resolve({
        succeeded: false,
        error: new CostCeilingReachedError(
          this.costCeilingUsd,
          committedAndReserved,
          maximumCostUsd,
          input.phase,
          input.actor,
        ),
      })
    }
    this.reservedUsd += maximumCostUsd
    return this.execute(input, maximumCostUsd).finally(() => {
      this.reservedUsd -= maximumCostUsd
    })
  }

  list(filter?: CostLedgerFilter): CostReceipt[] {
    return this.receipts.filter((receipt) => matches(receipt, filter)).map(cloneReceipt)
  }

  summary(filter?: CostLedgerFilter): CostLedgerSummary {
    const receipts = this.receipts.filter((receipt) => matches(receipt, filter))
    const byChannel = new Map<string, ChannelRollup>()
    const unpriced = new Set<string>()
    const incompleteReasons: string[] = []
    let inputTokens = 0
    let outputTokens = 0
    let cachedTokens = 0
    let totalCostUsd = 0

    for (const receipt of receipts) {
      inputTokens += receipt.inputTokens
      outputTokens += receipt.outputTokens
      cachedTokens += receipt.cachedTokens ?? 0
      totalCostUsd += receipt.costUsd
      if (receipt.costUnknown) {
        unpriced.add(receipt.model)
        incompleteReasons.push(
          receipt.error ?? `cost unknown for '${receipt.actor}' using '${receipt.model}'`,
        )
      }
      if (!receipt.terminationConfirmed) {
        incompleteReasons.push(`external termination unconfirmed for '${receipt.actor}'`)
      }
      if (receipt.maximumCostUsd !== undefined && receipt.costUsd > receipt.maximumCostUsd) {
        incompleteReasons.push(
          `'${receipt.actor}' charged ${receipt.costUsd}, exceeding its declared maximum ${receipt.maximumCostUsd}`,
        )
      }
      const rollup = byChannel.get(receipt.channel) ?? {
        channel: receipt.channel,
        calls: 0,
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        costUsd: 0,
        unpricedCalls: 0,
      }
      rollup.calls += 1
      rollup.inputTokens += receipt.inputTokens
      rollup.outputTokens += receipt.outputTokens
      rollup.cachedTokens += receipt.cachedTokens ?? 0
      rollup.costUsd += receipt.costUsd
      if (receipt.costUnknown) rollup.unpricedCalls += 1
      byChannel.set(receipt.channel, rollup)
    }

    return {
      totalCalls: receipts.length,
      inputTokens,
      outputTokens,
      cachedTokens,
      totalCostUsd,
      byChannel: [...byChannel.values()].sort((a, b) => a.channel.localeCompare(b.channel)),
      unpricedModels: [...unpriced].sort(),
      fullyPriced: unpriced.size === 0,
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
    this.completedTasks += count
  }

  costPerCompletedTask(): number | null {
    return this.completedTasks === 0 ? null : this.summary().totalCostUsd / this.completedTasks
  }

  private async execute<T>(
    input: RunPaidCallInput<T>,
    maximumCostUsd?: number,
  ): Promise<PaidCallResult<T>> {
    const signal = input.signal ?? new AbortController().signal
    if (signal.aborted) {
      return { succeeded: false, error: abortError(signal) }
    }

    const operation = Promise.resolve().then(() => input.execute(signal))
    const settled = await settle(operation, signal)
    if (settled.kind === 'aborted') {
      void operation.catch(() => undefined)
      return this.failure(input, abortError(signal), false, maximumCostUsd)
    }

    if (settled.kind === 'error') {
      let observed: CostReceiptInput | undefined
      try {
        observed = input.receiptFromError?.(settled.error)
      } catch (error) {
        return this.failure(input, toError(error), true, maximumCostUsd)
      }
      return this.failure(input, settled.error, true, maximumCostUsd, observed)
    }

    try {
      const receipt = this.append(input, input.receipt(settled.value), true, maximumCostUsd)
      if (maximumCostUsd !== undefined && receipt.costUsd > maximumCostUsd) {
        return {
          succeeded: false,
          error: new CostReservationExceededError(input.actor, receipt.costUsd, maximumCostUsd),
          receipt,
        }
      }
      return { succeeded: true, value: settled.value, receipt }
    } catch (error) {
      return this.failure(input, toError(error), true, maximumCostUsd)
    }
  }

  private failure<T>(
    input: RunPaidCallInput<T>,
    error: Error,
    terminationConfirmed: boolean,
    maximumCostUsd?: number,
    observed?: CostReceiptInput,
  ): PaidCallResult<T> {
    const receipt = this.append(
      input,
      observed ?? {
        model: input.model ?? 'unknown',
        inputTokens: 0,
        outputTokens: 0,
        costUnknown: true,
      },
      terminationConfirmed,
      maximumCostUsd,
      error.message,
    )
    return { succeeded: false, error, receipt }
  }

  private append(
    input: Pick<RunPaidCallInput<unknown>, 'channel' | 'phase' | 'actor' | 'tags'>,
    observed: CostReceiptInput,
    terminationConfirmed: boolean,
    maximumCostUsd?: number,
    error?: string,
  ): CostReceipt {
    assertUsage(observed)
    const estimated = costForUsage(observed.model, observed)
    const hasActual = observed.actualCostUsd !== undefined
    const explicitlyUnknown = observed.costUnknown === true
    if (hasActual && explicitlyUnknown) {
      throw new ValidationError(
        'CostLedger: a receipt cannot have both actualCostUsd and costUnknown=true',
      )
    }
    if (hasActual) assertNonNegative(observed.actualCostUsd as number, 'actualCostUsd')
    const receipt: CostReceipt = {
      ...observed,
      channel: input.channel,
      phase: input.phase,
      actor: input.actor,
      costUsd: hasActual ? (observed.actualCostUsd as number) : estimated.costUsd,
      costUnknown: explicitlyUnknown || (!hasActual && estimated.costUnknown),
      maximumCostUsd,
      terminationConfirmed,
      error,
      tags: input.tags,
      timestamp: Date.now(),
    }
    this.receipts.push(receipt)
    if (this.persistence) {
      const content = this.receipts.map((item) => JSON.stringify(item)).join('\n')
      this.persistence.write(`${content}\n`)
    }
    return cloneReceipt(receipt)
  }

  private resolveMaximum(maximum: MaximumCharge | undefined): number | Error {
    if (!maximum) {
      return new CostAccountingIncompleteError(
        'CostLedger: capped paid calls require a hard maximumCharge before execution',
      )
    }
    if ('providerLimitUsd' in maximum) {
      try {
        assertNonNegative(maximum.providerLimitUsd, 'maximumCharge.providerLimitUsd')
        return maximum.providerLimitUsd
      } catch (error) {
        return toError(error)
      }
    }
    try {
      const priced = costForUsage(maximum.model, maximum)
      return priced.costUnknown
        ? new CostAccountingIncompleteError(
            `CostLedger: cannot reserve unpriced model '${maximum.model}' in a capped run`,
          )
        : priced.costUsd
    } catch (error) {
      return toError(error)
    }
  }
}

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
    costUsd: estimateCost(usage.inputTokens + (usage.cachedTokens ?? 0), usage.outputTokens, model),
    costUnknown: false,
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
    promise.then(
      (value) => finish({ kind: 'value', value }),
      (error) => finish({ kind: 'error', error: toError(error) }),
    )
  })
}

function parseReceipts(serialized: string | undefined): CostReceipt[] {
  if (!serialized?.trim()) return []
  return serialized
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line, index) => {
      try {
        const receipt = JSON.parse(line) as CostReceipt
        if (!validReceipt(receipt)) throw new Error('invalid receipt shape')
        return receipt
      } catch (error) {
        throw new ValidationError(
          `CostLedger: invalid persisted receipt at line ${index + 1}: ${toError(error).message}`,
        )
      }
    })
}

function matches(receipt: CostReceipt, filter: CostLedgerFilter | undefined): boolean {
  if (!filter) return true
  if (filter.channel !== undefined && receipt.channel !== filter.channel) return false
  if (filter.phase !== undefined && receipt.phase !== filter.phase) return false
  return Object.entries(filter.tags ?? {}).every(([key, value]) => receipt.tags?.[key] === value)
}

function validReceipt(value: unknown): value is CostReceipt {
  if (!value || typeof value !== 'object') return false
  const receipt = value as Partial<CostReceipt>
  return (
    typeof receipt.model === 'string' &&
    typeof receipt.channel === 'string' &&
    typeof receipt.phase === 'string' &&
    typeof receipt.actor === 'string' &&
    typeof receipt.inputTokens === 'number' &&
    typeof receipt.outputTokens === 'number' &&
    typeof receipt.costUsd === 'number' &&
    typeof receipt.costUnknown === 'boolean' &&
    typeof receipt.terminationConfirmed === 'boolean' &&
    typeof receipt.timestamp === 'number'
  )
}

function cloneReceipt(receipt: CostReceipt): CostReceipt {
  return { ...receipt, tags: receipt.tags ? { ...receipt.tags } : undefined }
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

function assertUsage(usage: CostUsage): void {
  assertNonNegative(usage.inputTokens, 'inputTokens')
  assertNonNegative(usage.outputTokens, 'outputTokens')
  if (usage.cachedTokens !== undefined) assertNonNegative(usage.cachedTokens, 'cachedTokens')
}

function assertNonNegative(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new ValidationError(
      `CostLedger: ${name} must be a non-negative finite number, got ${value}`,
    )
  }
}
