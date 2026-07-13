/**
 * Intent-match judge — "did the agent build the right APP, ignoring
 * whether every feature is wired up?"
 *
 * Distinct from {@link runSemanticConceptJudge} which scores per-concept
 * presence. The semantic judge can return 0/4 concepts present even
 * when the agent built a thoughtful, polished, on-brief app that just
 * lacks one or two features. The semantic judge can also return 4/4
 * present even when the agent shipped the wrong project (keyword-rich
 * stub).
 *
 * Intent-match asks ONE question:
 *   "Looking at the agent's work as a whole — independent of feature
 *    coverage — is this an honest attempt at the user's request?"
 *
 * Returns a 0–1 score and a 1-sentence evidence string. Use as a sanity
 * check on `completenessScore`-style metrics: if intent-match is high
 * and concept count is low, the agent built the right thing but is
 * missing features (ship and iterate). If intent-match is low, the
 * agent built the wrong thing (reject regardless of concept count).
 *
 * Soft-fails on LLM/JSON error (`available: false`) so callers can
 * treat failure as "judge skipped."
 */

import { CostLedger, type CostReceipt } from './cost-ledger'
import {
  callLlmJson,
  costReceiptFromLlm,
  costReceiptFromLlmError,
  type LlmCallRequest,
  type LlmClientOptions,
  maximumChargeForLlmRequest,
} from './llm-client'

export const INTENT_MATCH_JUDGE_VERSION = 'intent-match-judge-v1-2026-04-24'

export interface IntentMatchInput {
  /** The full natural-language prompt the agent was handed. */
  userRequest: string
  /** Top-level source files from the agent's workdir. */
  sourceFiles: Array<{ path: string; content: string }>
  /** Rendered HTML the preview returned, when available. */
  servedHtml?: string
  /** Optional metadata to inject (id, vertical, difficulty). */
  artifactLabel?: string
  artifactDescription?: string
}

export interface IntentMatchResult {
  kind: 'intent-match'
  version: string
  /** 0..1 — 1 = unmistakably the right app, 0 = unrelated to the brief. */
  score: number
  /** One-sentence rationale citing concrete evidence (file or HTML). */
  evidence: string
  durationMs: number
  costUsd: number | null
  available: boolean
  error?: string
}

export interface IntentMatchOptions {
  model?: string
  timeoutMs?: number
  maxTokens?: number
  maxSourceChars?: number
  maxPerFileChars?: number
  maxHtmlChars?: number
  llm?: LlmClientOptions
  costLedger?: CostLedger
  costPhase?: string
  signal?: AbortSignal
}

const DEFAULT_MODEL = 'claude-sonnet-4-6'
const DEFAULT_TIMEOUT = 300_000
const DEFAULT_MAX_TOKENS = 800
const DEFAULT_MAX_SOURCE = 25_000
const DEFAULT_MAX_PER_FILE = 12_000
const DEFAULT_MAX_HTML = 20_000

const INTENT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['score', 'evidence'],
  properties: {
    score: { type: 'number', minimum: 0, maximum: 1 },
    evidence: { type: 'string', minLength: 10, maxLength: 400 },
  },
}

function truncate(body: string, cap: number, label: string): string {
  if (body.length <= cap) return body
  return `${body.slice(0, cap)}\n… [truncated ${body.length - cap} chars of ${label}]`
}

function buildPrompt(input: IntentMatchInput, opts: Required<IntentMatchOptions>): string {
  const sourceBlob = input.sourceFiles
    .filter((f) => f.content.length <= opts.maxPerFileChars)
    .map((f) => `--- FILE: ${f.path} ---\n${f.content}`)
    .join('\n\n')
  const html = input.servedHtml ?? ''

  return `You are evaluating whether an agent built THE RIGHT APP for a user request.

You are NOT scoring feature coverage. You are NOT scoring code quality.
You are answering ONE question: when a person looks at this work, do they
see an honest attempt at the user's request — or do they see the wrong
project entirely?

USER REQUEST:
${input.userRequest}

${input.artifactLabel ? `ARTIFACT METADATA:\n  name: ${input.artifactLabel}\n  description: ${input.artifactDescription ?? ''}\n\n` : ''}${html ? `SERVED HTML (what the preview returns):\n${truncate(html, opts.maxHtmlChars, 'HTML')}\n\n` : ''}SOURCE FILES (the agent's workdir):
${truncate(sourceBlob, opts.maxSourceChars, 'source')}

Score 0–1:
  1.0 — unmistakably the right app. Even with bugs, gaps, or missing
        features, a reviewer would say "yes, this is what was asked for."
  0.7 — recognizable. Domain matches; some required surface areas exist.
        A reviewer would say "right direction, lots of work needed."
  0.4 — partially related. Wrong framing or wrong product entirely but
        with some shared keywords or a tangential overlap.
  0.0 — wrong project. The agent shipped something unrelated to the
        request (e.g. asked for an NFT mint page, shipped a generic
        landing page with zero NFT-related code).

Evidence: one sentence citing the strongest concrete signal — a file
name, a route, a rendered headline, a missing core surface. Don't
restate the request.

Examples:
  - "src/App.tsx renders <MintWidget /> with mint-1/mint-5 buttons and
     wagmi imports — clearly the requested NFT mint page." → 0.95
  - "src/App.tsx is the default Vite React template; no
     mint/wallet/contract code in any file under src/." → 0.05

Return STRICT JSON. No prose outside.`
}

/**
 * Run the intent-match judge. Soft-fails to available=false on error.
 */
export async function runIntentMatchJudge(
  input: IntentMatchInput,
  options: IntentMatchOptions = {},
): Promise<IntentMatchResult> {
  const start = Date.now()
  const opts: Required<IntentMatchOptions> = {
    model: options.model ?? DEFAULT_MODEL,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT,
    maxTokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
    maxSourceChars: options.maxSourceChars ?? DEFAULT_MAX_SOURCE,
    maxPerFileChars: options.maxPerFileChars ?? DEFAULT_MAX_PER_FILE,
    maxHtmlChars: options.maxHtmlChars ?? DEFAULT_MAX_HTML,
    llm: options.llm ?? {},
    costLedger: options.costLedger ?? new CostLedger(),
    costPhase: options.costPhase ?? 'judge.intent-match',
    signal: options.signal ?? new AbortController().signal,
  }

  if (input.sourceFiles.length === 0 && !input.servedHtml) {
    return {
      kind: 'intent-match',
      version: INTENT_MATCH_JUDGE_VERSION,
      score: 0,
      evidence: 'no source files and no served HTML — nothing to evaluate',
      durationMs: 0,
      costUsd: null,
      available: false,
      error: 'no input artifact',
    }
  }

  let receipt: CostReceipt | undefined
  try {
    const request = {
      model: opts.model,
      messages: [
        {
          role: 'system' as const,
          content:
            'You are a holistic code reviewer answering one question: did the agent build the right app for the user. Return strict JSON. No prose outside.',
        },
        { role: 'user' as const, content: buildPrompt(input, opts) },
      ],
      jsonSchema: { name: 'intent_match_judge', schema: INTENT_SCHEMA },
      temperature: 0,
      maxTokens: opts.maxTokens,
      timeoutMs: opts.timeoutMs,
    } satisfies LlmCallRequest
    const paid = await opts.costLedger.runPaidCall({
      channel: 'judge',
      phase: opts.costPhase,
      actor: 'intent-match',
      model: opts.model,
      maximumCharge: maximumChargeForLlmRequest(request, opts.llm),
      signal: opts.signal,
      execute: (signal, callId) =>
        callLlmJson<{ score: number; evidence: string }>(request, {
          ...opts.llm,
          signal,
          idempotencyKey: callId,
        }),
      receipt: ({ result }) => costReceiptFromLlm(result),
      receiptFromError: costReceiptFromLlmError,
    })
    receipt = paid.receipt
    if (!paid.succeeded) throw paid.error
    const { value } = paid.value

    const score = Math.max(0, Math.min(1, Number(value?.score ?? 0)))
    return {
      kind: 'intent-match',
      version: INTENT_MATCH_JUDGE_VERSION,
      score: Number(score.toFixed(3)),
      evidence: String(value?.evidence ?? '').slice(0, 400),
      durationMs: Date.now() - start,
      costUsd: paid.receipt.costUnknown ? null : paid.receipt.costUsd,
      available: true,
    }
  } catch (err) {
    return {
      kind: 'intent-match',
      version: INTENT_MATCH_JUDGE_VERSION,
      score: 0,
      evidence: '',
      durationMs: Date.now() - start,
      costUsd: receipt && !receipt.costUnknown ? receipt.costUsd : null,
      available: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

/**
 * Factory: pin LLM options once, return a closure.
 */
export function createIntentMatchJudge(
  options: IntentMatchOptions = {},
): (input: IntentMatchInput) => Promise<IntentMatchResult> {
  return (input) => runIntentMatchJudge(input, options)
}
