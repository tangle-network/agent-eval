import type { ProductClient } from './client'
import type { DriverState, TurnMetrics } from './types'

/** Per-1K token pricing for common models */
export const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  'gpt-4o': { input: 0.0025, output: 0.01 },
  'gpt-4o-mini': { input: 0.00015, output: 0.0006 },
  'gpt-4-turbo': { input: 0.01, output: 0.03 },
  'claude-sonnet-4-20250514': { input: 0.003, output: 0.015 },
  'claude-opus-4-20250514': { input: 0.015, output: 0.075 },
  'claude-3-haiku-20240307': { input: 0.00025, output: 0.00125 },
}

/** Estimate token count from string length (chars / 4 approximation) */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

/** Calculate cost in USD from token counts and model */
export function estimateCost(inputTokens: number, outputTokens: number, model: string): number {
  const pricing = MODEL_PRICING[model]
  if (!pricing) return 0
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
