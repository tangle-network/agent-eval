/**
 * `haloProposer` — wraps the REAL halo-engine (Inference.net's hierarchical
 * agentic trace analyzer, `pip install halo-engine`, repo context-labs/halo)
 * as an agent-eval `SurfaceProposer`, so HALO competes head-to-head with
 * `gepaProposer` — and with our own `traceAnalystProposer` — inside `compareProposers`
 * on identical traces / scenarios / held-out scoring.
 *
 * It PRESERVES halo's actual working usage — `analyze` shells out to the
 * published CLI (`halo <traces.jsonl> -p <prompt> -m <model>`) and uses its real
 * RLM findings verbatim. We do NOT reimplement its analysis; that would make the
 * benchmark meaningless. The materialize/apply pipeline is the shared
 * `analysisEditProposer` — identical to `traceAnalystProposer`, which is what makes
 * the comparison apples-to-apples.
 *
 * Fail-loud: no traces → throw; halo errors → throw; empty findings → throw.
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { CostLedger, CostReceiptInput, MaximumCharge } from '../../cost-ledger'
import type { LlmClientOptions } from '../../llm-client'
import type { ProposeContext, SurfaceProposer } from '../types'
import { analysisEditProposer } from './analysis-edit'

const execFileAsync = promisify(execFile)

export interface HaloProposerOptions {
  /** OpenAI-compatible base URL for BOTH halo's RLM analysis and the apply
   *  step (e.g. the Tangle router `https://router.tangle.tools/v1`). */
  baseUrl: string
  /** Bearer key (else relies on OPENAI_API_KEY in the env halo inherits). */
  apiKey?: string
  /** Model for halo's `--model` (its RLM). Default 'gpt-5.4-mini' (halo's own default). */
  model?: string
  /** Model used to APPLY halo's findings to the prompt surface. Default = `model`. */
  applyModel?: string
  /** Optional ledger for direct proposer use. Campaign context takes precedence. */
  costLedger?: CostLedger
  analysisMaximumCharge?: MaximumCharge
  analysisReceipt?: (report: string) => CostReceiptInput
  applyMaxTokens?: number
  /** The real halo binary. Default 'halo' (from `pip install halo-engine`). */
  haloBin?: string
  /** Resolve the OTLP traces (JSONL string) halo should analyze for THIS
   *  generation. Returning empty throws (halo has nothing to analyze). */
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

/** Wrap the real halo-engine CLI as a SurfaceProposer (prompt-tier). */
export function haloProposer(opts: HaloProposerOptions): SurfaceProposer {
  const haloBin = opts.haloBin ?? 'halo'
  const model = opts.model ?? 'gpt-5.4-mini'
  return analysisEditProposer({
    kind: 'halo',
    label: 'halo',
    baseUrl: opts.baseUrl,
    apiKey: opts.apiKey,
    analysisModel: model,
    applyModel: opts.applyModel ?? model,
    costLedger: opts.costLedger,
    analysisMaximumCharge: opts.analysisMaximumCharge,
    analysisReceipt: opts.analysisReceipt,
    applyMaxTokens: opts.applyMaxTokens,
    fetchImpl: opts.fetchImpl,
    resolveTraces: opts.resolveTraces,
    noTracesError:
      'haloProposer: resolveTraces returned no OTLP traces — the halo engine has nothing to analyze',
    // HALO's real findings are preserved verbatim in the rationale (attribution).
    rationale: (findings) => `halo-engine findings:\n${findings.slice(0, 800)}`,
    analyze: async (tracePath, ctx) => {
      // The published halo-engine reads the base URL + key from the env
      // (OPENAI_BASE_URL / OPENAI_API_KEY) — it has no --base-url/--api-key flags.
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
          `haloProposer: halo-engine ('${haloBin}') failed — ${e instanceof Error ? e.message : String(e)}`,
        )
      }
      if (!findings) throw new Error('haloProposer: halo-engine produced no findings')
      return findings
    },
  })
}
