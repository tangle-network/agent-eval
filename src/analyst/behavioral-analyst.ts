/**
 * `behavioralAnalyst` — a DETERMINISTIC analyst (cost.kind = 'deterministic',
 * never calls the LLM). It produces the efficiency/behavioral findings a
 * tolerant agentic analyzer (HALO) re-derives per run inside the model —
 * context bloat, output decay, tool monoculture, missing self-verification —
 * directly from arithmetic over spans (`computeTraceMetrics`).
 *
 * Why it matters: these findings are model-agnostic BY CONSTRUCTION (no model
 * in the loop), so they cannot return 0 on a weak model the way the Ax-RLM
 * does — and they are strictly more reliable than HALO, which spends tokens
 * re-deriving the same numbers and can hallucinate the trend. The agentic
 * RLM kinds remain for SEMANTIC findings that genuinely need a model; this
 * analyst owns the behavioral class.
 */

import {
  type BehavioralMetrics,
  computeTraceMetrics,
  type SuboptimalCode,
} from '../trace-analyst/behavioral-metrics'
import type { TraceAnalysisStore } from '../trace-analyst/store'
import { type Analyst, type AnalystFinding, makeFinding } from './types'

const RECOMMENDED_ACTION: Record<SuboptimalCode, string> = {
  'monotonic-input-growth':
    'Inspect context assembly; if prior history is repeatedly included, summarize completed work before the next model call.',
  'output-length-decay':
    'Check late-step completeness; if shorter responses omit required work, add explicit completion criteria to the agent instructions.',
  'single-tool-dependency':
    'Test whether an inspect or verification tool improves outcomes after the repeated call fails or returns no progress.',
  'no-self-verification':
    'After state-changing actions, require an observable check before the agent proceeds.',
}

const ANALYST_ID = 'efficiency-behavioral'

/**
 * Map computed signals → structured AnalystFindings. Pure: no LLM, no clock
 * dependence beyond `produced_at` (overridable for deterministic tests).
 */
export function deriveEfficiencyFindings(
  metrics: BehavioralMetrics,
  opts: { analystId?: string; producedAt?: string } = {},
): AnalystFinding[] {
  const analystId = opts.analystId ?? ANALYST_ID
  const traceId = metrics.traceId
  return metrics.signals.map((sig) =>
    makeFinding({
      analyst_id: analystId,
      area: 'efficiency',
      subject: sig.code,
      claim: sig.detail,
      severity: sig.severity,
      // Deterministic arithmetic over spans, not a model judgment → certain.
      confidence: 1,
      evidence_refs: [
        {
          kind: 'metric',
          uri: traceId
            ? `metric://trace/${encodeURIComponent(traceId)}/efficiency/${sig.code}`
            : `metric://efficiency/${sig.code}`,
          excerpt: JSON.stringify(sig.evidence),
        },
      ],
      recommended_action: RECOMMENDED_ACTION[sig.code],
      metadata: {
        deterministic: true,
        evidence: sig.evidence,
        ...(traceId ? { trace_id: traceId } : {}),
      },
      ...(traceId ? { id_basis: `${traceId}:${sig.code}` } : {}),
      ...(opts.producedAt ? { produced_at: opts.producedAt } : {}),
    }),
  )
}

/** The deterministic behavioral/efficiency analyst (no LLM, any-model). */
export function behavioralAnalyst(): Analyst<TraceAnalysisStore> {
  return {
    id: ANALYST_ID,
    description:
      'Deterministic behavioral/efficiency findings over OTLP spans — token-growth, output-decay, tool-monoculture, missing self-verification. Zero LLM; model-agnostic by construction.',
    inputKind: 'trace-store',
    cost: { kind: 'deterministic' },
    version: '2.0.0',
    async analyze(store) {
      const overview = await store.getOverview()
      const findings: AnalystFinding[] = []
      for (const traceId of overview.sample_trace_ids) {
        const viewed = await store.viewTrace({ trace_id: traceId })
        if (viewed.trace_id !== traceId) {
          throw new Error(
            `behavioralAnalyst: requested trace '${traceId}', received '${viewed.trace_id}'`,
          )
        }
        if (!viewed.spans) {
          throw new Error(
            `behavioralAnalyst: trace '${traceId}' is oversized; complete spans are required`,
          )
        }
        const metrics = computeTraceMetrics(viewed.spans)
        if (metrics.traceId !== null && metrics.traceId !== traceId) {
          throw new Error(
            `behavioralAnalyst: requested trace '${traceId}', received '${metrics.traceId}'`,
          )
        }
        findings.push(...deriveEfficiencyFindings(metrics))
      }
      return findings
    },
  }
}
