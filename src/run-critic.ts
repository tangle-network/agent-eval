import type { Artifact, BudgetLedgerEntry, Run, Span, TraceEvent, TraceStore } from './trace'
import { aggregateRunScore, clamp01, type RunScore, type RunScoreWeights } from './run-score'

export interface RunTrace {
  run: Run
  spans: Span[]
  events: TraceEvent[]
  artifacts: Artifact[]
  budget: BudgetLedgerEntry[]
}

export interface RunCriticOptions {
  weights?: Partial<RunScoreWeights>
  driftPatterns?: RegExp[]
}

const DEFAULT_DRIFT_PATTERNS = [
  /https?:\/\//i,
  /\btitle:\s/i,
  /\bsummary:\s/i,
  /\burl:\s/i,
  /\bnpm package usage\b/i,
  /\bnews\b/i,
]

export class RunCritic {
  private readonly weights?: Partial<RunScoreWeights>
  private readonly driftPatterns: RegExp[]

  constructor(options: RunCriticOptions = {}) {
    this.weights = options.weights
    this.driftPatterns = options.driftPatterns ?? DEFAULT_DRIFT_PATTERNS
  }

  async score(store: TraceStore, runId: string): Promise<RunScore> {
    const run = await store.getRun(runId)
    if (!run) throw new Error(`run ${runId} not found`)
    const [spans, events, artifacts, budget] = await Promise.all([
      store.spans({ runId }),
      store.events({ runId }),
      store.artifacts(runId),
      store.budget(runId),
    ])
    return this.scoreTrace({ run, spans, events, artifacts, budget })
  }

  scoreTrace(trace: RunTrace): RunScore {
    const notes: string[] = []
    const llmSpans = trace.spans.filter((s): s is Extract<Span, { kind: 'llm' }> => s.kind === 'llm')
    const toolSpans = trace.spans.filter((s): s is Extract<Span, { kind: 'tool' }> => s.kind === 'tool')
    const judgeSpans = trace.spans.filter((s): s is Extract<Span, { kind: 'judge' }> => s.kind === 'judge')
    const sandboxSpans = trace.spans.filter((s): s is Extract<Span, { kind: 'sandbox' }> => s.kind === 'sandbox')
    const finalGateSpans = judgeSpans.filter((span) =>
      span.dimension === 'final_gate' || span.attributes?.finalGate === true,
    )

    const success = trace.run.outcome?.pass === true ? 1 : trace.run.status === 'completed' ? 0.5 : 0
    if (!success) notes.push('run did not complete with pass=true')

    const judgeAverage = judgeSpans.length
      ? judgeSpans.reduce((sum, span) => sum + normalizeJudgeScore(span.score), 0) / judgeSpans.length
      : undefined
    const outcomeScore = typeof trace.run.outcome?.score === 'number'
      ? clamp01(trace.run.outcome.score > 1 ? trace.run.outcome.score / 100 : trace.run.outcome.score)
      : undefined
    const goalProgress = outcomeScore ?? judgeAverage ?? success

    const successfulTools = toolSpans.filter((span) => span.status !== 'error').length
    const toolUseQuality = toolSpans.length === 0 ? 0 : successfulTools / toolSpans.length
    if (toolSpans.length === 0) notes.push('no tool spans recorded')

    const patchEvidence = trace.artifacts.length + toolSpans.filter((span) => /write|edit|patch|apply/i.test(span.toolName)).length
    const patchQuality = patchEvidence > 0 ? clamp01(patchEvidence / 4) : 0
    if (!patchQuality) notes.push('no artifact or edit evidence recorded')

    const sandboxTests = sandboxSpans.filter((span) => typeof span.testsTotal === 'number' && span.testsTotal > 0)
    const testReality = sandboxTests.length
      ? sandboxTests.reduce((sum, span) => sum + ((span.testsPassed ?? 0) / Math.max(1, span.testsTotal ?? 1)), 0) / sandboxTests.length
      : toolSpans.some((span) => /\btest|vitest|pytest|jest|build|tsc\b/i.test(JSON.stringify(span.args)))
        ? 0.4
        : 0
    if (!testReality) notes.push('no real test/build evidence recorded')

    const blockerSpans = judgeSpans.filter((span) =>
      isBlockingJudge(span),
    )
    const finalGateBlockers = finalGateSpans.filter((span) => isBlockingJudge(span))
    const finalGate = finalGateSpans.length ? (finalGateBlockers.length ? 0 : 1) : success
    if (finalGateBlockers.length) notes.push(`final gate blocked by ${finalGateBlockers.length} reviewer(s)`)
    else if (!finalGateSpans.length) notes.push('no final gate judgment recorded')

    const reviewerBlockers = judgeSpans.length ? blockerSpans.length / judgeSpans.length : 0
    if (reviewerBlockers) notes.push(`detected ${blockerSpans.length} blocking reviewer signal(s)`)

    const positiveGroundingSignals =
      patchEvidence +
      sandboxSpans.length +
      llmSpans.filter((span) => looksRepoGrounded(span.output ?? '')).length
    const driftSignals =
      llmSpans.filter((span) => this.isDrift(span.output ?? '')).length +
      trace.events.filter((event) => this.isDrift(JSON.stringify(event.payload))).length
    const repoGroundedness = positiveGroundingSignals + driftSignals === 0
      ? 0
      : positiveGroundingSignals / (positiveGroundingSignals + driftSignals)
    const driftPenalty = positiveGroundingSignals + driftSignals === 0
      ? 0
      : driftSignals / (positiveGroundingSignals + driftSignals)
    if (driftSignals > 0) notes.push(`detected ${driftSignals} drift signal(s)`)

    const costUsd = trace.budget.length
      ? Math.max(...trace.budget.filter((entry: BudgetLedgerEntry) => entry.dimension === 'usd').map((entry: BudgetLedgerEntry) => entry.consumed), 0)
      : llmSpans.reduce((sum, span) => sum + (span.costUsd ?? 0), 0)
    const wallSeconds = trace.run.endedAt && trace.run.startedAt
      ? Math.max(0, (trace.run.endedAt - trace.run.startedAt) / 1000)
      : 0

    return {
      success,
      goalProgress,
      repoGroundedness,
      driftPenalty,
      toolUseQuality,
      patchQuality,
      testReality,
      finalGate,
      reviewerBlockers,
      costUsd,
      wallSeconds,
      notes,
    }
  }

  rank(score: RunScore): number {
    return aggregateRunScore(score, this.weights)
  }

  private isDrift(text: string): boolean {
    return this.driftPatterns.some((pattern) => pattern.test(text))
  }
}

function normalizeJudgeScore(score: number): number {
  return score > 1 ? clamp01(score / 10) : clamp01(score)
}

function looksRepoGrounded(text: string): boolean {
  return /(?:src\/|tests?\/|package\.json|tsconfig|\.ts\b|\.tsx\b|git status|pnpm |npm |vitest|pytest|jest)/i.test(text)
}

function isBlockingJudge(span: Extract<Span, { kind: 'judge' }>): boolean {
  return span.attributes?.blocking === true ||
    span.attributes?.verdict === 'BLOCKING' ||
    positiveNumber(span.attributes?.blockingFindings) ||
    positiveNumber(span.attributes?.highFindings) ||
    span.score <= 2
}

function positiveNumber(value: unknown): boolean {
  return typeof value === 'number' && value > 0
}
