/**
 * Shared core for prompt-tier "analysis → one LLM edit" proposers. `haloProposer`
 * and `traceAnalystProposer` differ ONLY in who produces the findings; the
 * materialize-traces → apply-via-`APPLY_SYSTEM` → candidate pipeline is
 * identical. Keeping it in one place IS the fairness contract their head-to-head
 * (`compareProposers`) depends on — the apply step can no longer drift between the
 * two engines being compared.
 */

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LlmClientOptions } from '../../llm-client'
import { callLlm } from '../../llm-client'
import type { ProposeContext, ProposedCandidate, SurfaceProposer } from '../types'

export const APPLY_SYSTEM =
  'You apply a trace-analysis report to an agent instruction prompt. Output ONLY the full revised prompt — no preamble, no commentary, no code fences. Make the minimal edits that address the report findings; preserve everything else verbatim.'

/** Serialize a surface (string or structured) into prompt text. */
export function surfaceToPromptText(surface: unknown): string {
  return typeof surface === 'string' ? surface : JSON.stringify(surface)
}

export interface AnalysisEditProposerOptions {
  kind: string
  label: string
  baseUrl: string
  apiKey?: string
  applyModel: string
  fetchImpl?: LlmClientOptions['fetch']
  /** Resolve the OTLP traces (JSONL) for THIS generation. Empty → `noTracesError`. */
  resolveTraces: (ctx: ProposeContext) => string | Promise<string>
  /** Produce the analysis REPORT string from the materialized trace file. Owns
   *  its engine-specific failure + no-findings throws. */
  analyze: (tracePath: string, ctx: ProposeContext) => Promise<string>
  noTracesError: string
  rationale: (report: string) => string
}

/** Build a `SurfaceProposer` that runs `analyze` over the generation's OTLP
 *  traces and applies the report to the surface via one identical LLM edit. */
export function analysisEditProposer(opts: AnalysisEditProposerOptions): SurfaceProposer {
  return {
    kind: opts.kind,
    async propose(ctx: ProposeContext): Promise<ProposedCandidate[]> {
      const parent = surfaceToPromptText(ctx.currentSurface)

      const traces = (await opts.resolveTraces(ctx)) ?? ''
      if (!traces.trim()) throw new Error(opts.noTracesError)
      const dir = mkdtempSync(join(tmpdir(), `${opts.kind}-proposer-`))
      const tracePath = join(dir, 'traces.jsonl')
      writeFileSync(tracePath, traces.endsWith('\n') ? traces : `${traces}\n`)

      const report = await opts.analyze(tracePath, ctx)

      const applied = await callLlm(
        {
          model: opts.applyModel,
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
      return [{ surface: text, label: opts.label, rationale: opts.rationale(report) }]
    },
  }
}
