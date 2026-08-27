/**
 * Adapt the built-in analyst registry to `SurfaceProposer`.
 *
 * The proposer produces structured findings from OTLP traces, then uses the
 * same edit step as `haloProposer`. It rejects missing traces, analysis errors,
 * and empty findings instead of returning a fabricated candidate.
 */

import type { AxAIArgs } from '@ax-llm/ax'
import { createAnalystAi } from '../../analyst/ax-service'
import { createTraceAnalystKind, type TraceAnalystKindSpec } from '../../analyst/kind-factory'
import { DEFAULT_TRACE_ANALYST_KINDS } from '../../analyst/kinds'
import { AnalystRegistry, type RegistryRunOpts } from '../../analyst/registry'
import type { AnalystFinding, AnalystRunResult } from '../../analyst/types'
import type { CostLedgerHandle, CostReceiptInput, MaximumCharge } from '../../cost-ledger'
import type { LlmClientOptions } from '../../llm-client'
import { OtlpFileTraceStore } from '../../trace-analyst/store-otlp'
import type { ProposeContext, SurfaceProposer } from '../types'
import { analysisEditProposer } from './analysis-edit'

export type TraceAnalystPriorFindings = NonNullable<RegistryRunOpts['priorFindings']>

export interface AnalyzeOtlpTraceFileOptions {
  tracePath: string
  runId: string
  baseUrl: string
  apiKey: string
  model: string
  provider?: AxAIArgs<unknown>['name']
  kinds?: readonly TraceAnalystKindSpec[]
  signal?: AbortSignal
  costLedger?: CostLedgerHandle
  costPhase?: string
  priorFindings?: TraceAnalystPriorFindings
}

/** Run the built-in analyst registry against one OTLP JSONL file. */
export async function analyzeOtlpTraceFile(
  opts: AnalyzeOtlpTraceFileOptions,
): Promise<AnalystFinding[]> {
  if (!opts.apiKey) throw new Error('analyzeOtlpTraceFile: apiKey is required')
  if (!opts.model) throw new Error('analyzeOtlpTraceFile: model is required')
  const aiService = createAnalystAi({
    provider: opts.provider ?? 'openai',
    apiKey: opts.apiKey,
    baseUrl: opts.baseUrl,
    model: opts.model,
  })
  const registry = new AnalystRegistry()
  for (const spec of opts.kinds ?? DEFAULT_TRACE_ANALYST_KINDS) {
    registry.register(createTraceAnalystKind(spec, { ai: aiService, model: opts.model }))
  }
  const result = await registry.run(
    opts.runId,
    { traceStore: new OtlpFileTraceStore({ path: opts.tracePath }) },
    {
      signal: opts.signal ?? new AbortController().signal,
      chainFindings: true,
      ...(opts.costLedger ? { costLedger: opts.costLedger } : {}),
      ...(opts.costPhase ? { costPhase: opts.costPhase } : {}),
      ...(opts.priorFindings === undefined ? {} : { priorFindings: opts.priorFindings }),
    },
  )
  if (result.findings.length === 0) throw noFindingsError(result)
  return result.findings
}

export interface TraceAnalystProposerOptions<TFindings = unknown> {
  /** OpenAI-compatible base URL for BOTH the analyst's agentic reads and the
   *  apply step (e.g. `https://api.deepseek.com/v1` or the Tangle router). */
  baseUrl: string
  /** Bearer key. Required — the Ax AI service has no env fallback here. */
  apiKey: string
  /** Model the analyst kinds use for their agentic trace reads. */
  model: string
  /** Model used to APPLY findings to the prompt surface. Default = `model`.
   *  Keep this EQUAL to haloProposer's `applyModel` for an apples-to-apples run. */
  applyModel?: string
  /** Optional ledger for direct proposer use. Campaign context takes precedence. */
  costLedger?: CostLedgerHandle
  analysisMaximumCharge?: MaximumCharge
  analysisReceipt?: (report: string) => CostReceiptInput
  applyMaxTokens?: number
  /** Ax provider name. Default 'openai' — works for any OpenAI-compatible base
   *  via `apiURL`. Use 'deepseek' to hit DeepSeek's native provider. */
  provider?: AxAIArgs<unknown>['name']
  /** Which analyst kinds to run. Default = the full shipped suite. */
  kinds?: readonly TraceAnalystKindSpec[]
  /** Resolve the OTLP traces (JSONL string) the analyst should read for THIS
   *  generation — identical contract to `haloProposer.resolveTraces`. */
  resolveTraces: (ctx: ProposeContext<TFindings>) => string | Promise<string>
  /** Opt in to forwarding historical findings into every registered analyst.
   *  Return an array to route by analyst id or `{ '*': findings }` to broadcast.
   *  No findings are forwarded when this resolver is absent. */
  resolvePriorFindings?: (
    ctx: ProposeContext<TFindings>,
  ) => TraceAnalystPriorFindings | undefined | Promise<TraceAnalystPriorFindings | undefined>
  /** Override the findings producer. Default: the shipped `AnalystRegistry`
   *  over `kinds`. The unit suite injects canned findings here. */
  analyze?: (
    tracePath: string,
    ctx: ProposeContext<TFindings>,
  ) => Promise<ReadonlyArray<AnalystFinding>>
  /** Test seam: inject a fetch for the apply-step `callLlm`. */
  fetchImpl?: LlmClientOptions['fetch']
}

/** Render structured findings into the report shape the shared apply step
 *  consumes — so the application is identical across engines. */
function renderFindings(findings: ReadonlyArray<AnalystFinding>): string {
  return findings
    .map((f, i) => {
      const action = f.recommended_action ? `\n   FIX: ${f.recommended_action}` : ''
      const subject = f.subject ? ` (${f.subject})` : ''
      return `${i + 1}. [${f.severity}/${f.area}]${subject} ${f.claim}${action}`
    })
    .join('\n')
}

/** Wrap agent-eval's trace-analyst registry as a SurfaceProposer (prompt-tier). */
export function traceAnalystProposer<TFindings = unknown>(
  opts: TraceAnalystProposerOptions<TFindings>,
): SurfaceProposer<TFindings> {
  if (!opts.apiKey) throw new Error('traceAnalystProposer: apiKey is required')
  if (!opts.model) throw new Error('traceAnalystProposer: model is required')
  if (opts.analyze && opts.resolvePriorFindings) {
    throw new TypeError(
      'traceAnalystProposer: resolvePriorFindings only applies to the default registry; custom analyze callbacks must consume ctx.findings directly',
    )
  }
  const kinds = opts.kinds ?? DEFAULT_TRACE_ANALYST_KINDS

  const produceFindings =
    opts.analyze ??
    (async (path: string, c: ProposeContext<TFindings>): Promise<ReadonlyArray<AnalystFinding>> => {
      const priorFindings = await opts.resolvePriorFindings?.(c)
      return analyzeOtlpTraceFile({
        tracePath: path,
        runId: `trace-analyst-gen-${c.generation}`,
        provider: opts.provider ?? 'openai',
        apiKey: opts.apiKey,
        baseUrl: opts.baseUrl,
        model: opts.model,
        kinds,
        signal: c.signal,
        costLedger: c.costLedger,
        costPhase: c.costPhase,
        ...(priorFindings === undefined ? {} : { priorFindings }),
      })
    })

  return analysisEditProposer({
    kind: 'trace-analyst',
    label: 'trace-analyst',
    baseUrl: opts.baseUrl,
    apiKey: opts.apiKey,
    analysisModel: opts.model,
    applyModel: opts.applyModel ?? opts.model,
    costLedger: opts.costLedger,
    analysisMaximumCharge: opts.analysisMaximumCharge,
    analysisReceipt: opts.analysisReceipt,
    analysisAlreadyMetered: opts.analyze === undefined,
    applyMaxTokens: opts.applyMaxTokens,
    fetchImpl: opts.fetchImpl,
    resolveTraces: opts.resolveTraces,
    noTracesError:
      'traceAnalystProposer: resolveTraces returned no OTLP traces — the analyst has nothing to read',
    rationale: (report) => `trace-analyst findings:\n${report.slice(0, 800)}`,
    analyze: async (tracePath, ctx) => {
      let findings: ReadonlyArray<AnalystFinding>
      try {
        findings = await produceFindings(tracePath, ctx)
      } catch (e) {
        throw new Error(
          `traceAnalystProposer: analyst engine failed — ${e instanceof Error ? e.message : String(e)}`,
        )
      }
      if (findings.length === 0) {
        throw new Error('traceAnalystProposer: analyst engine produced no findings')
      }
      return renderFindings(findings)
    },
  })
}

function noFindingsError(result: AnalystRunResult): Error {
  const failed = result.per_analyst.filter((summary) => summary.status === 'failed')
  const details = failed
    .map((summary) => {
      const error = summary.error
      return error
        ? `${summary.analyst_id} [${error.class}: ${error.message}]`
        : `${summary.analyst_id} [error details unavailable]`
    })
    .join('; ')
  const suffix = details ? `; failures: ${details}` : ''
  return new Error(
    `traceAnalystProposer: analyst engine produced no findings — ${failed.length}/${result.per_analyst.length} analysts failed${suffix}`,
  )
}
