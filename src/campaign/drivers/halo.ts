/**
 * @experimental
 *
 * `haloDriver` — wraps the REAL halo-engine (Inference.net's hierarchical
 * agentic trace analyzer, `pip install halo-engine`, repo context-labs/halo)
 * as an agent-eval `ImprovementDriver`, so HALO competes head-to-head with
 * `gepaDriver` — and with our own `traceAnalystDriver` — inside
 * `compareDrivers` on identical traces / scenarios / held-out scoring.
 *
 * It PRESERVES halo's actual working usage — `propose()` shells out to the
 * published CLI (`halo <traces.jsonl> -p <prompt> -m <model> --base-url
 * --api-key`) and uses its real RLM findings verbatim. We do NOT reimplement
 * its analysis; that would make the benchmark meaningless. The only adaptation
 * is applying HALO's findings to the current prompt surface via one LLM edit —
 * exactly what makes the comparison prompt-tier apples-to-apples with
 * `gepaDriver` (which also mutates the prompt). The analysis is HALO's; only
 * the surface-application is ours, and it is identical in spirit to how HALO's
 * own loop feeds findings to a coding agent.
 *
 * Fail-loud: no traces → throw; halo errors → throw; empty findings → throw.
 * Never fabricate a candidate (that would silently flatter or penalize HALO).
 */

import { execFile } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { LlmClientOptions } from '../../llm-client'
import { callLlm } from '../../llm-client'
import type { ImprovementDriver, ProposeContext, ProposedCandidate } from '../types'

const execFileAsync = promisify(execFile)

export interface HaloDriverOptions {
  /** OpenAI-compatible base URL for BOTH halo's RLM analysis and the apply
   *  step (e.g. the Tangle router `https://router.tangle.tools/v1`). */
  baseUrl: string
  /** Bearer key (else relies on OPENAI_API_KEY in the env halo inherits). */
  apiKey?: string
  /** Model for halo's `--model` (its RLM). Default 'gpt-5.4-mini' (halo's own default). */
  model?: string
  /** Model used to APPLY halo's findings to the prompt surface. Default = `model`. */
  applyModel?: string
  /** The real halo binary. Default 'halo' (from `pip install halo-engine`). */
  haloBin?: string
  /**
   * Resolve the OTLP traces (JSONL string) halo should analyze for THIS
   * generation — wired by the bench to the captured AppWorld OTLP for the
   * current surface. Returning empty throws (halo has nothing to analyze).
   */
  resolveTraces: (ctx: ProposeContext) => string | Promise<string>
  /** halo's analysis prompt (`-p`). Default targets the failure taxonomy. */
  analysisPrompt?: string
  /** halo `--max-depth` / `--max-turns` passthrough. */
  maxDepth?: number
  maxTurns?: number
  /** Test seam: inject a fetch for the apply-step callLlm (no network in unit tests). */
  fetchImpl?: LlmClientOptions['fetch']
}

const DEFAULT_ANALYSIS_PROMPT =
  'Diagnose the failures in these agent execution traces — hallucinated tool calls, redundant tool arguments, refusal loops, and semantic-correctness errors — and suggest concrete, generalizable fixes to the agent instructions.'

const APPLY_SYSTEM =
  'You apply a trace-analysis report to an agent instruction prompt. Output ONLY the full revised prompt — no preamble, no commentary, no code fences. Make the minimal edits that address the report findings; preserve everything else verbatim.'

/** Wrap the real halo-engine CLI as an ImprovementDriver (prompt-tier). */
export function haloDriver(opts: HaloDriverOptions): ImprovementDriver {
  const haloBin = opts.haloBin ?? 'halo'
  const model = opts.model ?? 'gpt-5.4-mini'
  return {
    kind: 'halo',
    async propose(ctx: ProposeContext): Promise<ProposedCandidate[]> {
      const parent =
        typeof ctx.currentSurface === 'string'
          ? ctx.currentSurface
          : JSON.stringify(ctx.currentSurface)

      // (1) Materialize the OTLP traces this generation produced.
      const traces = (await opts.resolveTraces(ctx)) ?? ''
      if (!traces.trim()) {
        throw new Error(
          'haloDriver: resolveTraces returned no OTLP traces — the halo engine has nothing to analyze',
        )
      }
      const dir = mkdtempSync(join(tmpdir(), 'halo-driver-'))
      const tracePath = join(dir, 'traces.jsonl')
      writeFileSync(tracePath, traces.endsWith('\n') ? traces : `${traces}\n`)

      // (2) Run the REAL halo-engine on the traces (its published CLI).
      // The published halo-engine reads the base URL + key from the env
      // (OPENAI_BASE_URL / OPENAI_API_KEY, set below) — it has no --base-url /
      // --api-key flags. Pass only the flags the CLI actually exposes.
      const args = [
        tracePath,
        '-p',
        opts.analysisPrompt ?? DEFAULT_ANALYSIS_PROMPT,
        '-m',
        model,
        ...(opts.maxDepth !== undefined ? ['--max-depth', String(opts.maxDepth)] : []),
        ...(opts.maxTurns !== undefined ? ['--max-turns', String(opts.maxTurns)] : []),
      ]
      let findings: string
      try {
        const { stdout } = await execFileAsync(haloBin, args, {
          maxBuffer: 64 * 1024 * 1024,
          signal: ctx.signal,
          env: {
            ...process.env,
            ...(opts.apiKey ? { OPENAI_API_KEY: opts.apiKey } : {}),
            OPENAI_BASE_URL: opts.baseUrl,
          },
        })
        findings = stdout.trim()
      } catch (e) {
        throw new Error(
          `haloDriver: halo-engine ('${haloBin}') failed — ${e instanceof Error ? e.message : String(e)}`,
        )
      }
      if (!findings) throw new Error('haloDriver: halo-engine produced no findings')

      // (3) Apply HALO's real findings to the prompt surface (prompt-tier,
      //     comparable to gepaDriver). HALO's analysis is preserved verbatim in
      //     the rationale for full attribution.
      const applied = await callLlm(
        {
          model: opts.applyModel ?? model,
          messages: [
            { role: 'system', content: APPLY_SYSTEM },
            {
              role: 'user',
              content: `CURRENT PROMPT:\n${parent}\n\nHALO TRACE-ANALYSIS REPORT:\n${findings}\n\nReturn the full revised prompt.`,
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
          label: 'halo',
          rationale: `halo-engine findings:\n${findings.slice(0, 800)}`,
        },
      ]
    },
  }
}
