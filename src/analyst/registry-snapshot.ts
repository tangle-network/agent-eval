/** Immutable snapshots at exact execution's untrusted input and observational boundaries. */
import { snapshotAnalystFindings } from '../feedback-trajectory-review'
import { canonicalString } from '../ledger-core/canonical'
import { deepFreezeCanonicalJson } from '../ledger-core/deep-freeze'
import type {
  AnalystFinding,
  AnalystRunEvent,
  AnalystRunSummary,
  AnalystUsageReceipt,
} from './types'
import { assertValidAnalystUsageReceipt } from './usage-receipt'

export function canonicalJsonSnapshot<T>(value: T, label: string): T {
  let snapshot: T
  try {
    snapshot = JSON.parse(canonicalString(value)) as T
  } catch (cause) {
    throw new TypeError(`${label} must be canonical JSON`, { cause })
  }
  return deepFreezeCanonicalJson(snapshot)
}

export function snapshotUsageReceiptOnce(
  receipt: AnalystUsageReceipt,
  context: string,
): AnalystUsageReceipt {
  const data = readOwnFields(receipt, ['calls', 'tokens', 'cost', 'knownCostUsd'], context)
  data.tokens =
    data.tokens === null
      ? null
      : readOwnFields(
          data.tokens,
          ['input', 'output', 'reasoning', 'cached', 'cacheWrite'],
          `${context} tokens`,
        )
  data.cost = readOwnFields(data.cost, ['kind', 'usd'], `${context} cost`)
  const snapshot = canonicalJsonSnapshot(data as unknown as AnalystUsageReceipt, context)
  assertValidAnalystUsageReceipt(snapshot, context)
  return snapshot
}

export function readOwnFields(
  value: unknown,
  fields: readonly string[],
  context: string,
): Record<string, unknown> {
  if (!isPlainRecord(value)) throw new TypeError(`${context} must be a plain object`)
  const unexpected = Object.keys(value).filter((key) => !fields.includes(key))
  if (unexpected.length > 0) {
    throw new TypeError(`${context} contains unknown fields: ${unexpected.sort().join(', ')}`)
  }
  return Object.fromEntries(
    fields.flatMap((field) => (Object.hasOwn(value, field) ? [[field, value[field]]] : [])),
  )
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

export function snapshotExecutionFindings(
  findings: AnalystFinding[],
  exact: boolean,
  context: string,
): AnalystFinding[] {
  return exact ? deepFreezeCanonicalJson(snapshotAnalystFindings(findings, context)) : findings
}

export function snapshotAfterHookValues(
  summary: AnalystRunSummary,
  findings: AnalystFinding[],
  exact: boolean,
): { summary: AnalystRunSummary; findings: AnalystFinding[] } {
  if (!exact) return { summary, findings }
  return {
    summary: canonicalJsonSnapshot(summary, 'AnalystRegistry.runExact onAfterAnalyze summary'),
    findings: deepFreezeCanonicalJson(
      snapshotAnalystFindings(findings, 'AnalystRegistry.runExact onAfterAnalyze findings'),
    ),
  }
}

export function snapshotExecutionEvent<T extends AnalystRunEvent>(event: T, exact: boolean): T {
  return exact ? canonicalJsonSnapshot(event, 'AnalystRegistry.runExact event') : event
}
