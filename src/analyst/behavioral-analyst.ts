/**
 * Deterministic behavioral analysis over arithmetic in trace spans.
 * This pass is cheap and repeatable; semantic analysis remains the job of
 * model-backed analysts. Relative quality requires a labeled comparison.
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
const DEFAULT_MAX_TRACES = 1_000
const DEFAULT_MAX_EVIDENCE_REFS = 20
const TRACE_PAGE_SIZE = 200

export interface BehavioralAnalystOptions {
  /** Refuse larger unfiltered datasets instead of sampling them silently. Default 1,000. */
  maxTraces?: number
  /** Evidence locations retained per finding. Counts still cover every analyzed trace. Default 20. */
  maxEvidenceRefsPerFinding?: number
}

const AGGREGATE_CLAIM: Record<SuboptimalCode, (observed: number, analyzed: number) => string> = {
  'monotonic-input-growth': (observed, analyzed) =>
    `${observed}/${analyzed} analyzed traces showed input tokens grow from zero to nonzero or to at least 3x their initial value across at least 3 serial model calls without a decrease.`,
  'output-length-decay': (observed, analyzed) =>
    `${observed}/${analyzed} analyzed traces showed output tokens decrease while input tokens increased monotonically across at least 3 serial model calls.`,
  'single-tool-dependency': (observed, analyzed) =>
    `${observed}/${analyzed} analyzed traces used only one named tool across at least 3 tool calls.`,
  'no-self-verification': (observed, analyzed) =>
    `${observed}/${analyzed} analyzed traces had at least 3 tool calls without a verification-named tool call.`,
}

async function listTraceIds(
  store: TraceAnalysisStore,
  maxTraces: number,
  signal?: AbortSignal,
): Promise<string[]> {
  const traceIds = new Set<string>()
  let offset = 0
  let expectedTotal: number | undefined

  while (true) {
    signal?.throwIfAborted()
    const page = await store.queryTraces({ limit: TRACE_PAGE_SIZE, offset })
    if (expectedTotal === undefined) expectedTotal = page.total
    if (page.total !== expectedTotal) {
      throw new Error(
        `behavioralAnalyst: trace count changed during pagination (${expectedTotal} to ${page.total})`,
      )
    }
    if (page.total > maxTraces) {
      throw new RangeError(
        `behavioralAnalyst: ${page.total} traces exceed maxTraces=${maxTraces}; filter the store or raise the explicit limit`,
      )
    }
    for (const trace of page.traces) traceIds.add(trace.trace_id)
    if (traceIds.size > maxTraces) {
      throw new RangeError(
        `behavioralAnalyst: more than maxTraces=${maxTraces} unique traces were returned`,
      )
    }
    if (!page.has_more) break
    if (page.traces.length === 0) {
      throw new Error('behavioralAnalyst: trace store returned an empty page with has_more=true')
    }
    offset += page.traces.length
  }

  if (traceIds.size !== expectedTotal) {
    throw new Error(
      `behavioralAnalyst: pagination returned ${traceIds.size}/${expectedTotal ?? 0} unique traces`,
    )
  }

  return [...traceIds].sort()
}

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
      id_basis: sig.code,
      ...(opts.producedAt ? { produced_at: opts.producedAt } : {}),
    }),
  )
}

/** The deterministic behavioral/efficiency analyst (no LLM, any-model). */
export function behavioralAnalyst(
  options: BehavioralAnalystOptions = {},
): Analyst<TraceAnalysisStore> {
  const maxTraces = positiveInteger(options.maxTraces ?? DEFAULT_MAX_TRACES, 'maxTraces')
  const maxEvidenceRefsPerFinding = positiveInteger(
    options.maxEvidenceRefsPerFinding ?? DEFAULT_MAX_EVIDENCE_REFS,
    'maxEvidenceRefsPerFinding',
  )
  return {
    id: ANALYST_ID,
    description:
      'Deterministic behavioral/efficiency findings over OTLP spans — token-growth, output-decay, tool-monoculture, missing self-verification. Zero LLM; model-agnostic by construction.',
    inputKind: 'trace-store',
    cost: { kind: 'deterministic' },
    version: '2.0.0',
    async analyze(store, context) {
      const analyzedTraceIds = await listTraceIds(store, maxTraces, context.signal)
      const findingsById = new Map<
        string,
        {
          finding: AnalystFinding
          observedTraceCount: number
          evidenceTraceIds: string[]
          evidence: AnalystFinding['evidence_refs']
        }
      >()
      for (const traceId of analyzedTraceIds) {
        context.signal?.throwIfAborted()
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
        for (const finding of deriveEfficiencyFindings(metrics)) {
          const current = findingsById.get(finding.finding_id)
          if (!current) {
            findingsById.set(finding.finding_id, {
              finding,
              observedTraceCount: 1,
              evidenceTraceIds: [traceId],
              evidence: [...finding.evidence_refs],
            })
            continue
          }
          current.observedTraceCount += 1
          if (current.evidence.length < maxEvidenceRefsPerFinding) {
            current.evidenceTraceIds.push(traceId)
            current.evidence.push(...finding.evidence_refs)
          }
        }
      }
      return [...findingsById.values()].map(
        ({ finding, observedTraceCount, evidenceTraceIds, evidence }) => ({
          ...finding,
          claim: AGGREGATE_CLAIM[finding.subject as SuboptimalCode](
            observedTraceCount,
            analyzedTraceIds.length,
          ),
          rationale: `${observedTraceCount}/${analyzedTraceIds.length} analyzed traces exhibited this pattern.`,
          evidence_refs: evidence,
          metadata: {
            deterministic: true,
            evidence_trace_ids: evidenceTraceIds,
            omitted_evidence_trace_count: observedTraceCount - evidenceTraceIds.length,
            observed_trace_count: observedTraceCount,
            analyzed_trace_count: analyzedTraceIds.length,
          },
        }),
      )
    },
  }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`behavioralAnalyst: ${name} must be a positive safe integer`)
  }
  return value
}
