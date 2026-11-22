// A simulated world with a clock, for agents whose choices pay off later.
//
// A scenario is data. Its public half is everything an agent may read: a
// brief, a budget, a horizon and levers with stated guidelines. Its `key` is
// the hidden half: what each lever really returns, when, and how noisily. The
// world reads the key to simulate; no tool result, tool description or brief
// is built from it.

/** One thing the agent can spend on. Every field is public. */
export interface WorldLever {
  id: string
  label: string
  /** What the lever is and what is publicly known about it. */
  description: string
  /** Suggested starting daily spend. */
  startRate: number
  /** Recommended ceiling on daily spend; exceeding it is allowed. */
  guidelineRate: number
  /** Hard ceiling on daily spend; the world refuses more. */
  maxRate: number
  /** Spending on this lever needs a granted approval that covers the rate. */
  requiresApproval: boolean
  /** Public estimate of when results from a day's spend usually land. */
  resultLagDays: { from: number; to: number }
}

/** A slow, lasting penalty for driving a lever too hard. */
export interface WorldLeverWear {
  /** Spend over any 7 days above which the lever's health falls. */
  weeklyLoad: number
  /** Health lost per day at twice the weekly load; scales with the excess. */
  damagePerDay: number
  /** Health regained per day at or under the weekly load. */
  recoveryPerDay: number
  /** Health never falls below this share of full yield. */
  floor: number
}

/** The hidden truth about one lever. */
export interface WorldLeverKey {
  /** Outcomes per unit of spend at full ramp and health, under saturation. */
  yield: number
  /** Days between a day's spend and each outcome it produces landing. */
  delayDays: { min: number; median: number; max: number }
  /** Sigma of the lognormal shock one week applies to a lever's yield. */
  weeklyNoise: number
  /** Consecutive days of spend needed to reach full yield; 1 is immediate.
   *  A day without spend starts the ramp over. */
  rampDays: number
  /** Daily spend above which each extra unit earns `marginalYield` of the yield. */
  saturationRate: number
  marginalYield: number
  wear?: WorldLeverWear
}

/** What the scorer treats as enough evidence to kill or scale a lever. */
export interface WorldEvidenceRule {
  /** A decision is supported once this many outcomes have landed, or once the
   *  lever's matured spend is large enough that a break-even lever would have
   *  landed this many. */
  minOutcomes: number
  /** A day's net change by at least this factor is a decision the rule
   *  judges: a raise is a scale-up, a cut, to zero included, is a cut. */
  scaleFactor: number
}

/** Everything hidden from the agent. */
export interface WorldScenarioKey {
  levers: Readonly<Record<string, WorldLeverKey>>
  evidence: WorldEvidenceRule
}

export interface WorldScenario {
  id: string
  title: string
  /** What the agent is told at the start of every session. */
  brief: string
  /** Calendar date of day 0, as YYYY-MM-DD. */
  startDate: string
  /** The episode ends at the start of this day; only outcomes landed before it count. */
  horizonDays: number
  /** Days between one agent session and the next. */
  sessionEveryDays: number
  /** Starting budget. Unspent budget keeps its face value in the end state. */
  budget: number
  /** Unit the budget and every rate are stated in. */
  currency: string
  /** The thing levers produce and what one of them is worth in budget units. */
  outcome: { unit: string; value: number }
  /** Days between an approval request and its decision. */
  approvalDelayDays: number
  levers: readonly WorldLever[]
  key: WorldScenarioKey
}

export type WorldApprovalStatus = 'pending' | 'granted'

export interface WorldApproval {
  id: string
  lever: string
  /** Highest daily rate the approval covers. */
  maxDailyRate: number
  reason: string
  requestedDay: number
  decisionDay: number
  status: WorldApprovalStatus
}

/** The agent-side inputs that change the world. Replaying them in order on
 *  the same scenario and seed reproduces the episode's end state. */
export type WorldAction =
  | { kind: 'set_rate'; day: number; lever: string; dailyRate: number }
  | { kind: 'spend_once'; day: number; lever: string; amount: number }
  | { kind: 'request_approval'; day: number; lever: string; maxDailyRate: number; reason: string }

export type WorldRefusal =
  | 'unknown_tool'
  | 'invalid_input'
  | 'unknown_lever'
  | 'over_max_rate'
  | 'approval_missing'
  | 'insufficient_budget'
  | 'episode_over'
  | 'call_limit'
  | 'session_closed'

export interface WorldToolResult {
  ok: boolean
  /** Set when the world refused the call. */
  refused?: WorldRefusal
  /** Plain-language account of the refusal or the effect. */
  message: string
  /** Public data returned by the call. */
  data?: unknown
}

/** One tool call, as the decision log keeps it. */
export interface WorldLogEntry {
  seq: number
  session: number
  day: number
  tool: string
  input: unknown
  result: WorldToolResult
  /** The state change the call made, when it made one. */
  action?: WorldAction
  /** What the world knew about the lever when a rate was changed. Built from
   *  hidden state, so it lives in the log and never in a tool result. */
  evidence?: WorldDecisionEvidence
}

export interface WorldDecisionEvidence {
  lever: string
  /** The lever's standing rate when the day began, before this session's changes. */
  rateAtDayStart: number
  /** Outcomes landed by the decision. */
  landed: number
  /** Spend old enough that every outcome it produced had landed by the decision. */
  maturedSpend: number
}

export interface WorldToolDefinition {
  name: string
  description: string
  /** JSON Schema of the input object. */
  inputSchema: Record<string, unknown>
}

/** What one agent session receives. Nothing else crosses between sessions. */
export interface WorldSession {
  index: number
  day: number
  /** Calendar date of `day`, as YYYY-MM-DD. */
  date: string
  daysLeft: number
  brief: string
  /** The notes the agent saved in earlier sessions, by key. */
  notes: Readonly<Record<string, string>>
  tools: readonly WorldToolDefinition[]
  call(name: string, input?: unknown): WorldToolResult
}

/** An agent is whatever acts in one session. A model-backed agent runs its
 *  tool loop here; a scripted policy calls the same tools from code. */
export type WorldAgent = (session: WorldSession) => Promise<void> | void

export interface WorldLeverEndState {
  rate: number
  health: number
  spent: number
  /** Outcomes landed before the horizon. */
  landed: number
  /** Outcomes paid for that had not landed by the horizon. */
  inFlight: number
  /** Days the trailing 7-day spend sat above the lever's weekly load. */
  overdriveDays: number
}

export interface WorldEndState {
  day: number
  budgetLeft: number
  spent: number
  outcomes: number
  /** `budgetLeft + outcomes * outcome.value`: what the episode is scored on. */
  value: number
  levers: Record<string, WorldLeverEndState>
  approvals: WorldApproval[]
}

export interface WorldPrematureDecision {
  seq: number
  day: number
  lever: string
  kind: 'cut' | 'scale'
  landed: number
  maturedSpend: number
}

export interface WorldDecisionCost {
  seq: number
  day: number
  action: WorldAction
  /** End value with this one action removed, minus the end value with it, on
   *  the episode's own seed. Positive: the episode would have ended higher
   *  without the action. Luck is in this number. */
  realizedCost: number
  /** The same difference averaged over fresh noise seeds, every other action
   *  held fixed: what the action cost in expectation. */
  expectedCost: number
}

export interface WorldScore {
  /** End-state value: budget left plus the value of landed outcomes. */
  value: number
  /** `value` minus the starting budget, which is what doing nothing scores. */
  gain: number
  /** Refused calls by reason. `approval_missing` is an attempted spend with no
   *  recorded approval. */
  refused: Partial<Record<WorldRefusal, number>>
  /** Deep cuts and scale-ups made before the lever's evidence met the scenario's rule. */
  prematureDecisions: WorldPrematureDecision[]
  /** Lever-days spent above a wear threshold. */
  overdriveDays: number
  /** Value of outcomes paid for that landed too late to count. */
  lateValue: number
  /** Sessions in which the agent threw. They are a service failure, not a
   *  choice: an episode with any is not a clean measurement of the agent. */
  failedSessions: number
}

export interface WorldSessionRecord {
  index: number
  day: number
  calls: number
  /** Message of an error the agent threw; the episode continued without it. */
  error?: string
}

export interface WorldEpisode {
  scenarioId: string
  /** Digest of the whole scenario, key included. */
  scenarioDigest: string
  seed: number
  sessions: WorldSessionRecord[]
  log: WorldLogEntry[]
  /** Notes held when the episode ended. */
  notes: Record<string, string>
  end: WorldEndState
  score: WorldScore
}
