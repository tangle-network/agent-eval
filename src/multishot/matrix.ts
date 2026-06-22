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
import type { MatrixResult } from '../matrix'
import { runAgentMatrix } from '../matrix'
import { type JudgeConfig, type JudgeScore, runJudge } from './judges'
import { runMultishot } from './multishot'
import type {
  MultishotArtifact,
  MultishotMessage,
  MultishotPersona,
  MultishotShape,
  MultishotToolDefinition,
  MultishotToolExecutor,
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
  /** Persona-shaping callbacks. */
  shape: MultishotShape<TPersona>
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
  /** Agent model. */
  agentModel?: string
  /** Driver model. */
  driverModel?: string
  /** Pass-thru fields. */
  apiKey?: string
  baseUrl?: string
}

interface CellOutput {
  turns: number
  toolCalls: number
  artifactCount: number
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
  matrix: MatrixResult<CellOutput>
}

export async function runMultishotMatrix<TPersona extends MultishotPersona>(
  opts: RunMultishotMatrixOptions<TPersona>,
): Promise<RunMultishotMatrixResult> {
  const codeTypes = new Set(opts.judges.codeArtifactTypes ?? ['code'])
  const contentTypes = new Set(opts.judges.contentArtifactTypes ?? ['research'])
  mkdirSync(opts.runDir, { recursive: true })

  const matrix = await runAgentMatrix<CellOutput>({
    axes: [
      { name: 'profile', values: opts.profiles },
      { name: 'persona', values: opts.personas.map((p) => ({ id: p.id, value: p })) },
    ],
    reps: opts.reps ?? 1,
    maxConcurrency: opts.maxConcurrency ?? 2,
    costCeiling: opts.costCeiling,
    async runCell(cell) {
      const profile = cell.axes.profile?.value as AgentProfile
      const persona = cell.axes.persona?.value as TPersona
      const profileId = String(cell.axes.profile?.id ?? 'unknown')
      const personaId = String(cell.axes.persona?.id ?? 'unknown')

      const sim = await runMultishot({
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
        apiKey: opts.apiKey,
        baseUrl: opts.baseUrl,
      })

      const codeArtifacts = sim.artifacts.filter((a) => codeTypes.has(a.type))
      const contentArtifacts = sim.artifacts.filter((a) => contentTypes.has(a.type))

      const [conversation, codeReviews, contentReviews] = await Promise.all([
        runJudge(opts.judges.conversation, { transcript: sim.transcript, persona }),
        opts.judges.codeReview
          ? Promise.all(
              codeArtifacts.map((artifact) =>
                runJudge(opts.judges.codeReview!, { artifact, persona }).then((s) => ({
                  ...s,
                  turn: artifact.turn,
                  type: artifact.type,
                })),
              ),
            )
          : Promise.resolve([] as Array<JudgeScore & { turn: number; type: string }>),
        opts.judges.contentQuality
          ? Promise.all(
              contentArtifacts.map((artifact) =>
                runJudge(opts.judges.contentQuality!, { artifact, persona }).then((s) => ({
                  ...s,
                  turn: artifact.turn,
                  type: artifact.type,
                })),
              ),
            )
          : Promise.resolve([] as Array<JudgeScore & { turn: number; type: string }>),
      ])

      const { composite, codeComposite, contentComposite, allJudgesFailed } = computeCellComposite({
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

      return {
        output: {
          turns: sim.transcript.length,
          toolCalls: sim.toolCalls,
          artifactCount: sim.artifacts.length,
        },
        verdict: { valid: composite >= 5, score: composite, notes: notes.join(' ') },
        costUsd: sim.costUsd,
        durationMs: sim.durationMs,
      }
    },
  })

  // Persist top-level summary.
  const summary = {
    cells: matrix.summary.totalCells,
    passRate: matrix.summary.overallPassRate,
    meanScore: matrix.summary.overallMeanScore,
    totalCostUsd: matrix.summary.totalCostUsd,
    durationMs: matrix.summary.durationMs,
    runsExecuted: matrix.summary.runsExecuted,
    cellsSkipped: matrix.summary.cellsSkipped,
    byProfile: matrix.byAxis.profile,
    byPersona: matrix.byAxis.persona,
  }
  writeFileSync(join(opts.runDir, 'summary.json'), JSON.stringify(summary, null, 2))

  const md: string[] = [
    `# Multishot matrix`,
    ``,
    `**Cells**: ${matrix.summary.totalCells} | **Pass rate**: ${(matrix.summary.overallPassRate * 100).toFixed(0)}% | **Mean**: ${matrix.summary.overallMeanScore.toFixed(2)} | **Cost**: $${matrix.summary.totalCostUsd.toFixed(2)} | **Duration**: ${(matrix.summary.durationMs / 1000).toFixed(0)}s`,
    ``,
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
