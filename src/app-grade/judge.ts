/**
 * The model App Grade asks: the target picker and every SystemOne review. Any `ChatClient`
 * serves, so one grader runs on whatever the caller can reach: an OpenAI-compatible endpoint
 * (Router, cli-bridge), a Sandbox box, or the caller's own transport. This package reads no
 * credential; the caller builds the client.
 */
import type { ChatClient } from '../analyst/chat-client'
import type { CustomTokenPricing } from '../cost-ledger'
import { stripFencedJson } from '../llm-client/json'

export interface AppGradeJudge {
  /** The reference every receipt and review digest names, e.g. `router:gpt-5.6-luna`. */
  readonly ref: string
  /** The model id each request asks the client for. */
  readonly model: string
  readonly client: ChatClient
  /** Rate the ledger records when a call reports no cost. */
  readonly pricing: CustomTokenPricing
  /** Hard per-call reservation rate, at or above every rate the client bills. */
  readonly bound: CustomTokenPricing
  /**
   * For a judge that bills $0 per call (a subscription): what its calls so far would cost at
   * list price, as the judge reports it, or null when any call's figure is unknown. The
   * manifest records it as `notionalUsd`; it is never billed.
   */
  readonly notionalUsd?: () => number | null
}

export interface JudgeReply {
  content: string
  servedModel: string
  inputTokens: number
  outputTokens: number
  /** Dollars the client reported for the call, or null. */
  costUsd: number | null
  /** Names of tools the model called while answering; a judge should call none. */
  toolCalls: string[]
}

/** One JSON chat call. A failed call throws the client's error. */
export async function askJudge(
  judge: AppGradeJudge,
  input: {
    system: string
    user: string
    maxTokens: number
    signal?: AbortSignal
    idempotencyKey?: string
  },
): Promise<JudgeReply> {
  const result = await judge.client.chat(
    {
      model: judge.model,
      messages: [
        { role: 'system', content: input.system },
        { role: 'user', content: input.user },
      ],
      jsonMode: true,
      maxTokens: input.maxTokens,
    },
    {
      ...(input.signal ? { signal: input.signal } : {}),
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
    },
  )
  return {
    content: result.content,
    servedModel: result.servedModel ?? result.model,
    inputTokens: result.usage.promptTokens,
    outputTokens: result.usage.completionTokens,
    costUsd: result.costUsd,
    toolCalls: (result.toolCalls ?? []).map((call) => call.name),
  }
}

/** A judge's JSON reply, without a fence the model wrapped it in. */
export function parseJudgeJson(content: string): Record<string, unknown> {
  return JSON.parse(stripFencedJson(content)) as Record<string, unknown>
}
