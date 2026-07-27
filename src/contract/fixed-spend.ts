import type { AgentCandidateFixedSpend } from '@tangle-network/agent-interface'

export function addFixedSpend(
  left: AgentCandidateFixedSpend,
  right: AgentCandidateFixedSpend,
): AgentCandidateFixedSpend {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    cachedInputTokens: left.cachedInputTokens + right.cachedInputTokens,
    reasoningTokens: left.reasoningTokens + right.reasoningTokens,
    modelCalls: left.modelCalls + right.modelCalls,
    costUsdNanos: left.costUsdNanos + right.costUsdNanos,
    costProvenance:
      left.costProvenance === 'observed' && right.costProvenance === 'observed'
        ? 'observed'
        : 'estimated',
  }
}
