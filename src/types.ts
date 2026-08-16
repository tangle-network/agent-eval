import type { ChatClient } from './analyst/chat-client'
import type { CostLedgerHandle, CostLedgerSummary } from './cost-ledger'

// ── Scenario Definition ──

export interface Scenario {
  id: string
  persona: string
  label: string
  thesis: string
  dimensions: string[]
  turns: Turn[]
  artifactChecks: ArtifactCheck[]
  systemPromptAppend?: string
}

export interface Turn {
  user: string
  expectedBehaviors: string[]
  adversarial?: boolean
  feedbackType?: 'correction' | 'rejection' | 'vague' | 'contradictory' | 'escalation'
}

// ── Artifact Verification ──

export interface ArtifactCheck {
  type:
    | 'vault_file_exists'
    | 'vault_file_contains'
    | 'block_extracted'
    | 'code_valid'
    | 'generation_produced'
    | 'tool_created'
    | string
  target: string
  contains?: string
  minCount?: number
  description: string
}

// ── Judge Configuration ──

export interface JudgeRubric {
  name: string
  description: string
  dimensions: RubricDimension[]
}

export interface RubricDimension {
  name: string
  description: string
  anchor_low: string
  anchor_high: string
  weight: number
}

// ── Execution Results ──

export interface ScenarioResult {
  scenarioId: string
  persona: string
  turns: TurnResult[]
  artifactResults: ArtifactResult[]
  judgeScores: JudgeScore[]
  judgeErrors: number
  overallScore: number
  totalDurationMs: number
  artifacts: CollectedArtifacts
  /** Agent and judge spend attributed to this scenario. */
  cost?: CostLedgerSummary
}

export interface TurnResult {
  turnIndex: number
  userMessage: string
  agentResponse: string
  durationMs: number
  blocksExtracted: { type: string; title: string }[]
  containsCode: boolean
  containsToolCall: boolean
}

export interface ArtifactResult {
  check: ArtifactCheck
  passed: boolean
  detail?: string
}

export interface JudgeScore {
  judgeName: string
  dimension: string
  score: number
  reasoning: string
  evidence?: string
}

export interface CollectedArtifacts {
  vaultFiles: { path: string; content: string }[]
  blocksExtracted: { type: string; fields: Record<string, string> }[]
  codeBlocks: { language: string; code: string }[]
  toolCalls: string[]
}

// ── Product Client ──

export interface RouteMap {
  signup?: string
  login?: string
  workspaces?: string
  threads?: string
  chat?: string
  tasks?: string
  events?: string
  approvals?: string
  vault?: string
  generations?: string
  [key: string]: string | undefined
}

export interface ProductClientConfig {
  baseUrl: string
  routes: RouteMap
  /** Per-request timeout in ms before the request is aborted. Default 30s. */
  timeoutMs?: number
}

// ── Scenario Registry ──

export interface ScenarioFile {
  id: string
  category: string
  persona: string
  label: string
  thesis: string
  isControl?: boolean
  rubric?: {
    dimensions: {
      name: string
      description: string
      weight: number
    }[]
  }
  turns: Turn[]
  artifactChecks: ArtifactCheck[]
}

// ── Agent Driver ──

export interface CompletionCriterion {
  name: string
  check: (state: DriverState) => boolean
  progress?: (state: DriverState) => number
}

/**
 * How hard the simulated user pushes back. The driver LLM scales its tone
 * and follow-up aggression to this:
 *   cooperative — forgiving early adopter; accepts reasonable answers.
 *   demanding   — experienced professional; rejects vague or hedged answers.
 *   relentless  — senior partner reviewing for a client who will litigate;
 *                 interrogates every claim, accepts nothing undefended.
 */
export type PersonaRigor = 'cooperative' | 'demanding' | 'relentless'

export interface PersonaConfig {
  id: string
  role: string
  goal: string
  completionCriteria: CompletionCriterion[]
  maxTurns: number
  /** How adversarial the simulated user is. Defaults to 'demanding'. */
  rigor?: PersonaRigor
  /**
   * Domain expertise the simulated user holds — quoted into the driver
   * prompt so it challenges the agent with authority instead of vague
   * dissatisfaction. e.g. "a 15-year M&A partner who knows GAAP
   * working-capital mechanics cold".
   */
  expertise?: string
  /**
   * Substantive issues a senior professional in this role would
   * interrogate — traps the scenario hides, claims that must be defended.
   * The driver probes these without revealing them verbatim; the agent
   * must surface them on its own.
   */
  pressurePoints?: string[]
  /**
   * Curveballs the driver may inject once the agent is coasting — changed
   * facts, a hostile counterparty position, a new constraint. Forces the
   * agent to re-derive rather than recite.
   */
  curveballs?: string[]
}

export interface DriverState {
  tasks: number
  events: number
  proposals: { pending: number; approved: number; rejected: number }
  vaultFiles: string[]
  codeBlocks: number
  generations: number
}

export interface JudgeInput {
  scenario: Scenario
  turns: TurnResult[]
  artifacts: CollectedArtifacts
  /** Shared ledger for paid built-in judges. Direct calls default to an uncapped ledger. */
  costLedger?: CostLedgerHandle
  costPhase?: string
  costTags?: Record<string, string>
  signal?: AbortSignal
}

export type JudgeFn = (chat: ChatClient, input: JudgeInput) => Promise<JudgeScore[]>

// ── E2E Test Types ──

export interface TestResult {
  name: string
  passed: boolean
  duration: number
  detail?: string
  checks: CheckResult[]
}

export interface CheckResult {
  name: string
  passed: boolean
  expected: string
  actual: string
}
