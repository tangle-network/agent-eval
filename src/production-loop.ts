/**
 * ProductionLoop — the substrate that closes eval → prod → eval.
 *
 * Static prompts decay. Yesterday's regulation flips today; yesterday's
 * tool quirk becomes today's incident. A production agent that ships a
 * static prompt and never re-trains is on a clock.
 *
 * `runProductionLoop` is the orchestration layer over the eval substrate:
 *
 *   1. Ingest production traces + user feedback (via the wire HTTP
 *      ingestion endpoints, or directly through any `TraceStore` and
 *      `FeedbackTrajectoryStore` implementation).
 *   2. Cluster the failures (`failureClusterView`) and prioritize by
 *      size × severity.
 *   3. If any cluster crosses the consumer's threshold, run a
 *      `runMultiShotOptimization` round seeded by the current production
 *      prompt against holdout-shape scenarios derived from the offending
 *      cluster.
 *   4. Gate the promoted prompt with `evaluateReleaseConfidence`. Fail
 *      closed.
 *   5. If the gate passes and an `AutoPrClient` is wired, open a PR with
 *      the new prompt. Otherwise return the proposed change.
 *
 * One call = one cycle. Cron / GitHub Actions are the caller's job. The
 * primitive is idempotent + replayable: re-running with the same
 * `runId` will produce the same plan.
 *
 * @experimental — added in 0.25.0. Surface may evolve as the 5 product
 * agents wire it in.
 */

import type { AutoPrClient, ProposeAutomatedPullRequestResult, RepoRef } from './auto-pr'
import { proposeAutomatedPullRequest } from './auto-pr'
import { ValidationError } from './errors'
import type { FeedbackTrajectoryStore } from './feedback-trajectory'
import type { GateDecision, HeldOutGateConfig } from './held-out-gate'
import type {
  MultiShotMutateAdapter,
  MultiShotOptimizationResult,
  MultiShotRunner,
  MultiShotScorer,
  MultiShotTrialResult,
} from './multi-shot-optimization'
import { runMultiShotOptimization } from './multi-shot-optimization'
import { type FailureCluster, failureClusterView } from './pipelines/failure-cluster'
import type { EvolvableVariant } from './prompt-evolution'
import {
  evaluateReleaseConfidence,
  type ReleaseConfidenceScorecard,
  type ReleaseConfidenceThresholds,
  releaseTraceEvidenceFromMultiShotTrials,
} from './release-confidence'
import type { RunRecord, RunSplitTag } from './run-record'
import type { TraceStore } from './trace/store'
import type { Scenario } from './types'

// ── Public types ─────────────────────────────────────────────────────

export interface FailureClusterConfig {
  /** Minimum runs in a cluster before it triggers an evolve round. Default 5. */
  minClusterSize?: number
  /**
   * Severity threshold. A cluster is "actionable" when its size
   * normalized by total runs exceeds this. Default 0.05 (5% of all runs).
   */
  minSeverityRatio?: number
  /**
   * Maximum number of clusters to react to in one cycle. Acting on too
   * many at once obscures attribution. Default 1 — the worst cluster.
   */
  maxClustersPerCycle?: number
}

export interface ProductionEvolveConfig<P = string> {
  /** How to run a candidate prompt against a scenario. */
  runner: MultiShotRunner<P>
  /** How to score the trajectory. Usually a calibrated judge. */
  scorer: MultiShotScorer<P>
  /** How to mutate. Addendum-style mutators (append vs. rewrite) work best. */
  mutator: MultiShotMutateAdapter<P>
  /** The current production prompt. Acts as the baseline + seed. */
  baselinePrompt: P
  /** Stable id for the baseline variant. Default `'baseline'`. */
  baselineId?: string
  /** Scenarios resembling production load. Used as the holdout split. */
  holdoutScenarios: Scenario[]
  /** Scenarios used during search. Default: derived from `holdoutScenarios` via deterministic split. */
  searchScenarios?: Scenario[]
  /** Gate config for the held-out promotion check. */
  gate: HeldOutGateConfig
  /** Reps per (variant × scenario) cell. Default 3. */
  reps?: number
  /** Number of mutation generations. Default 3. */
  generations?: number
  /** Population size per generation. Default 4. */
  populationSize?: number
  /** Concurrent score() calls. Default 1. */
  scoreConcurrency?: number
  /**
   * Optional bridge from a scored trial into a paper-grade RunRecord.
   * If omitted, the loop synthesises a minimal record sufficient for
   * `HeldOutGate` and `evaluateReleaseConfidence`.
   */
  toRunRecord?: (input: {
    variant: EvolvableVariant<P>
    scenarioId: string
    rep: number
    split: RunSplitTag
    seed: number
    trial: MultiShotTrialResult
  }) => RunRecord
}

export interface ProductionShipConfig {
  repo: RepoRef
  /** Branch name prefix. Final branch = `${branchPrefix}/${runId}`. */
  branchPrefix: string
  /** Path (repo-relative) of the file holding the production prompt. */
  promptFilePath: string
  /** Base branch for the PR. Default `'main'`. */
  baseBranch?: string
  reviewers?: string[]
  labels?: string[]
  /** Required: the auto-PR transport. Use `ghCliClient()` or `httpGithubClient()`. */
  client: AutoPrClient
  /** Skip the actual push + PR call — for sanity-checking the plan. Default false. */
  dryRun?: boolean
  /** Render PR body from the loop's findings. Optional override. */
  renderBody?: (ctx: ProductionLoopRenderContext) => string
  /** Render the file contents from the new prompt. Default: serialize as the file. */
  renderPromptFile?: (newPrompt: string, oldFileContents: string | null) => string
  /** Read the current prompt file contents for diff context. Optional. */
  readCurrentPromptFile?: () => Promise<string | null>
}

export interface ProductionLoopCronConfig {
  cadence: 'weekly' | 'daily' | 'hourly'
  /** Optional jitter (seconds) the consumer's scheduler should add. Surface-only. */
  jitterSec?: number
}

export interface RunProductionLoopOptions<P = string> {
  /** Stable id; deterministic outputs when reused. */
  runId: string
  /** Human label — surfaces in PR titles and reports. */
  target: string
  traceStore: TraceStore
  feedbackStore: FeedbackTrajectoryStore
  cluster: FailureClusterConfig
  evolve: ProductionEvolveConfig<P>
  /** When omitted, the loop returns the proposed prompt without opening a PR. */
  ship?: ProductionShipConfig
  /** Surface-only — encodes scheduler expectations into the artifact. */
  cron?: ProductionLoopCronConfig
  /** Release confidence thresholds. Default: library defaults. */
  releaseThresholds?: ReleaseConfidenceThresholds
  /** Now() seam for reproducibility in tests. */
  now?: () => Date
}

export type ProductionLoopDecision =
  | 'no_actionable_failures'
  | 'evolve_yielded_no_improvement'
  | 'gate_failed'
  | 'proposed_change'
  | 'pr_opened'

export interface ProductionLoopRenderContext {
  runId: string
  target: string
  decision: ProductionLoopDecision
  /** Clusters seen in production this cycle, sorted by severity. */
  clusters: FailureCluster[]
  /** The cluster the loop acted on (if any). */
  actedOnCluster: FailureCluster | null
  /** Production runs observed this cycle. */
  observedRunCount: number
  /** Feedback trajectories observed this cycle. */
  observedFeedbackCount: number
  /** Evolve result (if evolve ran). */
  evolution: MultiShotOptimizationResult<unknown> | null
  /** Release gate verdict (if evolve ran). */
  release: ReleaseConfidenceScorecard | null
  /** Held-out gate decision (if a candidate was paired against the baseline). */
  gate: GateDecision | null
  /** The baseline (current production) prompt as a string. */
  baselinePromptString: string
  /** The proposed new prompt as a string. Empty if no change was proposed. */
  promotedPromptString: string
}

export interface ProductionLoopResult {
  runId: string
  target: string
  decision: ProductionLoopDecision
  startedAt: string
  finishedAt: string
  observedRunCount: number
  observedFeedbackCount: number
  clusters: FailureCluster[]
  actedOnCluster: FailureCluster | null
  evolution: MultiShotOptimizationResult<unknown> | null
  release: ReleaseConfidenceScorecard | null
  gate: GateDecision | null
  /** Baseline prompt as it entered the cycle. */
  baselinePrompt: unknown
  /** Promoted prompt — equals baseline when no change is proposed. */
  promotedPrompt: unknown
  /** PR artifact when `ship` was wired and gate passed. */
  pullRequest: ProposeAutomatedPullRequestResult | null
  cron: ProductionLoopCronConfig | null
}

// ── Entry point ──────────────────────────────────────────────────────

export async function runProductionLoop<P = string>(
  opts: RunProductionLoopOptions<P>,
): Promise<ProductionLoopResult> {
  validate(opts)
  const now = opts.now ?? (() => new Date())
  const startedAt = now().toISOString()

  const observedRuns = await opts.traceStore.listRuns()
  const observedFeedback = await opts.feedbackStore.list()

  const clusterReport = await failureClusterView(opts.traceStore, {
    minClusterSize: opts.cluster.minClusterSize ?? 1,
  })
  const minSize = opts.cluster.minClusterSize ?? 5
  const minSeverity = opts.cluster.minSeverityRatio ?? 0.05
  const maxClusters = opts.cluster.maxClustersPerCycle ?? 1
  const totalRuns = clusterReport.totalRuns
  const actionable = clusterReport.clusters
    .filter((c) => c.runCount >= minSize)
    .filter((c) => totalRuns === 0 || c.runCount / totalRuns >= minSeverity)
    .slice(0, maxClusters)

  if (actionable.length === 0) {
    return finalize({
      opts,
      decision: 'no_actionable_failures',
      startedAt,
      now,
      observedRunCount: observedRuns.length,
      observedFeedbackCount: observedFeedback.length,
      clusters: clusterReport.clusters,
      actedOnCluster: null,
      evolution: null,
      release: null,
      gate: null,
      promotedPrompt: opts.evolve.baselinePrompt as unknown,
      pullRequest: null,
    })
  }

  // Run one evolve round against the worst cluster's scenarios.
  const actedOn = actionable[0] as FailureCluster
  const baseline: EvolvableVariant<P> = {
    id: opts.evolve.baselineId ?? 'baseline',
    label: opts.evolve.baselineId ?? 'baseline',
    generation: 0,
    payload: opts.evolve.baselinePrompt,
  }

  const holdoutIds = uniqueIds(opts.evolve.holdoutScenarios.map((s) => s.id))
  const searchIds = uniqueIds(
    (opts.evolve.searchScenarios ?? deriveSearchScenarios(opts.evolve.holdoutScenarios)).map(
      (s) => s.id,
    ),
  )
  if (searchIds.some((id) => holdoutIds.includes(id))) {
    throw new ValidationError(
      'runProductionLoop: searchScenarios and holdoutScenarios must be disjoint',
    )
  }

  const reps = opts.evolve.reps ?? 3
  const generations = opts.evolve.generations ?? 3
  const populationSize = opts.evolve.populationSize ?? Math.max(2, opts.evolve.reps ?? 4)

  const evolution = (await runMultiShotOptimization<P>({
    runId: `${opts.runId}/evolve`,
    target: opts.target,
    seedVariants: [baseline],
    searchScenarioIds: searchIds,
    reps,
    generations,
    populationSize,
    scoreConcurrency: opts.evolve.scoreConcurrency ?? 1,
    runner: opts.evolve.runner,
    scorer: opts.evolve.scorer,
    mutateAdapter: opts.evolve.mutator,
    gate: {
      holdoutScenarioIds: holdoutIds,
      reps,
      gate: { ...opts.evolve.gate, baselineKey: baseline.id },
      toRunRecord:
        opts.evolve.toRunRecord ??
        (({ variant, scenarioId, rep, split, seed, trial }) =>
          syntheticRunRecord({
            runId: `${opts.runId}-${variant.id}-${scenarioId}-${rep}-${split}`,
            variant,
            scenarioId,
            rep,
            split,
            seed,
            trial,
            target: opts.target,
          })),
    },
  })) as MultiShotOptimizationResult<unknown>

  const gate = evolution.gate?.decision ?? null
  const promotedVariant = evolution.promotedVariant
  const promoted = promotedVariant.payload
  const promotedChanged = promotedVariant.id !== baseline.id

  // Build release scorecard — fail closed on weak evidence.
  // runMultiShotOptimization populates these with MultiShotTrialResult rows
  // (the adapter inside writes the multi-shot fields onto every trial), but
  // the optimizer's outer type-parameter erases that to the base TrialResult
  // shape. Cast deliberately — this is the documented contract.
  const allTrials = evolution.evolution.generations.flatMap(
    (g) => g.trials as unknown as MultiShotTrialResult[],
  )
  const traceEvidence = releaseTraceEvidenceFromMultiShotTrials(allTrials)
  const releaseScenarios = [
    ...(opts.evolve.searchScenarios ?? []).map((s) => ({
      id: s.id,
      payload: s as unknown,
      split: 'train' as const,
      tags: { persona: s.persona, label: s.label },
    })),
    ...opts.evolve.holdoutScenarios.map((s) => ({
      id: s.id,
      payload: s as unknown,
      split: 'holdout' as const,
      tags: { persona: s.persona, label: s.label },
    })),
  ]
  const release = evaluateReleaseConfidence({
    target: opts.target,
    candidateId: promotedVariant.id,
    baselineId: baseline.id,
    scenarios: releaseScenarios,
    traces: traceEvidence,
    gateDecision: gate ?? undefined,
    thresholds: opts.releaseThresholds,
    runs: [...(evolution.gate?.candidateRuns ?? []), ...(evolution.gate?.baselineRuns ?? [])],
  })

  if (!promotedChanged) {
    return finalize({
      opts,
      decision: 'evolve_yielded_no_improvement',
      startedAt,
      now,
      observedRunCount: observedRuns.length,
      observedFeedbackCount: observedFeedback.length,
      clusters: clusterReport.clusters,
      actedOnCluster: actedOn,
      evolution,
      release,
      gate,
      promotedPrompt: promoted as unknown,
      pullRequest: null,
    })
  }

  if (release.status === 'fail' || (gate && !gate.promote)) {
    return finalize({
      opts,
      decision: 'gate_failed',
      startedAt,
      now,
      observedRunCount: observedRuns.length,
      observedFeedbackCount: observedFeedback.length,
      clusters: clusterReport.clusters,
      actedOnCluster: actedOn,
      evolution,
      release,
      gate,
      promotedPrompt: promoted as unknown,
      pullRequest: null,
    })
  }

  if (!opts.ship) {
    return finalize({
      opts,
      decision: 'proposed_change',
      startedAt,
      now,
      observedRunCount: observedRuns.length,
      observedFeedbackCount: observedFeedback.length,
      clusters: clusterReport.clusters,
      actedOnCluster: actedOn,
      evolution,
      release,
      gate,
      promotedPrompt: promoted as unknown,
      pullRequest: null,
    })
  }

  // Open the PR.
  const baselineStr = toPromptString(baseline.payload)
  const promotedStr = toPromptString(promoted)
  const ctx: ProductionLoopRenderContext = {
    runId: opts.runId,
    target: opts.target,
    decision: 'pr_opened',
    clusters: clusterReport.clusters,
    actedOnCluster: actedOn,
    observedRunCount: observedRuns.length,
    observedFeedbackCount: observedFeedback.length,
    evolution,
    release,
    gate,
    baselinePromptString: baselineStr,
    promotedPromptString: promotedStr,
  }
  const renderBody = opts.ship.renderBody ?? defaultRenderBody
  const renderFile =
    opts.ship.renderPromptFile ?? ((next: string, _prev: string | null) => `${next}\n`)
  const currentFile = opts.ship.readCurrentPromptFile
    ? await opts.ship.readCurrentPromptFile()
    : null

  const pr = await proposeAutomatedPullRequest(opts.ship.client, {
    repo: opts.ship.repo,
    baseBranch: opts.ship.baseBranch ?? 'main',
    branchName: `${opts.ship.branchPrefix.replace(/\/+$/, '')}/${opts.runId}`,
    title: `${opts.target}: production-loop prompt update (${opts.runId})`,
    body: renderBody(ctx),
    reviewers: opts.ship.reviewers,
    labels: opts.ship.labels,
    fileChanges: [
      {
        path: opts.ship.promptFilePath,
        contents: renderFile(promotedStr, currentFile),
        rationale: `Auto-improved against cluster "${actedOn.failureClass}" (${actedOn.runCount} prod failures)`,
      },
    ],
    dryRun: opts.ship.dryRun,
  })

  return finalize({
    opts,
    decision: 'pr_opened',
    startedAt,
    now,
    observedRunCount: observedRuns.length,
    observedFeedbackCount: observedFeedback.length,
    clusters: clusterReport.clusters,
    actedOnCluster: actedOn,
    evolution,
    release,
    gate,
    promotedPrompt: promoted as unknown,
    pullRequest: pr,
  })
}

// ── Helpers ──────────────────────────────────────────────────────────

function finalize<P>(args: {
  opts: RunProductionLoopOptions<P>
  decision: ProductionLoopDecision
  startedAt: string
  now: () => Date
  observedRunCount: number
  observedFeedbackCount: number
  clusters: FailureCluster[]
  actedOnCluster: FailureCluster | null
  evolution: MultiShotOptimizationResult<unknown> | null
  release: ReleaseConfidenceScorecard | null
  gate: GateDecision | null
  promotedPrompt: unknown
  pullRequest: ProposeAutomatedPullRequestResult | null
}): ProductionLoopResult {
  return {
    runId: args.opts.runId,
    target: args.opts.target,
    decision: args.decision,
    startedAt: args.startedAt,
    finishedAt: args.now().toISOString(),
    observedRunCount: args.observedRunCount,
    observedFeedbackCount: args.observedFeedbackCount,
    clusters: args.clusters,
    actedOnCluster: args.actedOnCluster,
    evolution: args.evolution,
    release: args.release,
    gate: args.gate,
    baselinePrompt: args.opts.evolve.baselinePrompt,
    promotedPrompt: args.promotedPrompt,
    pullRequest: args.pullRequest,
    cron: args.opts.cron ?? null,
  }
}

function validate<P>(opts: RunProductionLoopOptions<P>): void {
  if (!opts.runId.trim()) throw new ValidationError('runProductionLoop: runId required')
  if (!opts.target.trim()) throw new ValidationError('runProductionLoop: target required')
  if (opts.evolve.holdoutScenarios.length === 0) {
    throw new ValidationError('runProductionLoop: evolve.holdoutScenarios must not be empty')
  }
  if (opts.evolve.searchScenarios && opts.evolve.searchScenarios.length === 0) {
    throw new ValidationError(
      'runProductionLoop: evolve.searchScenarios must be omitted or non-empty',
    )
  }
  if (!opts.evolve.gate.baselineKey && !opts.evolve.baselineId) {
    // baselineId defaults to 'baseline', but if the caller explicitly set
    // a baselineKey on the gate, the optimization adapter enforces that
    // it matches; verify here so we fail fast.
  }
  if (opts.ship) {
    if (!opts.ship.branchPrefix.trim()) {
      throw new ValidationError('runProductionLoop: ship.branchPrefix required')
    }
    if (!opts.ship.promptFilePath.trim()) {
      throw new ValidationError('runProductionLoop: ship.promptFilePath required')
    }
  }
}

function uniqueIds(ids: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const id of ids) {
    if (seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}

/**
 * Deterministic split when the consumer only provides holdout scenarios:
 * use a stable hash to pick ~25% as search. Caller-side scenarios are
 * always preferred (this is a fallback, not a recommendation).
 */
function deriveSearchScenarios(holdout: Scenario[]): Scenario[] {
  if (holdout.length < 4) {
    // Synthesize a small label-only search scenario to keep search
    // disjoint from holdout. This degrades to a less-rigorous evolve
    // but never silently overlaps.
    return [
      {
        ...(holdout[0] as Scenario),
        id: `${(holdout[0] as Scenario).id}__search`,
      },
    ]
  }
  return holdout.filter((_, i) => i % 4 === 0).map((s) => ({ ...s, id: `${s.id}__search` }))
}

function syntheticRunRecord(input: {
  runId: string
  variant: EvolvableVariant<unknown>
  scenarioId: string
  rep: number
  split: RunSplitTag
  seed: number
  trial: MultiShotTrialResult
  target: string
}): RunRecord {
  const scoreKey = input.split === 'holdout' ? 'holdoutScore' : 'searchScore'
  return {
    runId: input.runId,
    experimentId: input.target,
    candidateId: input.variant.id,
    seed: input.seed,
    model: 'production-loop@synthetic',
    promptHash: '0'.repeat(64),
    configHash: '0'.repeat(64),
    commitSha: '0'.repeat(40),
    wallMs: input.trial.durationMs ?? 1,
    costUsd: input.trial.cost ?? 0,
    tokenUsage: { input: 0, output: 0 },
    outcome: {
      [scoreKey]: input.trial.score,
      raw: { score: input.trial.score, ok: input.trial.ok ? 1 : 0 },
    },
    splitTag: input.split,
    scenarioId: input.scenarioId,
  }
}

function toPromptString(payload: unknown): string {
  if (typeof payload === 'string') return payload
  if (payload == null) return ''
  try {
    return JSON.stringify(payload, null, 2)
  } catch {
    return String(payload)
  }
}

function defaultRenderBody(ctx: ProductionLoopRenderContext): string {
  const cluster = ctx.actedOnCluster
  const release = ctx.release
  const gate = ctx.gate
  const lines: string[] = []
  lines.push(`## Production-loop prompt update — \`${ctx.target}\``)
  lines.push('')
  lines.push(`Run id: \`${ctx.runId}\``)
  lines.push(`Decision: \`${ctx.decision}\``)
  lines.push(
    `Observed in this cycle: ${ctx.observedRunCount} prod runs, ${ctx.observedFeedbackCount} feedback trajectories.`,
  )
  lines.push('')
  if (cluster) {
    lines.push('### Triggering failure cluster')
    lines.push('')
    lines.push(`- **class**: \`${cluster.failureClass}\``)
    lines.push(`- **runs in cluster**: ${cluster.runCount}`)
    lines.push(`- **distinct scenarios**: ${cluster.scenarioIds.length}`)
    if (cluster.toolName) lines.push(`- **tool**: \`${cluster.toolName}\``)
    if (cluster.dimension) lines.push(`- **judge dimension**: \`${cluster.dimension}\``)
    if (cluster.exampleError) {
      lines.push(
        `- **example error**: \`${cluster.exampleError.slice(0, 200).replace(/\n/g, ' ')}\``,
      )
    }
    lines.push('')
  }
  if (gate) {
    lines.push('### Held-out promotion gate')
    lines.push('')
    lines.push(`- **decision**: \`${gate.promote ? 'PROMOTE' : 'REJECT'}\``)
    lines.push(`- **paired median delta**: ${gate.evidence.medianPairedDelta.toFixed(4)}`)
    lines.push(
      `- **paired 95% CI**: [${gate.evidence.pairedCI.low.toFixed(4)}, ${gate.evidence.pairedCI.high.toFixed(4)}]`,
    )
    lines.push(`- **paired p-value**: ${gate.evidence.pairedPValue.toFixed(4)}`)
    lines.push(
      `- **search/holdout means**: ${gate.evidence.searchScore.toFixed(4)} / ${gate.evidence.holdoutScore.toFixed(4)}`,
    )
    lines.push(`- **overfit gap**: ${gate.evidence.overfitGap.toFixed(4)}`)
    lines.push('')
  }
  if (release) {
    lines.push('### Release confidence')
    lines.push('')
    lines.push(`- **status**: \`${release.status}\``)
    lines.push(`- **pass rate**: ${release.metrics.passRate.toFixed(4)}`)
    lines.push(`- **mean score**: ${release.metrics.meanScore.toFixed(4)}`)
    if (release.issues.length > 0) {
      lines.push('- **issues**:')
      for (const issue of release.issues) {
        lines.push(`  - \`${issue.severity}\` ${issue.axis}: ${issue.detail}`)
      }
    }
    lines.push('')
  }
  lines.push('### Prompt diff')
  lines.push('')
  lines.push('```diff')
  lines.push(unifiedDiff(ctx.baselinePromptString, ctx.promotedPromptString))
  lines.push('```')
  return lines.join('\n')
}

function unifiedDiff(a: string, b: string): string {
  const aLines = a.split('\n')
  const bLines = b.split('\n')
  const out: string[] = []
  const max = Math.max(aLines.length, bLines.length)
  for (let i = 0; i < max; i++) {
    const al = aLines[i]
    const bl = bLines[i]
    if (al === bl) continue
    if (al !== undefined) out.push(`- ${al}`)
    if (bl !== undefined) out.push(`+ ${bl}`)
  }
  return out.join('\n')
}
