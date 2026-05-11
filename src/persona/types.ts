/**
 * Persona eval primitive — shared types.
 *
 * A `PersonaSpec` is the canonical end-to-end eval input across every
 * product agent: tax-agent, legal-agent, creative-agent, gtm-agent,
 * forge-chat. Today each consumer reinvents a slightly-different
 * "persona-run-this-multi-turn-flow-and-score" loop; the type below
 * standardises the shape so the same primitive (`runPersonaEval`) can
 * drive any of them.
 *
 * Three contracts in this file:
 *
 *   `PersonaSpec`     — what the eval scores (input)
 *   `PersonaRunner`   — how the eval calls the system under test
 *   `PersonaScorer`   — how the eval converts outputs to a per-persona
 *                       outcome the framework can turn into a `RunRecord`
 *
 * The runner returns an async iterable of "events" — runtime stream
 * events, tool calls, partial messages, whatever the backend produces.
 * The library normalises a few well-known shapes (text events, tool
 * spans) into trace spans; everything else gets recorded as a raw event
 * on the run for forensics. The point is the runner has full
 * generality — chat-runtime, forge-builder-sim, customer-sim, all wear
 * the same shape.
 */

/**
 * One turn in a multi-turn persona. The persona's user-facing message
 * lives in `input`, and per-turn expectations the scorer can read live
 * in `expect`. Expectations are advisory data the scorer interprets;
 * the framework does not enforce them automatically.
 */
export interface PersonaTurn<TInput = unknown> {
  id: string
  /** What the user says/sends at this turn — passed to runner.runTurn. */
  input: TInput
  /** Per-turn expectations the scorer can read; load-bearing for multi-turn flows. */
  expect?: PersonaTurnExpectation
  /** Free-form metadata the runner/scorer may read. */
  metadata?: Record<string, unknown>
}

export interface PersonaTurnExpectation {
  /** The agent should refuse / block the turn. */
  blocked?: boolean
  /** Gap ids the agent should surface as the reason for blocking. */
  blockingGapIds?: string[]
  /** The agent should produce a proposal artifact this turn. */
  proposal?: boolean
  /** Persona rejects the agent's first proposal with the given feedback. */
  rejectAndRetry?: { feedback: string }
  /** The agent should write to the vault. */
  vaultUpdate?: { path: string; bodyContains?: string[] }
  /** Extension points — consumers may attach arbitrary expectations. */
  [extra: string]: unknown
}

/**
 * A persona — an ordered, scenario-shaped multi-turn flow with seed
 * state, hard constraints, messy truths, and required clarification
 * gates. Generic over the turn-input type so consumers can keep their
 * own (e.g. `{ userMessage, attachments }`).
 */
export interface PersonaSpec<TInput = unknown, TDomain = Record<string, unknown>> {
  id: string
  label: string
  /** Free-form domain data — tax facts, product profile, workspace name. */
  domain?: TDomain
  /** Seed state — workspace/integration/vault initial conditions. */
  initialState?: Record<string, unknown>
  turns: PersonaTurn<TInput>[]
  /** Hard constraints the runner surfaces to the agent. */
  constraints?: string[]
  /** Known-bad inputs / missing data the agent must NOT trust. */
  badData?: string[]
  /** Items the agent MUST ask about before proceeding. */
  mustAsk?: string[]
  /** Free-form tags for filtering / reporting. */
  tags?: Record<string, string>
}

/**
 * Per-persona run state. The framework threads this through the
 * runner across turns so a runner can pick up where it left off.
 */
export interface PersonaRunState<TOutput = unknown> {
  personaId: string
  turnIndex: number
  history: PersonaTurnHistory<TOutput>[]
  /** Variant id when running multi-variant evals; defaults to `'baseline'`. */
  variantId?: string
  /** Variant payload forwarded by `runPersonaEval`. */
  variantPayload?: unknown
}

export interface PersonaTurnHistory<TOutput = unknown> {
  turnId: string
  input: unknown
  output: TOutput
  /** Wall-clock duration of this turn in ms. */
  durationMs: number
  /** Raw provider events captured during this turn, when available. */
  rawEventCount: number
}

/**
 * The runner receives the persona, the current turn, and the running
 * state, and returns an async iterable of events. Two well-known
 * event shapes are normalised into trace spans:
 *
 *   `{ type: 'text', text }`            — appended to the per-turn output
 *   `{ type: 'tool_call', name, args }` — recorded as a tool span
 *
 * Anything else is passed verbatim to `raws.jsonl` for forensics.
 *
 * The runner MUST yield at least one event so the framework knows the
 * turn produced something. Throwing aborts the persona run.
 */
export type PersonaRunner<TInput = unknown, TOutput = unknown> = (
  ctx: PersonaRunnerContext<TInput, TOutput>,
) => AsyncIterable<PersonaRunnerEvent<TOutput>>

export interface PersonaRunnerContext<TInput = unknown, TOutput = unknown> {
  persona: PersonaSpec<TInput>
  turn: PersonaTurn<TInput>
  state: PersonaRunState<TOutput>
  /**
   * Capture surface — the runner forwards these to any `callLlm`
   * invocation so the raw provider events land in the eval artifact by
   * construction. `llmOpts` is the consumer-supplied LLM client opts
   * pre-augmented with `rawSink` + `traceContext`.
   */
  capture: PersonaRunnerCaptureContext
}

export interface PersonaRunnerCaptureContext {
  /** The framework's run id for this persona × variant cell. */
  runId: string
  /** Pre-wired raw provider sink (rolls into the eval's raws.jsonl). */
  rawSink: import('../trace/raw-provider-sink').RawProviderSink
  /**
   * Pre-wired LLM client options — `rawSink` and `traceContext` already
   * populated. Spread additional fields if needed; do NOT replace the
   * sink unless you are intentionally opting out of capture.
   */
  llmOpts: import('../llm-client').LlmClientOptions
}

/**
 * Canonical event shapes recognised by the framework. Runners can yield
 * any of these or — under the `kind: 'raw'` escape hatch — arbitrary
 * objects that flow straight to `raws.jsonl`.
 */
export type PersonaRunnerEvent<TOutput = unknown> =
  | { kind: 'text'; text: string }
  | { kind: 'tool_call'; name: string; args?: unknown; result?: unknown; durationMs?: number }
  | { kind: 'output'; output: TOutput }
  | { kind: 'raw'; data: unknown }
  | { kind: 'cost'; usd: number; tokenUsage?: { input: number; output: number; cached?: number } }
  | { kind: 'model'; model: string }

/**
 * Score the persona at completion. The scorer receives the full
 * turn-by-turn history plus a flattened text output for convenience,
 * and returns an outcome the framework turns into a `RunRecord`.
 */
export type PersonaScorer<TOutput = unknown> = (
  input: PersonaScorerInput<TOutput>,
) => PersonaOutcome | Promise<PersonaOutcome>

export interface PersonaScorerInput<TOutput = unknown> {
  persona: PersonaSpec
  history: PersonaTurnHistory<TOutput>[]
  /** Concatenated text output across all turns, for convenience. */
  finalText: string
  /**
   * All raw provider events captured during this persona's runs. Each
   * event is the raw JSON object the runner yielded under `kind: 'raw'`
   * plus any events the framework auto-captured (tool calls, costs).
   */
  raws: unknown[]
  /** The pre-wired raw provider sink, for direct inspection by judges. */
  rawSinkPath?: string
}

export interface PersonaOutcome {
  /** Did the persona pass? */
  pass: boolean
  /** Composite score in [0,1]. */
  score: number
  /** Optional extra metrics that land in `outcome.raw`. */
  raw?: Record<string, number>
  /** Optional failure-taxonomy tag. */
  failureMode?: string
  /** Optional human-readable rationale. */
  notes?: string
}
