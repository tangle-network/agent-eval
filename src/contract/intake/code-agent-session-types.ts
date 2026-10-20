import type { RunCostProvenance, RunRecord, RunSplitTag } from '../../run-record'
import type {
  CodeAgentSessionExecutionReceipt,
  CodeAgentSessionObservation,
  CodeAgentSessionSource,
} from './code-agent-observation'

export interface ParsedCodeAgentJsonl {
  entries: unknown[]
  malformedLines: number
}

export interface CodeAgentSessionMetrics {
  entries: number
  userMessages: number
  assistantMessages: number
  reasoningItems: number
  toolCalls: number
  toolOutputs: number
  toolErrors: number
  unclassifiedErrors: number
  patchAttempts: number
  patchSuccesses: number
  patchFailures: number
  turnsStarted: number
  turnsCompleted: number
  turnsAborted: number
  contextCompactions: number
  mcpCalls: number
  subagentCalls: number
  skillCalls: number
  hookCalls: number
  webCalls: number
  codeActions: number
  prLinks: number
  fileSnapshots: number
  graphNodes: number
  graphEdges: number
  actionCandidates: number
  verificationReports: number
  completionDecisions: number
  reliabilityRows: number
  reliabilityLift: number
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  cachedTokens: number
  cacheWriteTokens: number
  observedCostUsd: number
  observedCostCaptured?: boolean
  wallMs: number
  processScore: number
}

export interface CodeAgentSessionDiagnostic {
  source: CodeAgentSessionSource
  sessionId: string
  sourcePath?: string
  entries: number
  malformedLines: number
  hasExplicitTerminalSignal: boolean
  hasFinalOutput: boolean
  hasQualityLabel: boolean
  hasTokenUsage: boolean
  hasCost: boolean
  costKind?: RunCostProvenance['kind']
  warnings: string[]
}

export interface CodeAgentSessionIntakeResult {
  runs: RunRecord[]
  diagnostics: CodeAgentSessionDiagnostic[]
  metrics: CodeAgentSessionMetrics[]
  observations: CodeAgentSessionObservation[]
}

export interface CodeAgentSessionIntakeOptions {
  entries: unknown[]
  malformedLines?: number
  sourcePath?: string
  experimentId?: string
  candidateId?: string
  seed?: number
  splitTag?: RunSplitTag
  scenarioId?: string
  model?: string
  promptHash?: string
  configHash?: string
  commitSha?: string
  score?: number
  /** Explicit cost receipt. When omitted, source-reported cost wins, then a
   *  token-priced estimate, then uncaptured. */
  costProvenance?: RunCostProvenance
  /** Exact executor-owned process result. This is required when a provider's
   * JSON stream has no terminal event, as with `opencode run --format json`. */
  execution?: CodeAgentSessionExecutionReceipt
}

/** One transcript line after the intake rule ran on it. A blank line produces
 *  nothing, so every value here is either a parsed entry or a counted defect. */
export type CodeAgentJsonlLine =
  | { kind: 'entry'; lineNumber: number; entry: unknown }
  | { kind: 'malformed'; lineNumber: number }
