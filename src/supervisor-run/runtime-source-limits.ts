import { nonEmptyString, recordOrNull as record } from './source-facts'
import type { SourceLimits } from './types'

function spendRecord(value: unknown): Record<string, unknown> | null {
  const spend = record(value)
  if (spend === null) return null
  const tokens = record(spend.tokens)
  if (
    tokens === null ||
    typeof tokens.input !== 'number' ||
    !Number.isFinite(tokens.input) ||
    tokens.input < 0 ||
    typeof tokens.output !== 'number' ||
    !Number.isFinite(tokens.output) ||
    tokens.output < 0 ||
    typeof spend.usd !== 'number' ||
    !Number.isFinite(spend.usd) ||
    spend.usd < 0 ||
    (spend.usdKnown !== undefined && typeof spend.usdKnown !== 'boolean')
  ) {
    return null
  }
  return spend
}

export function sourceLimits(
  root: string,
  events: readonly Record<string, unknown>[],
  workerIds: ReadonlySet<string>,
): SourceLimits {
  const rootMeters = events.filter((event) => event.kind === 'metered' && event.id === root)
  const invalidRootMeters = rootMeters.filter((event) => spendRecord(event.spend) === null)
  const rootMeterReason =
    rootMeters.length === 0
      ? 'Runtime journal has no root metered event'
      : invalidRootMeters.length > 0
        ? `${invalidRootMeters.length} root metered event(s) lack complete spend`
        : null
  const closes = events.filter(
    (event) =>
      workerIds.has(nonEmptyString(event.id) ?? '') &&
      (event.kind === 'settled' || event.kind === 'cancelled'),
  )
  const settledById = new Map<string, Record<string, unknown>[]>()
  for (const event of closes) {
    const id = nonEmptyString(event.id)
    if (id === null) continue
    const matches = settledById.get(id) ?? []
    matches.push(event)
    settledById.set(id, matches)
  }
  const incompleteWorkers = [...workerIds].filter((id) => {
    const terminal = settledById.get(id)
    return (
      terminal?.length !== 1 ||
      terminal[0]?.kind !== 'settled' ||
      spendRecord(terminal[0]?.spent) === null
    )
  })
  const missingVerdicts = [...workerIds].filter((id) => {
    const terminal = settledById.get(id)?.[0]
    if (terminal?.kind !== 'settled') return true
    const verdict = record(terminal.verdict)
    return typeof verdict?.valid !== 'boolean'
  })

  return {
    managerTokens: rootMeterReason,
    workerTokens:
      incompleteWorkers.length === 0
        ? null
        : `${incompleteWorkers.length}/${workerIds.size} child invocation(s) lack one settled spend record`,
    // `usdKnown: false` on ONE record is not a limit of this store: the store priced every
    // other record, and a limit here discards them all. The analyzer folds the flag per
    // record instead, and reports a partial total with the unpriced nodes named.
    spendUsd:
      rootMeterReason !== null
        ? rootMeterReason
        : incompleteWorkers.length > 0
          ? 'at least one child invocation lacks a settled spend record'
          : null,
    workerVerdicts:
      missingVerdicts.length === 0
        ? null
        : `${missingVerdicts.length}/${workerIds.size} child invocation(s) lack a structured validity verdict`,
    deliverables:
      workerIds.size === 0
        ? null
        : 'Runtime FileRunContext does not retain per-child delivered patches',
  }
}
