import type { RunCriticOptions, RunTrace } from './run-critic'
import type { RunScore, RunScoreWeights } from './run-score'

export interface HostedJudgeDimension {
  name: string
  weight: number
  rubric: string
}

export interface HostedJudgeConfig {
  model: string
  mode?: 'llm' | 'sandbox' | 'composite'
  systemPrompt?: string
  rubricTemplate?: string
  temperature?: number
  maxTurns?: number
  tools?: string[]
  dimensions?: HostedJudgeDimension[]
  setupCommand?: string
  scripts?: Record<string, string>
}

export interface HostedJudgeRequest {
  prompt: string
  response: string
  rubric?: string
  reference?: string
  judge: HostedJudgeConfig
}

export interface HostedJudgeResponse {
  score: number
  reasoning: string
  cost: number
  dimensions?: Array<{ name: string; score: number; reasoning: string }>
  evidence?: Array<{ type: string; content: string }>
  turns?: number
  parseFailed?: boolean
  rawOutput?: string
}

export interface HostedRunScoreRequest {
  trace: RunTrace
  weights?: Partial<RunScoreWeights>
  driftPatterns?: string[]
}

export interface HostedRunScoreResponse {
  score: RunScore
  aggregate: number
  weights: RunScoreWeights
  notes: string[]
}

export type HostedRunCriticConfig = Pick<RunCriticOptions, 'weights'> & {
  driftPatterns?: string[]
}
