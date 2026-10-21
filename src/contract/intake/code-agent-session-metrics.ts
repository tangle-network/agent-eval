import { estimateCost, isModelPriced } from '../../metrics'
import type { RunCostProvenance, RunTokenUsage } from '../../run-record'
import { extractUsage } from '../../trace/extract-usage'
import type { CodeAgentSessionMetrics } from './code-agent-session-types'

import { clamp01 } from '../../run-score'
export function emptyMetrics(entries: number): CodeAgentSessionMetrics {
  return {
    entries,
    userMessages: 0,
    assistantMessages: 0,
    reasoningItems: 0,
    toolCalls: 0,
    toolOutputs: 0,
    toolErrors: 0,
    unclassifiedErrors: 0,
    patchAttempts: 0,
    patchSuccesses: 0,
    patchFailures: 0,
    turnsStarted: 0,
    turnsCompleted: 0,
    turnsAborted: 0,
    contextCompactions: 0,
    mcpCalls: 0,
    subagentCalls: 0,
    skillCalls: 0,
    hookCalls: 0,
    webCalls: 0,
    codeActions: 0,
    prLinks: 0,
    fileSnapshots: 0,
    graphNodes: 0,
    graphEdges: 0,
    actionCandidates: 0,
    verificationReports: 0,
    completionDecisions: 0,
    reliabilityRows: 0,
    reliabilityLift: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cachedTokens: 0,
    cacheWriteTokens: 0,
    observedCostUsd: 0,
    observedCostCaptured: false,
    wallMs: 0,
    processScore: 0,
  }
}

export function penalizeErrors(base: number, metrics: CodeAgentSessionMetrics): number {
  const operations = Math.max(1, metrics.toolCalls + metrics.patchAttempts)
  const errorRate = Math.min(1, (metrics.toolErrors + metrics.patchFailures) / operations)
  return clamp01(base * (1 - 0.5 * errorRate))
}

type TokenTotals = Required<Omit<RunTokenUsage, 'tokensKnown'>>

export function emptyTokenTotals(): TokenTotals {
  return { input: 0, output: 0, reasoning: 0, cached: 0, cacheWrite: 0 }
}

export function hasTokenTotals(usage: TokenTotals): boolean {
  return (
    usage.input > 0 ||
    usage.output > 0 ||
    usage.reasoning > 0 ||
    usage.cached > 0 ||
    usage.cacheWrite > 0
  )
}

export function addUsage(
  metrics: CodeAgentSessionMetrics,
  usage: Record<string, unknown> | null | undefined,
): void {
  const parsed = readUsage(usage)
  metrics.inputTokens += parsed.input
  metrics.outputTokens += parsed.output
  metrics.reasoningTokens += parsed.reasoning
  metrics.cachedTokens += parsed.cached
  metrics.cacheWriteTokens += parsed.cacheWrite
}

export function addUsageTo(
  totals: TokenTotals,
  usage: Record<string, unknown> | null | undefined,
): void {
  const parsed = readUsage(usage)
  totals.input += parsed.input
  totals.output += parsed.output
  totals.reasoning += parsed.reasoning
  totals.cached += parsed.cached
  totals.cacheWrite += parsed.cacheWrite
}

export function readUsage(usage: Record<string, unknown> | null | undefined): TokenTotals {
  const parsed = extractUsage(usage)
  return {
    input: parsed?.input ?? 0,
    output: parsed?.output ?? 0,
    reasoning: parsed?.reasoning ?? 0,
    cached: parsed?.cached ?? 0,
    cacheWrite: parsed?.cacheWrite ?? 0,
  }
}

export function resolveSessionCost(
  explicit: RunCostProvenance | undefined,
  metrics: CodeAgentSessionMetrics,
  model: string,
): { costUsd: number | null; costProvenance: RunCostProvenance } {
  if (explicit) {
    if (explicit.kind === 'uncaptured') {
      if (explicit.usd !== null) throw new Error('uncaptured cost must have usd: null')
      return { costUsd: null, costProvenance: explicit }
    }
    if (explicit.kind === 'lower-bound') {
      if (explicit.usd !== null) throw new Error('lower-bound cost must have usd: null')
      if (!Number.isFinite(explicit.knownLowerBoundUsd) || explicit.knownLowerBoundUsd <= 0) {
        throw new Error('lower-bound cost must have a finite, positive knownLowerBoundUsd')
      }
      return { costUsd: null, costProvenance: explicit }
    }
    if (!Number.isFinite(explicit.usd) || explicit.usd < 0) {
      throw new Error(`${explicit.kind} cost must be a finite, non-negative USD amount`)
    }
    return { costUsd: explicit.usd, costProvenance: explicit }
  }

  if (metrics.observedCostCaptured) {
    const costProvenance = { kind: 'observed', usd: metrics.observedCostUsd } as const
    return { costUsd: metrics.observedCostUsd, costProvenance }
  }

  const hasUsage = metrics.inputTokens > 0 || metrics.outputTokens > 0
  if (hasUsage && isModelPriced(model)) {
    const costUsd = estimateCost(metrics.inputTokens, metrics.outputTokens, model)
    return { costUsd, costProvenance: { kind: 'estimated', usd: costUsd } }
  }

  return { costUsd: null, costProvenance: { kind: 'uncaptured', usd: null } }
}

