/**
 * @experimental
 *
 * `traceAnalystProposer` — wraps agent-eval's OWN trace-analyst engine
 * (`AnalystRegistry` over the agentic OTLP reader) as a `SurfaceProposer`.
 * It is the symmetric opponent to `haloProposer`: both run the SAME shared
 * `analysisEditProposer` pipeline (materialize identical traces → apply via one
 * identical LLM edit), so a `compareProposers` lift delta isolates a single
 * variable — ANALYSIS QUALITY. The benchmark answers "is our HALO clone as good
 * as the real HALO?" as a held-out lift CI, not a vibe.
 *
 * Findings come from the REGISTRY (structured `AnalystFinding[]` carrying
 * area / severity / recommended_action), rendered into the report the shared
 * apply step consumes.
 *
 * Fail-loud: no traces → throw; analyst run errors → throw; zero findings →
 * throw. Never fabricate a candidate.
 */

import { ai } from '@ax-llm/ax'
import { createTraceAnalystKind, type TraceAnalystKindSpec } from '../../analyst/kind-factory'
import { DEFAULT_TRACE_ANALYST_KINDS } from '../../analyst/kinds'
import { AnalystRegistry } from '../../analyst/registry'
import type { AnalystFinding } from '../../analyst/types'
import type { LlmClientOptions } from '../../llm-client'
import { OtlpFileTraceStore } from '../../trace-analyst/store-otlp'
import type { ProposeContext, SurfaceProposer } from '../types'
import { analysisEditProposer } from './analysis-edit'

export interface TraceAnalystProposerOptions {
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
  /** Ax provider name. Default 'openai' — works for any OpenAI-compatible base
   *  via `apiURL`. Use 'deepseek' to hit DeepSeek's native provider. */
  provider?: string
  /** Which analyst kinds to run. Default = the full shipped suite. */
  kinds?: readonly TraceAnalystKindSpec[]
  /** Resolve the OTLP traces (JSONL string) the analyst should read for THIS
   *  generation — identical contract to `haloProposer.resolveTraces`. */
  resolveTraces: (ctx: ProposeContext) => string | Promise<string>
  /** Override the findings producer. Default: the shipped `AnalystRegistry`
   *  over `kinds`. The unit suite injects canned findings here. */
  analyze?: (tracePath: string, ctx: ProposeContext) => Promise<ReadonlyArray<AnalystFinding>>
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
export function traceAnalystProposer(opts: TraceAnalystProposerOptions): SurfaceProposer {
  if (!opts.apiKey) throw new Error('traceAnalystProposer: apiKey is required')
  if (!opts.model) throw new Error('traceAnalystProposer: model is required')
  const kinds = opts.kinds ?? DEFAULT_TRACE_ANALYST_KINDS

  const produceFindings =
    opts.analyze ??
    (async (path: string, c: ProposeContext): Promise<ReadonlyArray<AnalystFinding>> => {
      const aiService = ai({
        name: opts.provider ?? 'openai',
        apiKey: opts.apiKey,
        apiURL: opts.baseUrl,
        config: { model: opts.model },
      })
      const registry = new AnalystRegistry()
      for (const spec of kinds) {
        registry.register(createTraceAnalystKind(spec, { ai: aiService, model: opts.model }))
      }
      const result = await registry.run(
        `trace-analyst-gen-${c.generation}`,
        { traceStore: new OtlpFileTraceStore({ path }) },
        { signal: c.signal },
      )
      return result.findings
    })

  return analysisEditProposer({
    kind: 'trace-analyst',
    label: 'trace-analyst',
    baseUrl: opts.baseUrl,
    apiKey: opts.apiKey,
    applyModel: opts.applyModel ?? opts.model,
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
