/**
 * @experimental
 *
 * `traceAnalystDriver` — wraps agent-eval's OWN trace-analyst engine
 * (`AnalystRegistry` over the agentic OTLP reader) as an `ImprovementDriver`.
 * It is the symmetric opponent to `haloDriver`: both consume the SAME OTLP
 * corpus and apply their findings to the prompt surface via one IDENTICAL
 * LLM edit, so a `compareDrivers` lift delta isolates a single variable —
 * ANALYSIS QUALITY. The benchmark answers "is our HALO clone as good as the
 * real HALO?" as a held-out lift CI, not a vibe.
 *
 * The fairness contract (the only thing that makes the head-to-head honest):
 *   - SAME input: both engines read the identical `traces.jsonl` (haloDriver
 *     hands it to the halo CLI; this driver wraps it in an `OtlpFileTraceStore`).
 *   - SAME application: the apply-step here is byte-for-byte the apply-step in
 *     `haloDriver` (same `APPLY_SYSTEM`, same one-shot `callLlm` prompt edit).
 *   - ONLY difference: who produced the findings — the real halo-engine vs our
 *     `AnalystRegistry` (whose actor prompt is a near-verbatim port of HALO's).
 *
 * Findings come from the REGISTRY (structured `AnalystFinding[]` carrying
 * area / severity / recommended_action), NOT bare `analyzeTraces` (which emits
 * `string[]`). The registry is the productized engine; raw `analyzeTraces` is
 * the unstructured escape hatch.
 *
 * Fail-loud: no traces → throw; analyst run errors → throw; zero findings →
 * throw. Never fabricate a candidate (that would silently flatter or penalize
 * our engine relative to HALO).
 */

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ai } from '@ax-llm/ax'
import { createTraceAnalystKind, type TraceAnalystKindSpec } from '../../analyst/kind-factory'
import { DEFAULT_TRACE_ANALYST_KINDS } from '../../analyst/kinds'
import { AnalystRegistry } from '../../analyst/registry'
import type { AnalystFinding } from '../../analyst/types'
import type { LlmClientOptions } from '../../llm-client'
import { callLlm } from '../../llm-client'
import { OtlpFileTraceStore } from '../../trace-analyst/store-otlp'
import type { ImprovementDriver, ProposeContext, ProposedCandidate } from '../types'

export interface TraceAnalystDriverOptions {
  /** OpenAI-compatible base URL for BOTH the analyst's agentic reads and the
   *  apply step (e.g. `https://api.deepseek.com/v1` or the Tangle router). */
  baseUrl: string
  /** Bearer key. Required — the Ax AI service has no env fallback here. */
  apiKey: string
  /** Model the analyst kinds use for their agentic trace reads. */
  model: string
  /** Model used to APPLY findings to the prompt surface. Default = `model`.
   *  Keep this EQUAL to haloDriver's `applyModel` for an apples-to-apples run. */
  applyModel?: string
  /** Ax provider name. Default 'openai' — works for any OpenAI-compatible base
   *  via `apiURL`. Use 'deepseek' to hit DeepSeek's native provider. */
  provider?: string
  /** Which analyst kinds to run. Default = the full shipped suite
   *  (`DEFAULT_TRACE_ANALYST_KINDS`: failure-mode, knowledge-gap,
   *  knowledge-poisoning, improvement). Narrow it for cost-parity runs. */
  kinds?: readonly TraceAnalystKindSpec[]
  /**
   * Resolve the OTLP traces (JSONL string) the analyst should read for THIS
   * generation — identical contract to `haloDriver.resolveTraces`, wired by
   * the bench to the captured AppWorld OTLP for the current surface. Returning
   * empty throws (the analyst has nothing to read).
   */
  resolveTraces: (ctx: ProposeContext) => string | Promise<string>
  /**
   * Override the findings producer. Default: the shipped `AnalystRegistry`
   * over `kinds`, reading the resolved traces as an `OtlpFileTraceStore`. A
   * consumer may inject a pre-built registry / alternate engine here; the
   * unit suite injects canned findings to exercise the apply path without
   * driving the agentic loop.
   */
  analyze?: (tracePath: string, ctx: ProposeContext) => Promise<ReadonlyArray<AnalystFinding>>
  /** Test seam: inject a fetch for the apply-step `callLlm` (no network in unit tests). */
  fetchImpl?: LlmClientOptions['fetch']
}

const APPLY_SYSTEM =
  'You apply a trace-analysis report to an agent instruction prompt. Output ONLY the full revised prompt — no preamble, no commentary, no code fences. Make the minimal edits that address the report findings; preserve everything else verbatim.'

/** Render structured findings into the same report shape the apply step in
 *  `haloDriver` consumes — so the application is identical across engines. */
function renderFindings(findings: ReadonlyArray<AnalystFinding>): string {
  return findings
    .map((f, i) => {
      const action = f.recommended_action ? `\n   FIX: ${f.recommended_action}` : ''
      const subject = f.subject ? ` (${f.subject})` : ''
      return `${i + 1}. [${f.severity}/${f.area}]${subject} ${f.claim}${action}`
    })
    .join('\n')
}

/** Wrap agent-eval's trace-analyst registry as an ImprovementDriver (prompt-tier). */
export function traceAnalystDriver(opts: TraceAnalystDriverOptions): ImprovementDriver {
  if (!opts.apiKey) throw new Error('traceAnalystDriver: apiKey is required')
  if (!opts.model) throw new Error('traceAnalystDriver: model is required')
  const kinds = opts.kinds ?? DEFAULT_TRACE_ANALYST_KINDS
  return {
    kind: 'trace-analyst',
    async propose(ctx: ProposeContext): Promise<ProposedCandidate[]> {
      const parent =
        typeof ctx.currentSurface === 'string'
          ? ctx.currentSurface
          : JSON.stringify(ctx.currentSurface)

      // (1) Materialize the OTLP traces this generation produced — the SAME
      //     corpus haloDriver feeds to the halo CLI.
      const traces = (await opts.resolveTraces(ctx)) ?? ''
      if (!traces.trim()) {
        throw new Error(
          'traceAnalystDriver: resolveTraces returned no OTLP traces — the analyst has nothing to read',
        )
      }
      const dir = mkdtempSync(join(tmpdir(), 'trace-analyst-driver-'))
      const tracePath = join(dir, 'traces.jsonl')
      writeFileSync(tracePath, traces.endsWith('\n') ? traces : `${traces}\n`)

      // (2) Run OUR trace-analyst engine on the traces (the registry → structured findings).
      const runAnalyze =
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

      let findings: ReadonlyArray<AnalystFinding>
      try {
        findings = await runAnalyze(tracePath, ctx)
      } catch (e) {
        throw new Error(
          `traceAnalystDriver: analyst engine failed — ${e instanceof Error ? e.message : String(e)}`,
        )
      }
      if (findings.length === 0) {
        throw new Error('traceAnalystDriver: analyst engine produced no findings')
      }

      // (3) Apply OUR findings to the prompt surface — IDENTICAL apply-step to
      //     haloDriver, so a lift delta reflects analysis quality alone.
      const report = renderFindings(findings)
      const applied = await callLlm(
        {
          model: opts.applyModel ?? opts.model,
          messages: [
            { role: 'system', content: APPLY_SYSTEM },
            {
              role: 'user',
              content: `CURRENT PROMPT:\n${parent}\n\nTRACE-ANALYSIS REPORT:\n${report}\n\nReturn the full revised prompt.`,
            },
          ],
        },
        { baseUrl: opts.baseUrl, apiKey: opts.apiKey, fetch: opts.fetchImpl },
      )
      const text = applied.content.trim()
      if (!text || text === parent) return []
      return [
        {
          surface: text,
          label: 'trace-analyst',
          rationale: `trace-analyst findings (${findings.length}):\n${report.slice(0, 800)}`,
        },
      ]
    },
  }
}
