/** Parse the append-only journal and enforce immutable pending-to-settled transitions. */
import { z } from 'zod'
import { ValidationError } from '../errors'
import type { CostCallBase, CostLedgerRecord, CostReceipt, PendingCostCall } from './contract'
import { CostCallConflictError } from './errors'
import {
  CostReceiptSchema,
  cloneRecord,
  NonNegative,
  PendingCostCallSchema,
  TokenCount,
} from './receipts'
import { validationMessage } from './validation'

interface PendingCostCallEvent {
  version: 1
  record: PendingCostCall
}

interface SettledCostCallEvent {
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

export type CostCallEvent = PendingCostCallEvent | SettledCostCallEvent
export type CostLedgerEvent = CostCallEvent | CompletedTasksEvent | CostLimitEvent

const CostLedgerEventSchema = z.union([
  z.strictObject({
    version: z.literal(1),
    record: PendingCostCallSchema,
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

export function parseEvents(serialized: string): {
  records: CostLedgerRecord[]
  completedTasks: number
  costCeilingUsd?: number
} {
  const records = new Map<string, CostLedgerRecord>()
  let completedTasks = 0
  let costCeilingUsd: number | undefined
  let lineNumber = 0
  try {
    for (const line of completeJournalPrefix(serialized).split('\n')) {
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

function completeJournalPrefix(serialized: string): string {
  if (!serialized || serialized.endsWith('\n')) return serialized
  const finalNewline = serialized.lastIndexOf('\n')
  const tail = serialized.slice(finalNewline + 1)
  try {
    JSON.parse(tail)
  } catch {
    return finalNewline < 0 ? '' : serialized.slice(0, finalNewline + 1)
  }
  throw new ValidationError(
    'CostLedger: complete final persisted event is missing its newline terminator',
  )
}

export function validateTransition(
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
    sameTags(before.tags, after.tags)
  )
}

function sameTags(
  left: Readonly<Record<string, string>> | undefined,
  right: Readonly<Record<string, string>> | undefined,
): boolean {
  const leftEntries = Object.entries(left ?? {}).sort(([a], [b]) => a.localeCompare(b))
  const rightEntries = Object.entries(right ?? {}).sort(([a], [b]) => a.localeCompare(b))
  return JSON.stringify(leftEntries) === JSON.stringify(rightEntries)
}
