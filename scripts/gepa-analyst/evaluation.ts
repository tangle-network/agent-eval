/** Analyst dispatch and judging with explicit zero-score failures and durable score evidence. */
import { appendFileSync } from 'node:fs'
import { scoreAnalystFindings } from '../../src/analyst/benchmark'
import { adaptPublicBenchmarkFindings } from '../../src/analyst/benchmark-public-adapters'
import { sha256Digest } from '../../src/analyst/benchmark-verification-artifacts'
import { createDspyRlmTraceEngine } from '../../src/analyst/dspy-rlm-engine'
import { evidenceRefsFromRawFinding } from '../../src/analyst/finding-signature'
import { runTraceAnalyst, type TraceAnalystDefinition } from '../../src/analyst/kind-factory'
import { makeFinding } from '../../src/analyst/types'
import type { AnalystFinding } from '../../src/analyst/types'
import {
  traceAnalystQualityJudge,
  type TraceAnalystScenario,
} from '../../src/campaign/analyst-surface'
import type { DispatchContext, JudgeConfig, MutableSurface } from '../../src/campaign/types'
import type { TraceAnalysisStore } from '../../src/trace-analyst/store'
import {
  FAMILY,
  MODEL,
  BASE_URL,
  PRICING,
  ANALYSIS_TIMEOUT_MS,
  EVAL_COST_PHASE,
  DSPY_PYTHON,
  API_KEY,
  CONTRACT_BLOCK,
  SCORE_LEDGER_PATH,
} from './configuration'
import type {
  GepaAnalystScenario,
  GepaAnalystArtifact,
  MatchCounts,
  LedgerScoreRow,
  GoldMassWeight,
} from './contract'
import type { CostLedgerHandle } from '../../src/cost-ledger'

function recordScore(row: LedgerScoreRow): void {
  appendFileSync(SCORE_LEDGER_PATH, `${JSON.stringify({ ...row, at: new Date().toISOString() })}\n`)
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

export function createCampaignEvaluation(
  costLedger: CostLedgerHandle,
  storesById: ReadonlyMap<string, TraceAnalysisStore>,
  goldMassWeight: GoldMassWeight,
) {
  const engine = createDspyRlmTraceEngine({
    baseUrl: BASE_URL,
    apiKey: API_KEY!,
    model: MODEL,
    maxOutputTokens: 16_384,
    timeoutMs: ANALYSIS_TIMEOUT_MS,
    maxCostUsd: 1,
    pricing: PRICING,
    runner: { command: DSPY_PYTHON },
  })
  const limits = { maxIterations: 14, maxLlmCalls: 8, maxToolCalls: 80, maxOutputChars: 8_000 }

  const emptyCounts = (scenario: GepaAnalystScenario): MatchCounts => ({
    expectedIssues: scenario.expectedIssues.length,
    tp: 0,
    fp: 0,
    fn: scenario.expectedIssues.length,
  })

  const dispatchWithSurface = async (
    surface: MutableSurface,
    scenario: GepaAnalystScenario,
    ctx: DispatchContext,
  ): Promise<GepaAnalystArtifact> => {
    if (typeof surface !== 'string') {
      throw new TypeError(`this campaign optimizes a string surface, received ${surface.kind}`)
    }
    const surfaceSha256 = sha256Digest(surface)
    if (!surface.includes(CONTRACT_BLOCK)) {
      return {
        findings: [],
        rawSubjects: [],
        surfaceSha256,
        matchCounts: emptyCounts(scenario),
        missedIssueIds: scenario.expectedIssues.map((issue) => issue.id),
        contractViolation: true,
      }
    }
    const store = storesById.get(scenario.id)
    if (!store) throw new Error(`no trace store registered for scenario '${scenario.id}'`)
    const definition: TraceAnalystDefinition = {
      id: 'codetracebench-dspy-rlm',
      description: 'Localizes every incorrect state-changing assistant step.',
      area: 'incorrect',
      version: '1.0.0',
      question: 'Which assistant steps are incorrect under the CodeTraceBench definition?',
      instructions: surface,
      toolGroup: 'singleTrace',
      limits,
    }
    try {
      const completed = await runTraceAnalyst({
        definition,
        engine,
        store,
        context: {
          runId: `${ctx.cellId}:${scenario.id}`,
          correlationId: `${ctx.cellId}:${scenario.id}`,
          costLedger,
          costPhase: EVAL_COST_PHASE,
          tags: { scenarioId: scenario.id, surfaceSha256 },
          signal: ctx.signal,
        },
      })
      const producedAt = new Date().toISOString()
      const rawFindings: AnalystFinding[] = completed.findings.map((finding) =>
        makeFinding({
          analyst_id: 'dspy-rlm',
          area: 'incorrect',
          subject: finding.subject,
          claim: finding.claim,
          rationale: finding.rationale,
          severity: finding.severity,
          confidence: finding.confidence,
          evidence_refs: evidenceRefsFromRawFinding(finding),
          recommended_action: finding.recommended_action,
          metadata: { analysis_mode: 'recursive', engine: 'dspy-rlm', model: MODEL },
          produced_at: producedAt,
        }),
      )
      const adapted = await adaptPublicBenchmarkFindings({
        dataset: 'codetracebench',
        trajectoryId: scenario.trajectoryId,
        findings: rawFindings,
        analystId: 'dspy-rlm',
        store,
        signal: ctx.signal,
      })
      // The same pure scorer the judge uses, run here so per-case TP/FP/FN
      // counts travel with the artifact into GEPA's reflection evidence.
      const matchScore = scoreAnalystFindings(
        {
          id: scenario.id,
          expectedIssues: scenario.expectedIssues,
          ...(scenario.labeledEvidence ? { labeledEvidence: scenario.labeledEvidence } : {}),
        },
        adapted.findings,
      )
      return {
        findings: adapted.findings,
        rawSubjects: rawFindings.map((finding) => finding.subject ?? ''),
        surfaceSha256,
        matchCounts: {
          expectedIssues: matchScore.expectedIssueCount,
          tp: matchScore.matchedIssueIds.length,
          fp: matchScore.unsupportedFindingIndexes.length,
          fn: matchScore.missedIssueIds.length,
        },
        missedIssueIds: matchScore.missedIssueIds,
        ...(adapted.diagnostics ? { blockDiagnostics: adapted.diagnostics } : {}),
      }
    } catch (error) {
      if (ctx.signal.aborted) throw error
      // A transient provider failure scores 0 with a loud note instead of
      // aborting the whole optimizer run; the note keeps it visible in every
      // downstream report and in GEPA's reflection evidence.
      return {
        findings: [],
        rawSubjects: [],
        surfaceSha256,
        matchCounts: emptyCounts(scenario),
        missedIssueIds: scenario.expectedIssues.map((issue) => issue.id),
        executionError: truncate(error instanceof Error ? error.message : String(error), 500),
      }
    }
  }

  // ── Judge: the shared trace-analyst quality judge, wrapped to
  //    (a) score contract violations and execution failures as explicit zeros,
  //    (b) apply the round's weighting (gold mass in round 2, none in family
  //        mode), and
  //    (c) append every verdict (raw + weighted + counts) to the score ledger. ──

  const baseJudge = traceAnalystQualityJudge()
  const zeroDimensions = Object.fromEntries(baseJudge.dimensions.map(({ key }) => [key, 0]))
  const judgeVersionSuffix = FAMILY ? '+gepa-r3-family-plain' : '+gepa-r2-goldmass'
  const judge: JudgeConfig<GepaAnalystArtifact, GepaAnalystScenario> = {
    name: baseJudge.name,
    ...(baseJudge.judgeVersion
      ? { judgeVersion: `${baseJudge.judgeVersion}${judgeVersionSuffix}` }
      : {}),
    dimensions: [
      ...baseJudge.dimensions,
      { key: 'raw_composite', description: 'unweighted judge composite' },
      { key: 'gold_mass_weight', description: 'labeled-issue count / pool max; 1 in family mode' },
    ],
    appliesTo: (scenario) => scenario.kind === 'trace-analyst',
    async score(input) {
      const base = input.artifact.contractViolation
        ? {
            dimensions: { ...zeroDimensions },
            composite: 0,
            notes:
              'CONTRACT VIOLATION: candidate does not contain the output-contract block verbatim; scored 0 without execution',
          }
        : input.artifact.executionError
          ? {
              dimensions: { ...zeroDimensions },
              composite: 0,
              notes: `EXECUTION ERROR: ${input.artifact.executionError}`,
            }
          : await baseJudge.score({
              ...input,
              scenario: input.scenario as unknown as TraceAnalystScenario,
              artifact: input.artifact,
            })
      const weight = goldMassWeight(input.scenario)
      const weighted = base.composite * weight
      const verdict = {
        dimensions: {
          ...base.dimensions,
          raw_composite: base.composite,
          gold_mass_weight: weight,
        },
        composite: weighted,
        notes:
          `goldMass=${input.scenario.goldMass} weight=${weight.toFixed(4)} ` +
          `raw=${base.composite.toFixed(4)} weighted=${weighted.toFixed(4)} | ${base.notes ?? ''}`,
      }
      recordScore({
        scenarioId: input.scenario.id,
        surfaceSha256: input.artifact.surfaceSha256,
        composite: weighted,
        rawComposite: base.composite,
        goldMassWeight: weight,
        f1: base.dimensions.f1 ?? 0,
        counts: input.artifact.matchCounts,
        dimensions: verdict.dimensions,
        notes: verdict.notes,
      })
      return verdict
    },
  }

  return { dispatchWithSurface, judge }
}
