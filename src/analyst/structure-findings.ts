/**
 * `structureFindings` — the deferred structuring pass (DSPy TwoStepAdapter /
 * HALO `synthesize_traces` analog). The agentic actor reasons FREE-FORM and
 * emits a prose `report` (which any model does reliably); this separate, cheap
 * call's ONLY job is to turn that report into `AnalystFinding[]`. Decoupling
 * reasoning from structuring is what makes the SEMANTIC findings model-agnostic
 * — the reasoning model never has to satisfy a strict typed-array contract
 * while it diagnoses.
 *
 * Forgiving: the response runs through `coerceToFindingRows` (de-fence, lift
 * single→array) before Zod, and on a zero-finding extraction from a substantive
 * report it reasks ONCE with the schema restated. Returns a typed outcome so a
 * legitimate "nothing to report" is distinguishable from a failed extraction
 * (no silent empty).
 */

import { CostLedger, type CostLedgerHandle } from '../cost-ledger'
import {
  callLlm,
  costReceiptFromLlm,
  costReceiptFromLlmError,
  type LlmCallRequest,
  type LlmClientOptions,
  maximumChargeForLlmRequest,
} from '../llm-client'
import {
  applyLegacyRawFindingCallback,
  type CanonicalRawAnalystFinding,
  evidenceRefsFromRawFinding,
  parseCanonicalRawFinding,
  RAW_FINDING_SCHEMA_PROMPT,
  type RawAnalystFinding,
} from './finding-signature'
import { coerceToFindingRows } from './parse-tolerant'
import { type AnalystFinding, makeFinding } from './types'

export interface StructureFindingsOptions {
  /** The actor's free-form diagnosis prose. */
  report: string
  analystId: string
  /** Coarse classification stamped on every extracted finding. */
  area: string
  model: string
  baseUrl: string
  apiKey?: string
  /** Optional ledger for direct use. */
  costLedger?: CostLedgerHandle
  costPhase?: string
  costTags?: Record<string, string>
  maxTokens?: number
  signal?: AbortSignal
  /** Max reask attempts after a zero/invalid extraction. Default 1. */
  maxReasks?: number
  /** Apply the caller's normal finding rules before a recovered row is lifted. */
  processRow?: (row: RawAnalystFinding) => RawAnalystFinding | null
  /** Apply canonical multi-citation rules after any original callback. */
  processCanonicalRow?: (row: CanonicalRawAnalystFinding) => CanonicalRawAnalystFinding | null
  /** Provenance copied onto every recovered finding. */
  findingMetadata?: Record<string, unknown>
  /** Test seam: inject a fetch (no network in unit tests). */
  fetchImpl?: LlmClientOptions['fetch']
}

export interface StructureFindingsResult {
  findings: AnalystFinding[]
  outcome: 'ok' | 'extraction_failed'
}

const SYSTEM = [
  'You convert a free-form trace-analysis report into a STRICT JSON array of findings.',
  'Output ONLY the JSON array — no prose, no code fences.',
  RAW_FINDING_SCHEMA_PROMPT,
  'Omit subject when the report does not contain an exact valid locus.',
  'If the report asserts NO problems, output exactly [].',
].join(' ')

function buildRows(raw: unknown, opts: StructureFindingsOptions): AnalystFinding[] {
  const rows = coerceToFindingRows(raw)
  const out: AnalystFinding[] = []
  for (const row of rows) {
    const parsed = parseCanonicalRawFinding(row)
    if (!parsed) continue
    const callbackProcessed = opts.processRow
      ? applyLegacyRawFindingCallback(parsed, opts.processRow)
      : parsed
    if (!callbackProcessed) continue
    const processed = opts.processCanonicalRow
      ? opts.processCanonicalRow(callbackProcessed)
      : callbackProcessed
    if (!processed) continue
    out.push(
      makeFinding({
        analyst_id: opts.analystId,
        area: opts.area,
        subject: processed.subject,
        claim: processed.claim,
        rationale: processed.rationale,
        severity: processed.severity,
        confidence: processed.confidence,
        evidence_refs: evidenceRefsFromRawFinding(processed),
        recommended_action: processed.recommended_action,
        ...(opts.findingMetadata ? { metadata: { ...opts.findingMetadata } } : {}),
      }),
    )
  }
  return out
}

export async function structureFindings(
  opts: StructureFindingsOptions,
): Promise<StructureFindingsResult> {
  const maxReasks = opts.maxReasks ?? 1
  if (!Number.isSafeInteger(maxReasks) || maxReasks < 0) {
    throw new RangeError('structureFindings: maxReasks must be a non-negative safe integer')
  }
  const llm = { baseUrl: opts.baseUrl, apiKey: opts.apiKey, fetch: opts.fetchImpl }
  const costLedger = opts.costLedger ?? new CostLedger()
  let user = `TRACE-ANALYSIS REPORT:\n${opts.report}\n\nReturn the findings JSON array.`

  for (let attempt = 0; attempt <= maxReasks; attempt++) {
    const request: LlmCallRequest = {
      model: opts.model,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: user },
      ],
      maxTokens: opts.maxTokens ?? 2_000,
    }
    const paid = await costLedger.runPaidCall({
      channel: 'analyst',
      phase: opts.costPhase ?? 'analyst.structure-findings',
      actor: 'structure-findings',
      model: opts.model,
      signal: opts.signal,
      maximumCharge: maximumChargeForLlmRequest(request, llm),
      tags: { ...opts.costTags, analystId: opts.analystId, attempt: String(attempt) },
      execute: (signal, callId) => callLlm(request, { ...llm, signal, idempotencyKey: callId }),
      receipt: costReceiptFromLlm,
      receiptFromError: costReceiptFromLlmError,
    })
    if (!paid.succeeded) throw paid.error
    const res = paid.value
    const text = res.content.trim()
    const findings = buildRows(text, opts)
    if (findings.length > 0) return { findings, outcome: 'ok' }
    // A report that asserts nothing is a legitimate empty — only reask when the
    // report is substantive (the extraction, not the diagnosis, likely failed).
    if (opts.report.trim().length < 200) return { findings: [], outcome: 'ok' }
    user = `${user}\n\nThat produced no valid findings. The report DOES describe issues — re-extract them as the strict JSON array described in the system prompt. Output ONLY the array.`
  }
  return { findings: [], outcome: 'extraction_failed' }
}
