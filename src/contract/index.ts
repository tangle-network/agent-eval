/**
 * # `@tangle-network/agent-eval/contract` — the LAND-tier public surface.
 *
 * **Stability:** every export in this file is the frozen public API for
 * foreign-agent consumers. New minors only ADD; nothing here changes shape
 * or disappears in a 0.x minor. Wire your agent against these imports and
 * expect them to keep working across `agent-eval` upgrades.
 *
 * ## What this gives you
 *
 * The minimum surface area to evaluate + self-improve any agent — yours,
 * a partner's, anything that returns text or a structured artifact. No
 * Tangle sandbox required. No Tangle account required. Local files,
 * stdout, your own LLM endpoint.
 *
 * ## The five types you need to know
 *
 * 1. **`Scenario`** — what you evaluate against. Stable `id` + `kind` +
 *    optional `tags`; extend with your domain fields.
 * 2. **`Dispatch<TScenario, TArtifact>`** — the seam. One function:
 *    scenario in, artifact out. Whatever your agent is, wrap it as a
 *    `Dispatch` and the eval engine drives it. (`DispatchFn` is the
 *    legacy internal name; `Dispatch` is the canonical export.)
 * 3. **`JudgeConfig<TArtifact, TScenario>`** — pluggable dimensional
 *    scorer. Bring an LLM judge, a deterministic check, an ensemble —
 *    the engine only cares about `score(input) → JudgeScore`.
 * 4. **`SurfaceProposer`** — proposes next candidate surfaces for the
 *    optimization loop. Use `gepaProposer` (reflective LLM proposal) or
 *    `evolutionaryProposer`, or write your own.
 * 5. **`Gate`** — promotion guard. Returns `'ship'` / `'hold'` /
 *    `'need_more_work'` / others for each candidate; the loop only ships
 *    what passes. `defaultProductionGate` is the composite default;
 *    `paretoSignificanceGate` decides over the multi-objective evidence
 *    vector (per-axis significance + Pareto dominance, no scalar collapse)
 *    and is itself factored as a pluggable `PromotionPolicy` over a
 *    `buildEvidenceVector` bus so competing strategies share one evidence set.
 *
 * ## The four functions you'll call
 *
 * 1. **`runEval(options)`** — one-off evaluation across scenarios. Use
 *    when you just want a score.
 * 2. **`runCampaign(options)`** — structured set of cells (scenarios ×
 *    seeds × replicates) that emits a `CampaignResult` downstream tools
 *    can read.
 * 3. **`runImprovementLoop(options)`** — the closed self-improvement
 *    loop: campaign → judge → mutator → gate → next generation. Stops
 *    when the gate ships or the budget exhausts.
 * 4. **`defaultProductionGate(options)`** — the standard held-out gate
 *    most consumers want; compose with `composeGate` to add custom
 *    checks (regression deltas, cost caps, red-team signals).
 *
 * ## Two storage backends you'll pick from
 *
 * - **`fsCampaignStorage()`** — writes traces, artifacts, and campaign
 *   manifests to a local directory. The default for Node consumers.
 * - **`inMemoryCampaignStorage()`** — Cloudflare Workers, edge, tests,
 *   any environment without filesystem. Same interface; runs the same
 *   campaigns; nothing persists past the process.
 *
 * ## Optional: deployment-outcome store (predictive validity)
 *
 * Record which candidates shipped + whether downstream metrics actually
 * improved. Feeds back into the gate so promotion decisions calibrate
 * against observed reality, not just held-out scores.
 *
 * ## Optional: RL bridge
 *
 * If you want to feed campaign output into RL training (TRL, prime-rl,
 * in-house), the RL bridge converts a `CampaignResult` to canonical
 * `RunRecord` + preference shapes. Pull those from
 * `@tangle-network/agent-eval/rl` directly — RL is opt-in and not part
 * of the LAND-tier contract.
 *
 * ## What's NOT here
 *
 * Anything below this barrel is internal substrate that may move
 * between minors. If you find yourself reaching for an import path other
 * than `/contract`, `/campaign`, `/rl`, `/belief-state`, `/reporting`,
 * `/control`, `/telemetry`, `/analyst`, `/traces`, `/testing`, or another
 * named package export, you're using internals. Open an issue so we can
 * promote what you need into a named subpath.
 */

// ── Types: scenarios, dispatch, judges, gates, surfaces ──────────────

// Foreign-agent seam — canonical name. `DispatchFn` is the legacy alias
// that the existing campaign code uses internally; consumers should
// import `Dispatch`.
export type {
  CampaignAggregates,
  CampaignArtifactWriter,
  CampaignCellResult,
  CampaignCostMeter,
  CampaignResult,
  CampaignTraceWriter,
  CodeSurface,
  DispatchContext,
  DispatchFn as Dispatch,
  Gate,
  GateContext,
  GateDecision,
  GateResult,
  GenerationCandidate,
  GenerationRecord,
  JudgeConfig,
  JudgeDimension,
  JudgeScore,
  MutableSurface,
  Mutator,
  OptimizationProposer,
  OptimizerConfig,
  Scenario,
  SessionScript,
  SurfaceProposer,
} from '../campaign/types'

// ── Campaign primitives (the four functions) ─────────────────────────

export { type RunEvalOptions, runEval } from '../campaign/presets/run-eval'
export {
  type RunImprovementLoopOptions,
  type RunImprovementLoopResult,
  runImprovementLoop,
} from '../campaign/presets/run-improvement-loop'
export { type RunCampaignOptions, runCampaign } from '../campaign/run-campaign'

// ── Proposers ────────────────────────────────────────────────────────

export {
  type EvolutionaryProposerOptions,
  evolutionaryProposer,
} from '../campaign/proposers/evolutionary'
export { type GepaProposerOptions, gepaProposer } from '../campaign/proposers/gepa'

// ── Gates ────────────────────────────────────────────────────────────

export { composeGate } from '../campaign/gates/compose'
export {
  type DefaultProductionGateOptions,
  defaultProductionGate,
} from '../campaign/gates/default-production-gate'
export { type HeldOutGateOptions, heldOutGate } from '../campaign/gates/heldout-gate'
export {
  type AxisEvidence,
  type AxisVerdict,
  type BuildEvidenceVectorOptions,
  buildEvidenceVector,
  type EvidenceVector,
  type ObjectiveSource,
  type ParetoSignificanceGateOptions,
  type PromotionObjective,
  type PromotionPolicy,
  paretoPolicy,
  paretoSignificanceGate,
} from '../campaign/gates/promotion-policy'

// ── Storage backends ─────────────────────────────────────────────────

export {
  type CampaignStorage,
  fsCampaignStorage,
  inMemoryCampaignStorage,
} from '../campaign/storage'

// ── Deployment outcome store (predictive-validity calibration) ───────

export {
  type DeploymentOutcome,
  FileSystemOutcomeStore,
  type FileSystemOutcomeStoreOptions,
  InMemoryOutcomeStore,
  type OutcomeStore,
} from '../meta-eval/outcome-store'

// ── One-shot helper (LAND-tier happy path) ───────────────────────────

export {
  type SelfImproveBudget,
  type SelfImproveLlm,
  type SelfImproveOptions,
  type SelfImproveProgressEvent,
  type SelfImproveResult,
  selfImprove,
} from './self-improve'

// ── Analysis: turn observed runs into an actionable decision packet ──
// The rigor layer — paired bootstrap lift, judge stats, inter-rater
// agreement, contamination, failure clustering, outcome correlation,
// recommendations. `selfImprove()` consumers (closed loop) and
// `analyzeRuns()` direct callers (observed runs, no loop) get the same
// `InsightReport` shape.

// The stable analyst entry: build the canonical registry (feeds
// `AnalyzeRunsOptions.analyst` → `failureClusters`) and read its findings.
// The full analyst machinery stays under `@tangle-network/agent-eval/analyst`.
export {
  buildDefaultAnalystRegistry,
  type DefaultAnalystRegistryOptions,
} from '../analyst/default-registry'
export type { AnalystFinding } from '../analyst/types'
export type { AnalyzeRunsOptions } from './analyze-runs'
export { analyzeRuns } from './analyze-runs'
export type {
  FailureClusterInsight,
  InsightReport,
  InterRaterInsight,
  JudgeInsight,
  LiftInsight,
  OutcomeCorrelationInsight,
  Recommendation,
  ReleaseSummary,
  ScalarDistribution,
} from './insight-report'

// ── Run-to-run diff (compare two eval runs, or a run's baseline→winner) ──

export {
  diffGenerations,
  diffRunBaselineToWinner,
  diffRuns,
  type EvalCellScoreDelta,
  type EvalDimensionDelta,
  type EvalGenerationDiff,
  type EvalRunDiff,
} from './diff'

// ── Intake: external data sources → RunRecord[] for analyzeRuns() ────
// Adapters that meet customers where their data already lives. Pipe the
// output straight into `analyzeRuns({ runs })`.

export {
  type AgentTraceContributor,
  type AgentTraceContributorType,
  type AgentTraceConversation,
  type AgentTraceFile,
  type AgentTraceIndex,
  type AgentTraceRange,
  type AgentTraceRecord,
  type AuthoringProvenance,
  type CodeAgentSessionDiagnostic,
  type CodeAgentSessionIntakeOptions,
  type CodeAgentSessionIntakeResult,
  type CodeAgentSessionMetrics,
  type CodeAgentSessionSource,
  type FeedbackTableMeta,
  type FeedbackTableRow,
  type FromFeedbackTableOptions,
  type FromFeedbackTableResult,
  type FromOtelSpansOptions,
  fromClaudeCodeSession,
  fromCodexSession,
  fromFeedbackTable,
  fromKimiCodeSession,
  fromOpenCodeSession,
  fromOtelSpans,
  fromPigraphSession,
  fromPiSession,
  type ParsedCodeAgentJsonl,
  type PartitionByAuthoringModelResult,
  parseAgentTrace,
  parseCodeAgentJsonl,
  partitionRunsByAuthoringModel,
} from './intake'
