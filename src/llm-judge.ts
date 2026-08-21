/**
 * `llmJudge` — the single-LLM-call bridge that turns a rubric prompt into a
 * canonical campaign `JudgeConfig`.
 *
 * The `JudgeConfig` contract (src/campaign/types.ts) is deliberately a
 * function, not a fixed LLM-prompt shape: real consumers judge with
 * ensembles, deterministic checks, or one LLM call. `ensembleJudge`
 * (src/judge-panel.ts) covers the multi-model case. `llmJudge` covers the
 * common single-call case the `JudgeConfig` doc-comment names:
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
import { CostLedger, type CostLedgerHandle } from './cost-ledger'
import { JudgeParseError } from './judges'
import {
  costReceiptFromLlm,
  costReceiptFromLlmError,
  type LlmCallMetadata,
  type LlmCallRequest,
  type LlmCallResult,
  type LlmTokenLogprob,
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
  /**
   * How to read a score out of the model's answer.
   *
   * `'sampled'` (default) reads the number the model emitted. Discrete grades
   * tie often, and a tie carries no ranking signal.
   *
   * `'expectation'` asks the provider for the log probabilities of the score
   * token and returns the expected value over the integer grades the model
   * considered, so two answers that both sample `8` separate by how much mass
   * sat on `7` and `9`. It requires `scale: 'ten'`: an integer grade is one
   * token, and a `unit` float is not. `whenUnavailable` decides what happens
   * when the provider returns no log probabilities, or the grade did not land
   * in one token: `'fail'` throws, `'sampled'` reads the emitted number and
   * records `scoringMethod: 'sampled'` on the score.
   */
  scoring?: { method: 'sampled' } | { method: 'expectation'; whenUnavailable: 'fail' | 'sampled' }
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
  costLedger?: CostLedgerHandle
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
  const scoring = opts.scoring ?? { method: 'sampled' }
  if (scoring.method === 'expectation' && scale !== 'ten') {
    throw new Error(
      `llmJudge '${name}': expectation scoring requires scale 'ten' — a [0,1] score is not one token, so no single position carries its distribution`,
    )
  }
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
      scoring,
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
        ...(scoring.method === 'expectation'
          ? { logprobs: { topLogprobs: EXPECTATION_TOP_LOGPROBS } }
          : {}),
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
                maximumAttempts: opts.chat.maximumAttempts,
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

      const sampled: Record<string, number> = {}
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
        sampled[key] = value
      }

      let scoringMethod: 'sampled' | 'expectation' = 'sampled'
      let distribution: Record<string, Array<{ score: number; probability: number }>> | undefined
      const dims: Record<string, number> = {}
      if (scoring.method === 'expectation') {
        const expectation = expectedDimensionScores({
          tokens: response.logprobs ?? null,
          sampled,
          maxScore: divisor,
        })
        if (expectation.kind === 'unavailable') {
          if (scoring.whenUnavailable === 'fail') {
            throw new Error(
              `llmJudge '${name}': expectation scoring is unavailable — ${expectation.reason}`,
            )
          }
        } else {
          scoringMethod = 'expectation'
          distribution = expectation.distribution
          for (const { key } of dimensions) dims[key] = clamp01(expectation.scores[key]! / divisor)
        }
      }
      if (scoringMethod === 'sampled') {
        for (const { key } of dimensions) dims[key] = clamp01(sampled[key]! / divisor)
      }

      const weights =
        opts.weights ?? Object.fromEntries(dimensions.map((d) => [d.key, 1 / dimensions.length]))
      const { composite } = weightedComposite({ dims, weights })

      const notes =
        firstString(parsed.notes) ??
        firstString(parsed.rationale) ??
        `${name}: composite ${composite.toFixed(3)} over ${dimensions.length} dimension(s)`

      return {
        dimensions: dims,
        composite,
        notes,
        llmCall,
        ...(opts.scoring ? { scoringMethod } : {}),
        ...(distribution ? { distribution } : {}),
      }
    },
  }
}

/** Alternatives requested per score token. Twenty is the documented ceiling of
 *  the OpenAI-compatible `top_logprobs` field, and a grade scale has at most
 *  eleven integer candidates, so the window always covers the whole scale. */
const EXPECTATION_TOP_LOGPROBS = 20

type ExpectationResult =
  | {
      kind: 'expectation'
      scores: Record<string, number>
      distribution: Record<string, Array<{ score: number; probability: number }>>
    }
  | { kind: 'unavailable'; reason: string }

/**
 * Expected grade per dimension: locate the token that carried each dimension's
 * integer score, then average the integer grades the model considered at that
 * position, weighted by their probabilities.
 *
 * Unavailable — never silently approximated — when the provider returned no
 * log probabilities, when a dimension's grade is not in the token stream, or
 * when the grade did not land in exactly one token (a two-token `10`, a float).
 */
function expectedDimensionScores(input: {
  tokens: ReadonlyArray<LlmTokenLogprob> | null
  sampled: Record<string, number>
  maxScore: number
}): ExpectationResult {
  const { tokens, sampled, maxScore } = input
  if (tokens === null) return { kind: 'unavailable', reason: 'the provider returned no logprobs' }
  if (tokens.length === 0) {
    return { kind: 'unavailable', reason: 'the provider returned an empty logprob stream' }
  }
  const offsets: number[] = []
  let text = ''
  for (const token of tokens) {
    offsets.push(text.length)
    text += token.token
  }

  const scores: Record<string, number> = {}
  const distribution: Record<string, Array<{ score: number; probability: number }>> = {}
  for (const [key, value] of Object.entries(sampled)) {
    const match = new RegExp(`"${escapeRegExp(key)}"\\s*:\\s*`).exec(text)
    if (!match) {
      return { kind: 'unavailable', reason: `dimension '${key}' is not in the token stream` }
    }
    const scoreOffset = match.index + match[0].length
    let index = -1
    for (let position = 0; position < offsets.length; position++) {
      if (offsets[position]! <= scoreOffset) index = position
      else break
    }
    const token = tokens[index]
    if (!token) {
      return {
        kind: 'unavailable',
        reason: `dimension '${key}' has no token at its score position`,
      }
    }
    if (integerGrade(token.token, maxScore) !== value) {
      return {
        kind: 'unavailable',
        reason: `dimension '${key}' scored ${value}, which is not the whole of its token '${token.token}'`,
      }
    }
    const candidates: Array<{ score: number; probability: number }> = []
    let total = 0
    for (const alternative of token.top.length > 0 ? token.top : [token]) {
      const grade = integerGrade(alternative.token, maxScore)
      if (grade === null) continue
      const probability = Math.exp(alternative.logprob)
      if (!Number.isFinite(probability) || probability <= 0) continue
      candidates.push({ score: grade, probability })
      total += probability
    }
    if (candidates.length === 0 || total <= 0) {
      return {
        kind: 'unavailable',
        reason: `dimension '${key}' has no integer grade in its probability window`,
      }
    }
    let expectation = 0
    for (const candidate of candidates)
      expectation += (candidate.probability / total) * candidate.score
    scores[key] = expectation
    distribution[key] = candidates
      .map((candidate) => ({ score: candidate.score, probability: candidate.probability / total }))
      .sort((left, right) => left.score - right.score)
  }
  return { kind: 'expectation', scores, distribution }
}

/** The token's integer grade on the judge's scale, or null when the token is
 *  not exactly one integer in range. */
function integerGrade(token: string, maxScore: number): number | null {
  const trimmed = token.trim()
  if (!/^\d+$/.test(trimmed)) return null
  const value = Number(trimmed)
  return Number.isInteger(value) && value >= 0 && value <= maxScore ? value : null
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
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
