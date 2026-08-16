// Multishot matrix wrapper — sweeps profiles × personas × reps, runs
// the driver-agent loop per cell, applies up to three configured judges,
// persists per-cell artifacts, and aggregates by axis.
//
// Uses runAgentMatrix from @tangle-network/agent-eval/matrix under the
// hood so cell scheduling + concurrency + cost ceiling are unified with
// other matrix consumers.

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentProfile } from '@tangle-network/agent-interface'
import type { CostProvenance } from '../cost-ledger'
import type { MatrixResult } from '../matrix'
import { runAgentMatrix, withCellSpend } from '../matrix'
import { type JudgeConfig, type JudgeScore, runJudge } from './judges'
import { type MultishotShot, runMultishot } from './multishot'
import {
  assertMultishotShotResult,
  type MultishotArtifact,
  type MultishotMessage,
  type MultishotPersona,
  type MultishotShape,
  type MultishotToolDefinition,
  type MultishotToolExecutor,
  type MultishotTransport,
} from './types'

export interface ConversationJudgeInput<TPersona extends MultishotPersona> {
  transcript: MultishotMessage[]
  persona: TPersona
}

export interface ArtifactJudgeInput<TPersona extends MultishotPersona> {
  artifact: MultishotArtifact
  persona: TPersona
}

export interface MultishotJudges<TPersona extends MultishotPersona> {
  /** Scores the full transcript end-to-end (always runs). */
  conversation: JudgeConfig<ConversationJudgeInput<TPersona>>
  /** Scores each code-type artifact. Optional — omit when domain has no code artifacts. */
  codeReview?: JudgeConfig<ArtifactJudgeInput<TPersona>>
  /** Scores each non-code (research/content/template) artifact. Optional. */
  contentQuality?: JudgeConfig<ArtifactJudgeInput<TPersona>>
  /** Which artifact types route to codeReview. Defaults to ['code']. */
  codeArtifactTypes?: string[]
  /** Which artifact types route to contentQuality. Defaults to ['research']. */
  contentArtifactTypes?: string[]
}

export interface CellCompositeScore {
  composite: number
  conversation: JudgeScore
  codeReview?: {
    perArtifact: Array<JudgeScore & { turn: number; type: string }>
    composite: number
  }
  contentQuality?: {
    perArtifact: Array<JudgeScore & { turn: number; type: string }>
    composite: number
  }
}

export interface RunMultishotMatrixOptions<TPersona extends MultishotPersona> {
  /** AgentProfile axis (matrix primary). */
  profiles: Array<{ id: string; value: AgentProfile }>
  /** Persona axis. */
  personas: TPersona[]
  /** Persona-shaping callbacks. Optional — omitted callbacks are derived per
   *  cell from that cell's profile + persona payload (pure-profile path). */
  shape?: MultishotShape<TPersona>
  /** Judge configurations. */
  judges: MultishotJudges<TPersona>
  /** Tool definitions advertised to the agent. Defaults to delegate_research + delegate_code. */
  tools?: MultishotToolDefinition[]
  /** Map from tool name → inline executor. Must align with `tools`. */
  toolExecutors?: Record<string, MultishotToolExecutor>
  /** Tool name → artifact type label. Defaults to research/code mapping. */
  artifactTypeFor?: (toolName: string) => string | undefined
  /** Where per-cell artifacts land. Cells write to `<runDir>/<profileId>/<personaId>/rep-N/`. */
  runDir: string
  /** Replicates per (profile, persona) cell. */
  reps?: number
  /** Max conversation turns per cell. */
  maxTurns?: number
  /** Maximum tool calls the agent may dispatch inside one assistant turn. */
  maxToolDispatches?: number
  /** Max concurrent cells. */
  maxConcurrency?: number
  /** Total $ ceiling across the matrix; cells aborted past this. */
  costCeiling?: number
  /** Upper bound on what one cell can spend. A cell whose cost is a subtotal
   *  is charged this bound against `costCeiling` instead of its known amount,
   *  so hidden spend cannot walk the run past its budget. */
  maxCellCostUsd?: number
  /** Agent model. */
  agentModel?: string
  /** Driver model. */
  driverModel?: string
  /** Fallback driver models tried when the primary simulated-user model returns empty twice. */
  driverFallbackModels?: string[]
  /** Maximum output tokens for the first agent call in each assistant turn. */
  agentMaxTokens?: number
  /** Maximum output tokens for agent follow-up calls after tool results. */
  toolFollowupMaxTokens?: number
  /** Maximum output tokens for each simulated-user driver response. */
  driverMaxTokens?: number
  /** Maximum output tokens for each judge response. */
  judgeMaxTokens?: number
  /** Execution seam for the agent leg of every cell — replaces the router
   *  HTTP call when provided (see RunMultishotOptions.agentTransport).
   *  Judges are unaffected; configure those via MultishotJudges. */
  agentTransport?: MultishotTransport
  /** Execution seam for the simulated-user driver leg of every cell. */
  driverTransport?: MultishotTransport
  /** Conversation engine for every cell. Defaults to `runMultishot`.
   *
   *  The matrix owns everything around the shot — cell fan-out, concurrency,
   *  the cost ceiling, the judge slots, the cell composite, the per-cell
   *  artifact writers and the run summary — and forwards the whole cell input
   *  to this function, so an alternative engine replaces ONLY the
   *  conversation. Every option on this interface that `runMultishot` accepts
   *  reaches the shot unchanged. `RunMultishotOptions.signal` has no
   *  matrix-level counterpart and is not forwarded; a shot owns its own
   *  cancellation.
   *
   *  A shot that resolves with a value outside `MultishotResult` throws
   *  `MultishotShotResultError` for that cell. The default engine is never
   *  used as a fallback. */
  runShot?: MultishotShot<TPersona>
  /** Pass-thru fields. */
  apiKey?: string
  baseUrl?: string
}

/** Per-cell output the multishot matrix records in `MatrixResult.cells`.
 *  A consumer that supplies its own `runShot` reads the matrix through this
 *  type instead of declaring a structural copy. */
export interface MultishotCellOutput {
  turns: number
  toolCalls: number
  artifactCount: number
}

interface ArtifactJudgeRun {
  score: JudgeScore & { turn: number; type: string }
  cost: CostProvenance
}

/** Mean composite over non-failed scores. `0` when the list is empty (a
 *  configured judge with nothing to score contributes 0, matching the cell
 *  composite's long-standing semantics); `null` when scores exist but every
 *  one failed — no signal, so the slot must be EXCLUDED from the cell mean
 *  rather than dragging it to zero. */
function meanCompositeExcludingFailed(scores: ReadonlyArray<JudgeScore>): number | null {
  if (scores.length === 0) return 0
  const live = scores.filter((s) => !s.failed)
  if (live.length === 0) return null
  return live.reduce((sum, s) => sum + s.composite, 0) / live.length
}

export interface CellCompositeInput {
  conversation: JudgeScore
  /** Present iff the codeReview judge is configured. */
  codeReviews?: ReadonlyArray<JudgeScore>
  /** Present iff the contentQuality judge is configured. */
  contentReviews?: ReadonlyArray<JudgeScore>
}

/** Cell composite = mean over configured judge slots, excluding failed
 *  scores: a failed conversation judge or an all-failed artifact slot carries
 *  no signal and is dropped from the mean. `composite` is 0 only when EVERY
 *  configured slot failed (`allJudgesFailed` distinguishes that from a real
 *  zero). Pure — exported for deterministic testing. */
export function computeCellComposite(input: CellCompositeInput): {
  composite: number
  codeComposite: number
  contentComposite: number
  allJudgesFailed: boolean
} {
  const contributions: number[] = []
  if (!input.conversation.failed) contributions.push(input.conversation.composite)

  const codeMean = input.codeReviews ? meanCompositeExcludingFailed(input.codeReviews) : undefined
  if (typeof codeMean === 'number') contributions.push(codeMean)
  const contentMean = input.contentReviews
    ? meanCompositeExcludingFailed(input.contentReviews)
    : undefined
  if (typeof contentMean === 'number') contributions.push(contentMean)

  return {
    composite:
      contributions.length === 0
        ? 0
        : contributions.reduce((s, v) => s + v, 0) / contributions.length,
    codeComposite: codeMean ?? 0,
    contentComposite: contentMean ?? 0,
    allJudgesFailed: contributions.length === 0,
  }
}

export interface RunMultishotMatrixResult {
  matrix: MatrixResult<MultishotCellOutput>
}

export async function runMultishotMatrix<TPersona extends MultishotPersona>(
  opts: RunMultishotMatrixOptions<TPersona>,
): Promise<RunMultishotMatrixResult> {
  const codeTypes = new Set(opts.judges.codeArtifactTypes ?? ['code'])
  const contentTypes = new Set(opts.judges.contentArtifactTypes ?? ['research'])
  const runShot: MultishotShot<TPersona> = opts.runShot ?? runMultishot
  mkdirSync(opts.runDir, { recursive: true })

  const matrix = await runAgentMatrix<MultishotCellOutput>({
    axes: [
      { name: 'profile', values: opts.profiles },
      { name: 'persona', values: opts.personas.map((p) => ({ id: p.id, value: p })) },
    ],
    reps: opts.reps ?? 1,
    maxConcurrency: opts.maxConcurrency ?? 2,
    costCeiling: opts.costCeiling,
    maxCellCostUsd: opts.maxCellCostUsd,
    async runCell(cell) {
      const cellStartedAt = Date.now()
      const profile = cell.axes.profile?.value as AgentProfile
      const persona = cell.axes.persona?.value as TPersona
      const profileId = String(cell.axes.profile?.id ?? 'unknown')
      const personaId = String(cell.axes.persona?.id ?? 'unknown')

      // A shot that throws declares its own spend (see `runMultishot`). Rethrow
      // it untouched: a shot that declared nothing spent an unknown amount, and
      // claiming a number here would report a fabricated total.
      const sim = await runShot({
        profile,
        persona,
        shape: opts.shape,
        tools: opts.tools,
        toolExecutors: opts.toolExecutors,
        artifactTypeFor: opts.artifactTypeFor,
        maxTurns: opts.maxTurns,
        maxToolDispatches: opts.maxToolDispatches,
        agentModel: opts.agentModel,
        driverModel: opts.driverModel,
        driverFallbackModels: opts.driverFallbackModels,
        agentMaxTokens: opts.agentMaxTokens,
        toolFollowupMaxTokens: opts.toolFollowupMaxTokens,
        driverMaxTokens: opts.driverMaxTokens,
        agentTransport: opts.agentTransport,
        driverTransport: opts.driverTransport,
        apiKey: opts.apiKey,
        baseUrl: opts.baseUrl,
      })
      // Everything from here on runs with the shot's spend already committed.
      // A throw past this line must carry it, or the money leaves the matrix's
      // cumulative sum and the cost ceiling under-counts the run.
      const shotCostUsd = shotCostSubtotal(sim)
      // A shot that says nothing about provenance is taken at its word, which
      // is how every engine written before the field behaved.
      const shotCostComplete = sim?.costProvenance?.kind !== 'uncaptured'
      let judgeCostUsd = 0
      let judgeCostComplete = false
      // Where the cell is, so a throw declares the right completeness: before
      // the judges only the shot has spent, while they are in flight their
      // spend is unknown, and after they settle their receipts decide.
      let phase: 'validate' | 'judging' | 'scoring' = 'validate'
      try {
        assertMultishotShotResult(sim)

        const codeArtifacts = sim.artifacts.filter((a) => codeTypes.has(a.type))
        const contentArtifacts = sim.artifacts.filter((a) => contentTypes.has(a.type))

        phase = 'judging'
        const [conversationRun, codeReviewRuns, contentReviewRuns] = await Promise.all([
          runJudge(withJudgeMaxTokens(opts.judges.conversation, opts.judgeMaxTokens), {
            transcript: sim.transcript,
            persona,
          }),
          opts.judges.codeReview
            ? Promise.all(
                codeArtifacts.map((artifact) =>
                  runJudge(withJudgeMaxTokens(opts.judges.codeReview!, opts.judgeMaxTokens), {
                    artifact,
                    persona,
                  }).then((result) => ({
                    score: {
                      ...result.score,
                      turn: artifact.turn,
                      type: artifact.type,
                    },
                    cost: result.cost,
                  })),
                ),
              )
            : Promise.resolve([] as ArtifactJudgeRun[]),
          opts.judges.contentQuality
            ? Promise.all(
                contentArtifacts.map((artifact) =>
                  runJudge(withJudgeMaxTokens(opts.judges.contentQuality!, opts.judgeMaxTokens), {
                    artifact,
                    persona,
                  }).then((result) => ({
                    score: {
                      ...result.score,
                      turn: artifact.turn,
                      type: artifact.type,
                    },
                    cost: result.cost,
                  })),
                ),
              )
            : Promise.resolve([] as ArtifactJudgeRun[]),
        ])
        const judgeRuns = [conversationRun, ...codeReviewRuns, ...contentReviewRuns]
        judgeCostUsd = judgeRuns.reduce((sum, run) => sum + (run.cost.usd ?? 0), 0)
        judgeCostComplete = judgeRuns.every((run) => run.cost.kind !== 'uncaptured')
        phase = 'scoring'

        const conversation = conversationRun.score
        const codeReviews = codeReviewRuns.map((run) => run.score)
        const contentReviews = contentReviewRuns.map((run) => run.score)

        const { composite, codeComposite, contentComposite, allJudgesFailed } =
          computeCellComposite({
            conversation,
            codeReviews: opts.judges.codeReview ? codeReviews : undefined,
            contentReviews: opts.judges.contentQuality ? contentReviews : undefined,
          })

        const cellScore: CellCompositeScore = { composite, conversation }
        if (opts.judges.codeReview)
          cellScore.codeReview = { perArtifact: codeReviews, composite: codeComposite }
        if (opts.judges.contentQuality)
          cellScore.contentQuality = { perArtifact: contentReviews, composite: contentComposite }

        const cellDir = join(opts.runDir, profileId, personaId, `rep-${cell.rep}`)
        mkdirSync(cellDir, { recursive: true })
        writeFileSync(join(cellDir, 'transcript.json'), JSON.stringify(sim.transcript, null, 2))
        writeFileSync(join(cellDir, 'artifacts.json'), JSON.stringify(sim.artifacts, null, 2))
        writeFileSync(join(cellDir, 'scores.json'), JSON.stringify(cellScore, null, 2))

        const notes = [`convo=${conversation.composite.toFixed(1)}`]
        if (opts.judges.codeReview) notes.push(`code=${codeComposite.toFixed(1)}`)
        if (opts.judges.contentQuality) notes.push(`content=${contentComposite.toFixed(1)}`)
        if (allJudgesFailed) notes.push('all-judges-failed')
        if (!judgeCostComplete) notes.push('judge-cost-incomplete')

        return {
          output: {
            turns: sim.transcript.length,
            toolCalls: sim.toolCalls,
            artifactCount: sim.artifacts.length,
          },
          verdict: { valid: composite >= 5, score: composite, notes: notes.join(' ') },
          costUsd: sim.costUsd + judgeCostUsd,
          // Either leg can leave the cell total a subtotal: a judge whose cost
          // the router never reported, or a shot that declared its own spend
          // uncaptured. The matrix counts the known part toward the ceiling and
          // reports the cell as under-counted rather than presenting the sum as
          // complete.
          costProvenance:
            judgeCostComplete && shotCostComplete
              ? { kind: 'estimated', usd: sim.costUsd + judgeCostUsd }
              : { kind: 'uncaptured', usd: null },
          durationMs: sim.durationMs,
        }
      } catch (err) {
        // No usable shot subtotal means the cell's spend is genuinely unknown;
        // rethrow untouched so the matrix records it as uncaptured instead of
        // billing a number this frame cannot support.
        if (shotCostUsd === undefined) throw err
        throw withCellSpend(err, {
          costUsd: shotCostUsd + judgeCostUsd,
          durationMs: Date.now() - cellStartedAt,
          // The judges bill before they settle, so a throw among them leaves a
          // subtotal. Before they start, and after they settle with every
          // receipt captured, the amount is the cell's whole spend — unless the
          // shot already declared its own part incomplete.
          kind:
            shotCostComplete && (phase === 'validate' || (phase === 'scoring' && judgeCostComplete))
              ? 'estimated'
              : 'uncaptured',
        })
      }
    },
  })

  // Persist top-level summary.
  const summary = {
    cells: matrix.summary.totalCells,
    passRate: matrix.summary.overallPassRate,
    meanScore: matrix.summary.overallMeanScore,
    totalCostUsd: matrix.summary.totalCostUsd,
    costUncapturedCells: matrix.summary.costUncapturedCells,
    ceilingChargedUsd: matrix.summary.ceilingChargedUsd,
    durationMs: matrix.summary.durationMs,
    runsExecuted: matrix.summary.runsExecuted,
    cellsSkipped: matrix.summary.cellsSkipped,
    byProfile: matrix.byAxis.profile,
    byPersona: matrix.byAxis.persona,
  }
  writeFileSync(join(opts.runDir, 'summary.json'), JSON.stringify(summary, null, 2))

  // A reader of the on-disk summary must not take the cost line as the run's
  // whole spend when some cells reported only a subtotal.
  const uncaptured = matrix.summary.costUncapturedCells
  const costLabel = uncaptured > 0 ? 'Cost (at least)' : 'Cost'

  const md: string[] = [
    `# Multishot matrix`,
    ``,
    `**Cells**: ${matrix.summary.totalCells} | **Pass rate**: ${(matrix.summary.overallPassRate * 100).toFixed(0)}% | **Mean**: ${matrix.summary.overallMeanScore.toFixed(2)} | **${costLabel}**: $${matrix.summary.totalCostUsd.toFixed(2)} | **Duration**: ${(matrix.summary.durationMs / 1000).toFixed(0)}s`,
    ``,
    ...(uncaptured > 0
      ? [
          `> ${uncaptured} of ${matrix.summary.runsExecuted} cells reported a cost subtotal, not a total. Real spend is higher than every cost figure below.`,
          ``,
        ]
      : []),
    `## By profile`,
    ``,
    '| profile | pass | mean | cost |',
    '|---|---|---|---|',
    ...Object.entries(matrix.byAxis.profile ?? {}).map(
      ([id, s]) =>
        `| ${id} | ${(s.passRate * 100).toFixed(0)}% | ${s.meanScore.toFixed(2)} | $${s.totalCostUsd.toFixed(2)} |`,
    ),
    ``,
    `## By persona`,
    ``,
    '| persona | pass | mean | cost |',
    '|---|---|---|---|',
    ...Object.entries(matrix.byAxis.persona ?? {}).map(
      ([id, s]) =>
        `| ${id} | ${(s.passRate * 100).toFixed(0)}% | ${s.meanScore.toFixed(2)} | $${s.totalCostUsd.toFixed(2)} |`,
    ),
    ``,
  ]
  writeFileSync(join(opts.runDir, 'summary.md'), md.join('\n'))

  return { matrix }
}

/** The shot's own spend, when the value it resolved with reports a usable
 *  amount. `undefined` when it does not — a malformed shot result is exactly
 *  the case where the number cannot be trusted, and billing a wrong figure is
 *  worse than recording the cell as uncaptured. */
function shotCostSubtotal(
  sim: { costUsd?: unknown; costProvenance?: CostProvenance } | null | undefined,
): number | undefined {
  const value = sim?.costUsd
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function withJudgeMaxTokens<TInput>(
  judge: JudgeConfig<TInput>,
  maxTokens: number | undefined,
): JudgeConfig<TInput> {
  if (maxTokens === undefined || judge.maxTokens !== undefined) return judge
  return { ...judge, maxTokens }
}
