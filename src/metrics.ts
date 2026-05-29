import type { ProductClient } from './client'
import type { DriverState, TurnMetrics } from './types'

interface TokenPrice {
  input: number
  output: number
}

/** Per-1K token pricing for exact model ids. */
export const MODEL_PRICING: Record<string, TokenPrice> = {
  'gpt-4o': { input: 0.0025, output: 0.01 },
  'gpt-4o-mini': { input: 0.00015, output: 0.0006 },
  'gpt-4-turbo': { input: 0.01, output: 0.03 },
  'claude-sonnet-4-20250514': { input: 0.003, output: 0.015 },
  'claude-opus-4-20250514': { input: 0.015, output: 0.075 },
  'claude-3-haiku-20240307': { input: 0.00025, output: 0.00125 },
}

/** Family-level pricing fallbacks (per-1K), matched against a normalized id
 *  after exact lookup misses. Ordered — first match wins. Covers the model
 *  ids actually used through the Tangle router + cli-bridge harnesses
 *  (`claude-code/sonnet`, `opencode/zai-coding-plan/glm-5.1`,
 *  `kimi-code/kimi-k2.6`, `deepseek-v4-pro`, `anthropic/claude-sonnet-4-6`, …),
 *  none of which appear in the exact table above — without this they priced
 *  to a silent $0, blanking every cost/Pareto axis downstream. */
const FAMILY_PRICING: Array<[RegExp, TokenPrice]> = [
  [/claude.*opus/, { input: 0.015, output: 0.075 }],
  [/claude.*haiku/, { input: 0.0008, output: 0.004 }],
  [/claude.*sonnet|claude-code|claude-sonnet/, { input: 0.003, output: 0.015 }],
  [/gpt-4o-mini/, { input: 0.00015, output: 0.0006 }],
  [/gpt-5|gpt-4\.1|o[134]\b/, { input: 0.00125, output: 0.01 }],
  [/gpt-4o|gpt-4/, { input: 0.0025, output: 0.01 }],
  [/deepseek/, { input: 0.0003, output: 0.0011 }],
  [/glm|zhipu|zai/, { input: 0.0006, output: 0.0022 }],
  [/kimi|moonshot/, { input: 0.0006, output: 0.0025 }],
  [/qwen/, { input: 0.0004, output: 0.0012 }],
  [/gemini.*flash/, { input: 0.0001, output: 0.0004 }],
  [/gemini/, { input: 0.00125, output: 0.005 }],
  [/llama/, { input: 0.0002, output: 0.0006 }],
]

/** Normalize a model id for pricing: drop a `@snapshot` suffix, lowercase,
 *  and keep the final harness/provider-prefixed segment so family regexes
 *  match (`opencode/zai-coding-plan/glm-5.1` → `glm-5.1`). */
function normalizeModelId(model: string): string {
  return (model.split('@')[0] ?? model).trim().toLowerCase()
}

/** Resolve pricing for a model id: exact table, then family fallback.
 *  Returns null when the id matches nothing (caller decides — never a
 *  silent-zero masquerading as a real $0 cost). */
export function resolveModelPricing(model: string): TokenPrice | null {
  if (MODEL_PRICING[model]) return MODEL_PRICING[model]
  const id = normalizeModelId(model)
  if (MODEL_PRICING[id]) return MODEL_PRICING[id]
  for (const [pattern, price] of FAMILY_PRICING) {
    if (pattern.test(id)) return price
  }
  return null
}

/** True when `model` has known pricing (exact or family). Lets cost-aware
 *  callers distinguish a real $0 from an unpriced model. */
export function isModelPriced(model: string): boolean {
  return resolveModelPricing(model) !== null
}

const warnedUnpricedModels = new Set<string>()

/** Estimate token count from string length (chars / 4 approximation) */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

/** Calculate cost in USD from token counts and model. Unknown models warn
 *  once (not a silent zero) and return 0 so callers that ignore pricing keep
 *  working; cost-sensitive callers should gate on {@link isModelPriced}. */
export function estimateCost(inputTokens: number, outputTokens: number, model: string): number {
  const pricing = resolveModelPricing(model)
  if (!pricing) {
    if (!warnedUnpricedModels.has(model)) {
      warnedUnpricedModels.add(model)
      console.warn(
        `estimateCost: no pricing for model "${model}" — returning 0; add it to ` +
          'MODEL_PRICING/FAMILY_PRICING (cost/Pareto axes will be blank until then)',
      )
    }
    return 0
  }
  return (inputTokens / 1000) * pricing.input + (outputTokens / 1000) * pricing.output
}

/**
 * TokenCounter — accumulates token usage and cost across turns.
 */
export class TokenCounter {
  private totalInput = 0
  private totalOutput = 0
  private totalCost = 0
  private model: string

  constructor(model = 'gpt-4o') {
    this.model = model
  }

  /** Record tokens for a turn, returns per-turn cost */
  record(inputTokens: number, outputTokens: number): number {
    this.totalInput += inputTokens
    this.totalOutput += outputTokens
    const cost = estimateCost(inputTokens, outputTokens, this.model)
    this.totalCost += cost
    return cost
  }

  /** Estimate and record from raw text */
  recordFromText(
    inputText: string,
    outputText: string,
  ): { inputTokens: number; outputTokens: number; cost: number } {
    const inputTokens = estimateTokens(inputText)
    const outputTokens = estimateTokens(outputText)
    const cost = this.record(inputTokens, outputTokens)
    return { inputTokens, outputTokens, cost }
  }

  getTotalInput(): number {
    return this.totalInput
  }
  getTotalOutput(): number {
    return this.totalOutput
  }
  getTotalCost(): number {
    return this.totalCost
  }
}

/**
 * MetricsCollector — collects per-turn metrics from the product.
 *
 * After each turn, queries the product's APIs to measure state changes.
 */
export class MetricsCollector {
  private client: ProductClient
  private workspaceId: string
  private metrics: TurnMetrics[] = []
  constructor(client: ProductClient, workspaceId: string) {
    this.client = client
    this.workspaceId = workspaceId
  }

  /** Collect metrics after a turn completes */
  async collect(
    turn: number,
    responseLatencyMs: number,
    responseChars: number,
    codeBlocksProduced: number,
    blocksExtracted: number,
    completionCriteriaMet: number,
    completionCriteriaTotal: number,
    qualityScore?: number,
    inputTokens = 0,
    outputTokens = 0,
    estimatedCostUsd = 0,
  ): Promise<TurnMetrics> {
    const state = await this.getState()

    const m: TurnMetrics = {
      turn,
      timestamp: new Date().toISOString(),
      tasks: state.tasks,
      events: state.events,
      proposals: state.proposals,
      vaultFiles: state.vaultFiles.length,
      responseLatencyMs,
      responseChars,
      codeBlocksProduced,
      blocksExtracted,
      qualityScore,
      inputTokens,
      outputTokens,
      estimatedCostUsd,
      totalCostUsd: estimatedCostUsd,
      completionPercent:
        completionCriteriaTotal > 0 ? (completionCriteriaMet / completionCriteriaTotal) * 100 : 0,
    }

    this.metrics.push(m)
    return m
  }

  /** Get current product state */
  async getState(): Promise<DriverState> {
    const [tasks, events, approvals, vaultFiles] = await Promise.all([
      this.client.getTasks(this.workspaceId),
      this.client.getEvents(this.workspaceId),
      this.client.getApprovals(this.workspaceId),
      this.client.getVaultTree(this.workspaceId),
    ])

    return {
      tasks: tasks.length,
      events: events.length,
      proposals: {
        pending: approvals.filter((a) => a.status === 'pending').length,
        approved: approvals.filter((a) => a.status === 'approved').length,
        rejected: approvals.filter((a) => a.status === 'rejected').length,
      },
      vaultFiles,
      codeBlocks: 0,
      generations: 0,
    }
  }

  /** Get all collected metrics */
  getMetrics(): TurnMetrics[] {
    return [...this.metrics]
  }

  /** Get convergence curve (completion% over turns) */
  getConvergenceCurve(): number[] {
    return this.metrics.map((m) => m.completionPercent)
  }
}
