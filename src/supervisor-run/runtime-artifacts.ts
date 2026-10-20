import { stat } from 'node:fs/promises'
import { nonEmptyString } from './source-facts'
import type { SourceLimits } from './types'

export const JOURNAL_FILE = 'spawn-journal.jsonl'

export const OBSERVER_FILE = 'observer.jsonl'

export const ROOT_STREAM_FILE = 'root-stream.jsonl'

export const BLOB_DIR = 'blobs'

export const RESULT_FILE = 'result.json'

export const FAILURE_FILE = 'failure.json'

export function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

export function parseOptionalRecord(
  text: string | null,
  path: string,
): Record<string, unknown> | null {
  if (text === null) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(`${path}: invalid JSON`)
  }
  const value = record(parsed)
  if (value === null) throw new Error(`${path}: expected a JSON object`)
  return value
}

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

/**
 * Refuse a `result.json` that belongs to another run. Runtime's result carries
 * its own `tree.root`; a settled record with a different root is a copied or
 * misplaced file, and reading its status onto this journal misreports the run.
 */
export function assertResultMatchesJournal(
  root: string,
  result: Record<string, unknown> | null,
  resultPath: string,
): void {
  const resultKind = result === null ? null : nonEmptyString(result.kind)
  if (resultKind === null || result === null) return
  const resultRoot = nonEmptyString(record(result.tree)?.root)
  if (resultRoot === null) {
    throw new Error(`${resultPath}: Runtime ${resultKind} result has no tree.root`)
  }
  if (resultRoot !== root) {
    throw new Error(
      `${resultPath}: root ${JSON.stringify(resultRoot)} does not match journal root ${JSON.stringify(root)}`,
    )
  }
}

/**
 * Refuse a `failure.json` that is not a failure record. Runtime writes
 * `{ runId, pursuitId, at, error: { name, message } }`; a document without an
 * `error` object is not one, and reading it as a failure invents a terminal
 * state the run never recorded. The record carries no tree root, so its
 * identity is not checked against the journal.
 */
export function assertFailureRecord(
  failure: Record<string, unknown> | null,
  failurePath: string,
): void {
  if (failure === null) return
  if (record(failure.error) === null) {
    throw new Error(`${failurePath}: Runtime failure record has no error object`)
  }
}

/**
 * The journal's begin stamp in the analyzer's state-document shape. It carries
 * the run identity and start instant only; the terminal status lives in
 * Runtime's own `result.json` / `failure.json`, which the analyzer reads by
 * name, so no synthetic status field is fabricated here.
 */
export function runtimeBeginState(root: string, startedAt: string): string {
  return JSON.stringify({ id: root, startedAt })
}

export async function isFile(path: string): Promise<boolean> {
  return stat(path)
    .then((entry) => entry.isFile())
    .catch((error: unknown) => {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        ((error as { code: unknown }).code === 'ENOENT' ||
          (error as { code: unknown }).code === 'ENOTDIR')
      ) {
        return false
      }
      throw error
    })
}
