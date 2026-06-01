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
import type { TraceAnalystSpan } from '../trace-analyst/types'
import { type Analyst, type AnalystFinding, makeFinding } from './types'

const RECOMMENDED_ACTION: Record<SuboptimalCode, string> = {
  'monotonic-input-growth':
    'Add a context-budget instruction: once prior context exceeds a threshold, summarize earlier steps into a short status line instead of re-sending full history.',
  'output-length-decay':
    'Require a minimum planning/reasoning budget per step so late steps do not degrade into terse, error-prone commands.',
  'single-tool-dependency':
    'Direct the agent to use the full toolset (verify / inspect / alternate actions), not a single execute call, and to plan a fallback when a call returns an unexpected result.',
  'no-self-verification':
    'After every state-mutating action, verify the result (eval / inspect / assert) before proceeding.',
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
  return metrics.signals.map((sig) =>
    makeFinding({
      analyst_id: analystId,
      area: 'efficiency',
      subject: sig.code, // kebab — passes the cluster grammar; stable key for diffFindings
      claim: sig.detail,
      severity: sig.severity,
      // Deterministic arithmetic over spans, not a model judgment → certain.
      confidence: 1,
      evidence_refs: [
        {
          kind: 'metric',
          uri: `metric://efficiency/${sig.code}`,
          excerpt: JSON.stringify(sig.evidence),
        },
      ],
      recommended_action: RECOMMENDED_ACTION[sig.code],
      metadata: { deterministic: true, evidence: sig.evidence },
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
    version: '1.0.0',
    async analyze(store) {
      const overview = await store.getOverview()
      const spans: TraceAnalystSpan[] = []
      for (const traceId of overview.sample_trace_ids) {
        const viewed = await store.viewTrace({ trace_id: traceId })
        if (viewed.spans) spans.push(...viewed.spans)
      }
      return deriveEfficiencyFindings(computeTraceMetrics(spans))
    },
  }
}
