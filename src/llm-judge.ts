/**
 * `llmJudge` — the single-LLM-call bridge that turns a rubric prompt into a
 * canonical campaign `JudgeConfig`.
 *
 * The `JudgeConfig` contract (src/campaign/types.ts) is deliberately a
 * function, not a fixed LLM-prompt shape: real consumers judge with
 * ensembles, deterministic checks, or one LLM call. `ensembleJudge`
 * (src/judge-panel.ts) covers the multi-model case; `buildAgreementJudge`
 * (src/campaign/distillation) covers the pure-comparator case. `llmJudge`
 * covers the common single-call case the `JudgeConfig` doc-comment names:
 * one model call against `prompt`, parsed into the canonical `JudgeScore`
 * (`{ dimensions, composite, notes }`) on the campaign [0,1] scale.
 *
 * Transport is injected as a `ChatClient` (src/analyst/chat-client.ts) — the
 * substrate's transport-agnostic LLM seam — so the judge stays decoupled from
 * router-vs-sandbox-vs-cli-bridge and is unit-testable with the `mock`
 * transport. The composite is computed by `weightedComposite` (the same
 * sum-normalized weighting `ensembleJudge` uses), so a lift is attributable to
 * the dimension scores, not to a bespoke reducer.
 *
 * Fail-loud throughout: an unparseable model response throws `JudgeParseError`;
 * a response missing a declared dimension throws; an out-of-range score throws.
 * A thrown judge is recorded by the campaign engine as a failed cell, never
 * folded into a silent zero.
 */

import { z } from 'zod'
import type { ChatClient } from './analyst/chat-client'
import type { JudgeConfig, JudgeDimension, JudgeScore, Scenario } from './campaign/types'
import { CostLedger } from './cost-ledger'
import { JudgeParseError } from './judges'
import {
  costReceiptFromLlm,
  costReceiptFromLlmError,
  type LlmCallMetadata,
  type LlmCallRequest,
  type LlmCallResult,
  maximumChargeForLlmRequest,
  stripFencedJson,
} from './llm-client'
import { clamp01 } from './run-score'
import { weightedComposite } from './statistics'
import { contentHash } from './verdict-cache'

/** A rubric dimension as a bare key or the full `{ key, description }` shape. A
 *  bare string uses the key as its own description. */
export type LlmJudgeDimension = string | JudgeDimension

export interface LlmJudgeOptions<TArtifact, TScenario extends Scenario = Scenario> {
  /** The injected LLM transport. One `chat()` call per `score()`. Required —
   *  there is no default route, so a misconfigured judge fails at construction,
   *  never silently against the free-tier router. */
  chat: ChatClient
  /** Rubric dimensions the model scores. Each becomes a `[0,1]` field of the
   *  returned `JudgeScore.dimensions`. Defaults to a single `quality` dimension. */
  dimensions?: LlmJudgeDimension[]
  /** Model id. Falls back to `chat.defaultModel`; one of the two MUST resolve. */
  model?: string
  /** Explicit scoring revision for opaque transport or renderer changes. */
  judgeVersion?: string
  temperature?: number
  maxTokens?: number
  /** Composite weights forwarded to `weightedComposite`: a partial map selects
   *  AND weights exactly the named dimensions. Omit for a uniform mean. */
  weights?: Record<string, number>
  /** Scale the model is prompted to score on, normalized into `[0,1]`:
   *   - `'unit'`  (default): the model returns `[0,1]` directly.
   *   - `'ten'`:  the model returns `[0,10]`; divided by 10 here.
   *  The prompt is annotated with the expected range either way. */
  scale?: 'unit' | 'ten'
  /** Run this judge only on matching scenarios (mirrors `JudgeConfig.appliesTo`). */
  appliesTo?: (scenario: TScenario) => boolean
  /** Render the artifact + scenario into the user message. Default:
   *  pretty-printed JSON of `{ scenario, artifact }`. */
  renderUser?: (input: { artifact: TArtifact; scenario: TScenario }) => string
  /** Strict runtime contract; its JSON Schema is sent to the provider. */
  costLedger?: CostLedger
  responseSchema?: { name: string; schema: z.ZodObject }
}

interface RawJudgeResponse {
  dimensions?: Record<string, unknown>
  scores?: Record<string, unknown>
  notes?: unknown
  rationale?: unknown
}

/**
 * Build a campaign-shaped `JudgeConfig` whose `score()` makes ONE LLM call
 * against `prompt` and reduces the model's per-dimension scores to a canonical
 * `JudgeScore` in `[0,1]`.
 *
 * The model is instructed to return JSON `{ "dimensions": { <key>: <number>, … },
 * "notes": "…" }`; the helper strips fenced JSON, validates every declared
 * dimension is present and in range, normalizes by `scale`, and composites via
 * `weightedComposite`.
 */
export function llmJudge<TArtifact = unknown, TScenario extends Scenario = Scenario>(
  name: string,
  prompt: string,
  opts: LlmJudgeOptions<TArtifact, TScenario>,
): JudgeConfig<TArtifact, TScenario> {
  if (!name.trim()) {
    throw new Error('llmJudge: name must be non-empty')
  }
  if (!prompt.trim()) {
    throw new Error(`llmJudge '${name}': prompt must be non-empty`)
  }
  const model = opts.model ?? opts.chat.defaultModel
  if (!model) {
    throw new Error(
      `llmJudge '${name}': no model on opts and no defaultModel on the ChatClient — ` +
        'pass opts.model or bind defaultModel at createChatClient().',
    )
  }

  const dimensions = normalizeDimensions(opts.dimensions, name)
  const scale = opts.scale ?? 'unit'
  const divisor = scale === 'ten' ? 10 : 1
  const renderUser =
    opts.renderUser ??
    ((input: { artifact: TArtifact; scenario: TScenario }) =>
      JSON.stringify({ scenario: input.scenario, artifact: input.artifact }, null, 2))

  if (opts.weights) {
    for (const key of Object.keys(opts.weights)) {
      if (!dimensions.some((d) => d.key === key)) {
        throw new Error(
          `llmJudge '${name}': weights names dimension '${key}' that is not declared in dimensions`,
        )
      }
    }
  }

  const systemPrompt = `${prompt}\n\n${renderContract(dimensions, scale)}`
  const directCostLedger = opts.costLedger ?? new CostLedger()
  let jsonSchema: { name: string; schema: Record<string, unknown> } | undefined
  if (opts.responseSchema) {
    const schema = { ...(z.toJSONSchema(opts.responseSchema.schema) as Record<string, unknown>) }
    delete schema.$schema
    jsonSchema = { name: opts.responseSchema.name, schema }
  }
  const declaredJudgeVersion = opts.judgeVersion?.trim()
  if (opts.judgeVersion !== undefined && !declaredJudgeVersion) {
    throw new Error(`llmJudge '${name}': judgeVersion must be non-empty when provided`)
  }
  const judgeVersion =
    declaredJudgeVersion ??
    contentHash({
      kind: 'llmJudge',
      prompt: systemPrompt,
      model,
      transport: opts.chat.transport,
      maximumAttempts: opts.chat.maximumAttempts ?? null,
      temperature: opts.temperature ?? 0.1,
      maxTokens: opts.maxTokens ?? 800,
      weights: opts.weights ?? null,
      scale,
      jsonSchema: jsonSchema ?? null,
      renderUser: opts.renderUser?.toString() ?? null,
    })

  return {
    name,
    dimensions,
    judgeVersion,
    appliesTo: opts.appliesTo,
    async score({
      artifact,
      scenario,
      signal,
      costLedger,
      costPhase,
      costTags,
    }): Promise<JudgeScore> {
      const request: LlmCallRequest = {
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: renderUser({ artifact, scenario }) },
        ],
        jsonMode: true,
        jsonSchema,
        temperature: opts.temperature ?? 0.1,
        maxTokens: opts.maxTokens ?? 800,
      }
      const paid = await (costLedger ?? directCostLedger).runPaidCall({
        channel: 'judge',
        phase: costPhase ?? 'judge',
        actor: name,
        model,
        maximumCharge:
          opts.chat.maximumAttempts === undefined
            ? undefined
            : maximumChargeForLlmRequest(request, {
                maxRetries: opts.chat.maximumAttempts,
              }),
        tags: { ...costTags, scenarioId: scenario.id },
        signal,
        execute: (callSignal, callId) =>
          opts.chat.chat(request, { signal: callSignal, idempotencyKey: callId }),
        receipt: costReceiptFromLlm,
        receiptFromError: costReceiptFromLlmError,
      })
      if (!paid.succeeded) throw paid.error
      const response = paid.value
      const llmCall: LlmCallMetadata = {
        usage: response.usage,
        costUsd: response.costUsd,
        model: response.model,
        durationMs: response.durationMs,
      }

      const parsed = parseResponse(name, response, opts.responseSchema?.schema, llmCall)
      const rawDims = parsed.dimensions ?? parsed.scores
      if (!rawDims || typeof rawDims !== 'object') {
        throw new JudgeParseError(name, response.content, {
          cause: new Error('response has no `dimensions` object'),
          llmCall,
        })
      }

      const dims: Record<string, number> = {}
      for (const { key } of dimensions) {
        const raw = (rawDims as Record<string, unknown>)[key]
        const value = Number(raw)
        if (raw === undefined || raw === null || !Number.isFinite(value)) {
          throw new JudgeParseError(name, response.content, {
            cause: new Error(
              `dimension '${key}' missing or non-numeric (got ${JSON.stringify(raw)})`,
            ),
            llmCall,
          })
        }
        dims[key] = clamp01(value / divisor)
      }

      const weights =
        opts.weights ?? Object.fromEntries(dimensions.map((d) => [d.key, 1 / dimensions.length]))
      const { composite } = weightedComposite({ dims, weights })

      const notes =
        firstString(parsed.notes) ??
        firstString(parsed.rationale) ??
        `${name}: composite ${composite.toFixed(3)} over ${dimensions.length} dimension(s)`

      return { dimensions: dims, composite, notes, llmCall }
    },
  }
}

function normalizeDimensions(
  input: LlmJudgeDimension[] | undefined,
  name: string,
): JudgeDimension[] {
  const raw = input && input.length > 0 ? input : ['quality']
  const out: JudgeDimension[] = []
  const seen = new Set<string>()
  for (const d of raw) {
    const dim = typeof d === 'string' ? { key: d, description: d } : d
    if (!dim.key.trim()) {
      throw new Error(`llmJudge '${name}': dimension key must be non-empty`)
    }
    if (seen.has(dim.key)) {
      throw new Error(`llmJudge '${name}': duplicate dimension key '${dim.key}'`)
    }
    seen.add(dim.key)
    out.push(dim)
  }
  return out
}

function renderContract(dimensions: JudgeDimension[], scale: 'unit' | 'ten'): string {
  const range = scale === 'ten' ? '0 to 10' : '0.0 to 1.0'
  const lines = dimensions.map((d) => `  - "${d.key}": ${d.description} (score ${range})`)
  const example = `{"dimensions": {${dimensions
    .map((d) => `"${d.key}": <number>`)
    .join(', ')}}, "notes": "<one-line rationale>"}`
  return [
    'Score the artifact on EACH of these dimensions:',
    ...lines,
    '',
    `Respond with JSON ONLY, no prose. Every dimension is a number in [${range}]:`,
    example,
  ].join('\n')
}

function parseResponse(
  name: string,
  response: LlmCallResult,
  schema: z.ZodObject | undefined,
  llmCall: LlmCallMetadata,
): RawJudgeResponse {
  const { content } = response
  const fail = (cause: unknown) => new JudgeParseError(name, content, { cause, llmCall })
  if (response.finishReason != null && response.finishReason !== 'stop') {
    throw fail(
      new Error(`response did not complete normally (finishReason=${response.finishReason})`),
    )
  }
  if (schema) {
    try {
      return schema.parse(JSON.parse(stripFencedJson(content))) as RawJudgeResponse
    } catch (cause) {
      throw fail(cause)
    }
  }
  const stripped = content.replace(/```json\n?|\n?```/g, '').trim()
  const objMatch = stripped.match(/\{[\s\S]*\}/)
  const payload = objMatch ? objMatch[0] : stripped
  try {
    const parsed = JSON.parse(payload) as RawJudgeResponse
    if (typeof parsed !== 'object' || parsed === null) {
      throw new Error('parsed value is not an object')
    }
    return parsed
  } catch (cause) {
    throw fail(cause)
  }
}

function firstString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}
