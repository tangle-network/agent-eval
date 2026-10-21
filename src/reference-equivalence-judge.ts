
import type { ChatClient } from './analyst/chat-client'
import type { Scenario } from './campaign/types'
import type { CostLedgerHandle } from './cost-ledger'
import type { LlmCallMetadata } from './llm-client'






export interface ReferenceEquivalenceScenario extends Scenario {
  userRequest: string
  expectedAnswer: string
}

export interface ReferenceEquivalenceJudgeInput {
  userRequest: string
  expectedAnswer: string
  candidateOutput: string
}

export interface ReferenceEquivalenceJudgeOptions {
  /** Injected transport. No implicit provider or credentials are selected. */
  chat: ChatClient
  /** Falls back to the ChatClient's default model. */
  model?: string
  /** Used only by the direct-call adapter. */
  signal?: AbortSignal
  /** Optional receipt destination for direct calls; campaigns supply their own. */
  costLedger?: CostLedgerHandle
}

export interface ReferenceEquivalenceJudgeResult extends LlmCallMetadata {
  kind: 'reference-equivalence'
  version: string
  score: number
  rationale: string
}












