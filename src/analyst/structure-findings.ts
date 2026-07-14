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
import { parseRawFinding, type RawAnalystFinding } from './finding-signature'
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
  maxTokens?: number
  /** Max reask attempts after a zero/invalid extraction. Default 1. */
  maxReasks?: number
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
  'Each element: {"severity":"critical|high|medium|low|info","claim":string,"evidence_uri":string,',
  '"subject"?:string,"rationale"?:string,"recommended_action"?:string,"confidence":number(0..1)}.',
  'evidence_uri cites the trace element the report referenced (e.g. "span://<trace>/<span>") or "report://summary".',
  'If the report asserts NO problems, output exactly [].',
].join(' ')

function buildRows(raw: unknown, analystId: string, area: string): AnalystFinding[] {
  const rows = coerceToFindingRows(raw)
  const out: AnalystFinding[] = []
  for (const row of rows) {
    // Recovery findings are extracted from PROSE — the report itself is the
    // evidence. A weak model often returns a sound claim + severity but omits
    // `evidence_uri`; default it to the report rather than dropping the row
    // (the strict evidence_uri requirement is a recovery yield-killer).
    const normalized =
      row &&
      typeof row === 'object' &&
      !Array.isArray(row) &&
      !(row as Record<string, unknown>).evidence_uri
        ? { ...(row as Record<string, unknown>), evidence_uri: 'report://summary' }
        : row
    const parsed: RawAnalystFinding | null = parseRawFinding(normalized)
    if (!parsed) continue
    out.push(
      makeFinding({
        analyst_id: analystId,
        area,
        subject: parsed.subject,
        claim: parsed.claim,
        rationale: parsed.rationale,
        severity: parsed.severity,
        confidence: parsed.confidence,
        evidence_refs: [
          {
            kind: parsed.evidence_uri.startsWith('span://') ? 'span' : 'artifact',
            uri: parsed.evidence_uri,
            excerpt: parsed.evidence_excerpt,
          },
        ],
        recommended_action: parsed.recommended_action,
      }),
    )
  }
  return out
}

export async function structureFindings(
  opts: StructureFindingsOptions,
): Promise<StructureFindingsResult> {
  const maxReasks = opts.maxReasks ?? 1
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
      maximumCharge: maximumChargeForLlmRequest(request, llm),
      tags: { analystId: opts.analystId, attempt: String(attempt) },
      execute: (signal, callId) => callLlm(request, { ...llm, signal, idempotencyKey: callId }),
      receipt: costReceiptFromLlm,
      receiptFromError: costReceiptFromLlmError,
    })
    if (!paid.succeeded) throw paid.error
    const res = paid.value
    const text = res.content.trim()
    const findings = buildRows(text, opts.analystId, opts.area)
    if (findings.length > 0) return { findings, outcome: 'ok' }
    // A report that asserts nothing is a legitimate empty — only reask when the
    // report is substantive (the extraction, not the diagnosis, likely failed).
    if (opts.report.trim().length < 200) return { findings: [], outcome: 'ok' }
    user = `${user}\n\nThat produced no valid findings. The report DOES describe issues — re-extract them as the strict JSON array described in the system prompt. Output ONLY the array.`
  }
  return { findings: [], outcome: 'extraction_failed' }
}
