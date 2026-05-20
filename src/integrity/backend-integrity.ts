/**
 * Backend-integrity guard: distinguish "agent failed" from "eval ran against
 * a stub / unconfigured backend." Without this guard a canonical eval can
 * silently report `0/N passed` and look like an agent-quality problem when
 * the LLM was never actually called — the failure mode we just hit running
 * the 4-vertical parallel eval (legal-sandbox-stub returned hard-coded 33-104
 * char strings; gtm/creative defaulted to a cli-bridge that wasn't running).
 *
 * The shape:
 *
 *   const report = summarizeBackendIntegrity(records)
 *   assertRealBackend(records)   // throws BackendIntegrityError if 100% stub
 *
 * A record is "stub-mode" if its `tokenUsage.input === 0 && tokenUsage.output === 0`.
 * (`costUsd` alone is unreliable — some backends successfully call LLMs but
 *  don't propagate pricing, producing real tokens with $0 cost.)
 *
 * Verdicts:
 *   - `real`   — at least one record has nonzero token usage
 *   - `stub`   — every record is stub-mode (eval ran blind)
 *   - `mixed`  — some records real, some stub (partial backend failure;
 *                often the 429-cascade or auth-half-failed case)
 */

import { AgentEvalError } from '../errors'
import type { RunRecord } from '../run-record'

export interface BackendIntegrityReport {
  /** Total records inspected. */
  totalRecords: number
  /** Records with input=0 AND output=0 (a stub fingerprint). */
  stubRecords: number
  /** Records with nonzero token usage (real LLM activity). */
  realRecords: number
  /** Records where output>0 but costUsd=0 (real LLM, broken cost ledger). */
  uncostedRecords: number
  /** Sum of input tokens across all records. */
  totalInputTokens: number
  /** Sum of output tokens across all records. */
  totalOutputTokens: number
  /** Sum of costUsd across all records. */
  totalCostUsd: number
  /** Worst-case integrity verdict. */
  verdict: 'real' | 'mixed' | 'stub'
  /** Human-readable diagnosis suitable for terminal output. */
  diagnosis: string
}

/**
 * Error thrown when an integrity assertion fails. Caller can pattern-match
 * by `code === 'AGENT_EVAL_BACKEND_STUB'` to differentiate from other
 * errors.
 */
export class BackendIntegrityError extends AgentEvalError {
  constructor(
    message: string,
    public readonly report: BackendIntegrityReport,
  ) {
    super('backend_integrity', message)
  }
}

function isStubRecord(rec: RunRecord): boolean {
  return rec.tokenUsage.input === 0 && rec.tokenUsage.output === 0
}

function isUncostedRecord(rec: RunRecord): boolean {
  return rec.tokenUsage.output > 0 && rec.costUsd === 0
}

/**
 * Inspect a batch of RunRecords and return an integrity report. Pure
 * function — no I/O, no logging. The caller decides what to do with the
 * verdict (print warning, throw, gate CI, etc.).
 */
export function summarizeBackendIntegrity(
  records: ReadonlyArray<RunRecord>,
): BackendIntegrityReport {
  const totalRecords = records.length
  let stubRecords = 0
  let realRecords = 0
  let uncostedRecords = 0
  let totalInputTokens = 0
  let totalOutputTokens = 0
  let totalCostUsd = 0
  for (const rec of records) {
    totalInputTokens += rec.tokenUsage.input
    totalOutputTokens += rec.tokenUsage.output
    totalCostUsd += rec.costUsd
    if (isStubRecord(rec)) stubRecords++
    else realRecords++
    if (isUncostedRecord(rec)) uncostedRecords++
  }
  const verdict: BackendIntegrityReport['verdict'] =
    totalRecords === 0
      ? 'stub'
      : stubRecords === totalRecords
        ? 'stub'
        : stubRecords === 0
          ? 'real'
          : 'mixed'
  const diagnosis = buildDiagnosis({
    totalRecords,
    stubRecords,
    realRecords,
    uncostedRecords,
    totalInputTokens,
    totalOutputTokens,
    totalCostUsd,
    verdict,
  })
  return {
    totalRecords,
    stubRecords,
    realRecords,
    uncostedRecords,
    totalInputTokens,
    totalOutputTokens,
    totalCostUsd,
    verdict,
    diagnosis,
  }
}

function buildDiagnosis(r: Omit<BackendIntegrityReport, 'diagnosis'>): string {
  if (r.totalRecords === 0) {
    return 'no records — eval produced zero runs; backend likely failed before first turn'
  }
  if (r.verdict === 'stub') {
    return [
      `all ${r.totalRecords} records have zero token usage — the LLM backend was never called.`,
      'common causes: --backend sandbox without a sandbox bridge running; stub model returning hard-coded strings;',
      'auth misconfigured so requests were silently dropped before the LLM. Re-run with --backend tcloud and TANGLE_API_KEY set,',
      'or boot the cli-bridge / sandbox before invoking the eval.',
    ].join(' ')
  }
  if (r.verdict === 'mixed') {
    const pct = ((r.stubRecords / r.totalRecords) * 100).toFixed(0)
    return [
      `${r.stubRecords}/${r.totalRecords} records (${pct}%) have zero token usage — the backend partially failed.`,
      'common causes: rate-limit cascade (429s after the first N personas);',
      'transient auth expiry mid-run; provider outage. Treat the affected records as missing data, not agent failures.',
    ].join(' ')
  }
  // verdict === 'real'
  if (r.uncostedRecords > 0) {
    const pct = ((r.uncostedRecords / r.totalRecords) * 100).toFixed(0)
    return [
      `${r.totalRecords} records with real LLM activity (in=${r.totalInputTokens}, out=${r.totalOutputTokens} tokens).`,
      `${r.uncostedRecords} (${pct}%) have output tokens but costUsd=0 — cost ledger is mis-wired (no input-token`,
      'propagation from the runtime stream into RunRecord).',
    ].join(' ')
  }
  return `${r.totalRecords} records with real LLM activity (in=${r.totalInputTokens}, out=${r.totalOutputTokens} tokens, $${r.totalCostUsd.toFixed(4)}).`
}

/**
 * Throw BackendIntegrityError if the verdict is 'stub' — i.e. every record
 * shows zero LLM activity. Non-strict callers can pass `{ allowMixed: false }`
 * to also reject mixed verdicts (recommended for CI gates).
 *
 * Real backends pass through silently.
 */
export function assertRealBackend(
  records: ReadonlyArray<RunRecord>,
  opts: { allowMixed?: boolean } = {},
): BackendIntegrityReport {
  const report = summarizeBackendIntegrity(records)
  const allowMixed = opts.allowMixed ?? true
  if (report.verdict === 'stub') {
    throw new BackendIntegrityError(
      `backend-integrity: ran against a stub or unconfigured backend — ${report.diagnosis}`,
      report,
    )
  }
  if (!allowMixed && report.verdict === 'mixed') {
    throw new BackendIntegrityError(
      `backend-integrity: partial backend failure rejected — ${report.diagnosis}`,
      report,
    )
  }
  return report
}
