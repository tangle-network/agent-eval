/**
 * @experimental
 *
 * `haloDriver` — wraps the REAL halo-engine (Inference.net's HALO,
 * "Hierarchical Agent Loop Optimizer"; `pip install halo-engine`; repo
 * github.com/context-labs/halo; hosted at inference.net) as an agent-eval
 * `ImprovementDriver`, so HALO competes head-to-head with `gepaDriver` inside
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

const DEFAULT_ANALYSIS_PROMPT = `Analyze this OTLP trace dataset of an agent attempting a task, and produce an evidence-grounded diagnosis the agent's instruction prompt can be edited from.

Work bottom-up from the spans:
1. First call get_dataset_overview, then triage the failed/low-quality traces (STATUS_CODE_ERROR, refusal loops, MaxTurnsExceeded, empty/incorrect final answers).
2. For each recurring failure, name the MECHANISM with a cited trace/span: hallucinated or non-existent tool calls; redundant/repeated tool arguments; wrong tool selection; missing a prerequisite fetch before acting; refusal or apology loops; premature termination; semantically-wrong output that passed structurally.
3. Cluster mechanisms into a small ranked failure taxonomy (most-frequent / highest-impact first), each with a frequency and one concrete example (trace_id + the offending text).
4. For each cluster, propose ONE concrete, GENERALIZABLE instruction edit that would prevent the whole cluster — not a fix overfit to a single trace. State the rule the agent should follow, not the specific case.

Output the ranked taxonomy and the proposed instruction edits. Cite a trace/span for every claim; never invent ids.`

const APPLY_SYSTEM = `You apply a trace-analysis report to an agent's instruction prompt. The report names ranked failure clusters and proposes generalizable rules. Your job: fold those rules into the prompt as durable, generalizable guidance.

Output ONLY the full revised prompt — no preamble, no commentary, no code fences.
- Add or sharpen the minimal set of rules that address the report's clusters, ordered by the report's impact ranking.
- Write rules as general principles ("always fetch the resource before mutating it"), never as case-specific patches overfit to one trace.
- Preserve everything else verbatim; do not delete working guidance or restructure unrelated sections.
- If the report's findings are vacuous or already covered, return the prompt unchanged.`

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
      const args = [
        tracePath,
        '-p',
        opts.analysisPrompt ?? DEFAULT_ANALYSIS_PROMPT,
        '-m',
        model,
        '--base-url',
        opts.baseUrl,
        ...(opts.apiKey ? ['--api-key', opts.apiKey] : []),
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
