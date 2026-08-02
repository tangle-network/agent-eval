/**
 * GEPA campaign over the recursive CodeTraceBench analyst instructions (round 2).
 *
 * Surface: the full RLM instruction string. The output-contract block (the
 * subject grammar and block caps) is frozen: a candidate that does not contain
 * it verbatim as its final section scores 0 without spending a model call,
 * because a rewritten contract breaks the subject encoding and produces
 * parse-zero scores that are indistinguishable from bad analysis.
 *
 * Data: the SPENT dev-32 and holdout-1 pools (32 labeled-positive scenarios).
 * Both pools were burned by earlier measurement runs, so they are legal for
 * training but can certify nothing; certification runs elsewhere on sealed
 * splits via `analyst-benchmark --instructions-file`. The train/selection
 * split (~20/~12, disjoint) is seeded and stratified by gold-block width —
 * the widest contiguous run of labeled incorrect steps — so the selection
 * split represents both wide-block and narrow-block regimes.
 *
 * Feedback is micro-aligned two ways:
 *  1. The score GEPA optimizes is the judge composite (per-case f1 averaged
 *     with critical-step accuracy when defined) multiplied by the case's
 *     gold-mass weight (labeled-issue count / pool max), so the mean GEPA
 *     climbs is proportional to a gold-mass-weighted average — the macro
 *     proxy closest to the micro benchmark headline.
 *  2. Every evaluation returns per-case TP/FP/FN counts and missed issue ids
 *     through the artifact evidence, so reflection sees the count structure
 *     behind each scalar. The selection readout reports the weighted metric,
 *     the plain macro composite, plain macro f1, and pooled micro f1
 *     side by side so they are never confused.
 *
 * Usage:
 *   ZAI_GLM_API_KEY=... pnpm exec tsx scripts/gepa-analyst-campaign.ts --plan   # split only, no spend
 *   ZAI_GLM_API_KEY=... pnpm exec tsx scripts/gepa-analyst-campaign.ts --smoke
 *   # full run, detached, with archival on completion:
 *   setsid nohup bash -c 'ZAI_GLM_API_KEY=... pnpm exec tsx scripts/gepa-analyst-campaign.ts; \
 *     rsync -a /dev/shm/mp-tg2-gepa-r2/ ~/bench-cache/ctb-20260801/gepa-run2/' \
 *     > /dev/shm/mp-tg2-gepa-r2.log 2>&1 &
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AnalystBenchmarkCase } from '../src/analyst/benchmark'
import type { AnalystIssueExpectation } from '../src/analyst/benchmark'
import { scoreAnalystFindings } from '../src/analyst/benchmark'
import { adaptPublicBenchmarkFindings } from '../src/analyst/benchmark-public-adapters'
import {
  CODE_TRACE_BENCH_ANALYST_PROMPT,
  publicBenchmarkRlmInstructions,
} from '../src/analyst/benchmark-public-prompt'
import { preparePublicAnalystBenchmark } from '../src/analyst/benchmark-public-data'
import { sha256Digest } from '../src/analyst/benchmark-verification-artifacts'
import { createDspyRlmTraceEngine } from '../src/analyst/dspy-rlm-engine'
import { evidenceRefsFromRawFinding } from '../src/analyst/finding-signature'
import { runTraceAnalyst, type TraceAnalystDefinition } from '../src/analyst/kind-factory'
import { makeFinding } from '../src/analyst/types'
import type { AnalystFinding } from '../src/analyst/types'
import {
  traceAnalystQualityJudge,
  type TraceAnalystArtifact,
  type TraceAnalystScenario,
} from '../src/campaign/analyst-surface'
import { gepaOptimizationMethod } from '../src/campaign/gepa-optimization-method'
import type {
  OptimizationMethodInput,
  OptimizationMethodRunOptions,
} from '../src/campaign/presets/compare-optimization-methods'
import { createRunCostLedger, fsCampaignStorage } from '../src/campaign/storage'
import type { DispatchContext, JudgeConfig, MutableSurface, Scenario } from '../src/campaign/types'
import type { TraceAnalysisStore } from '../src/trace-analyst/store'

// ── Configuration ─────────────────────────────────────────────────────

const SMOKE = process.argv.includes('--smoke')
const RUN_DIR_ARG = argValue('--run-dir')
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const RUN_DIR = RUN_DIR_ARG ?? (SMOKE ? '/dev/shm/mp-tg2-gepa-r2-smoke' : '/dev/shm/mp-tg2-gepa-r2')
const ROUND = 2
const SEED = 23
const MODEL = 'glm-5.2'
const BASE_URL = 'https://api.z.ai/api/coding/paas/v4'
const PRICING = { inputUsdPerMillion: 0.6, outputUsdPerMillion: 2.2 }
const EVALUATIONS_OVERRIDE = argValue('--max-evaluations')
const MAX_EVALUATIONS = EVALUATIONS_OVERRIDE
  ? Number.parseInt(EVALUATIONS_OVERRIDE, 10)
  : SMOKE
    ? 3
    : 60
const COST_CEILING_USD = SMOKE ? 3 : 20
const MAX_PROPOSER_COST_USD = SMOKE ? 1 : 5
const GEPA_TIMEOUT_MS = SMOKE ? 3_600_000 : 28_800_000
const ANALYSIS_TIMEOUT_MS = 1_200_000
const EVAL_COST_PHASE = 'gepa.analyst-evaluation'
const DSPY_PYTHON = join(ROOT, 'clients/python/.venv/bin/python')
const GEPA_PYTHON = join(ROOT, 'clients/python/.venv-gepa/bin/python')

/** Spent pools only. Both are training-legal and certification-illegal. */
const POOLS = [
  {
    name: 'dev32',
    labelsPath: join(
      ROOT,
      'benchmarks/trace-analysis/codetracebench-glm52-20260730/input-labels.json',
    ),
    traceDir: '/dev/shm/ctb-traces',
    artifactDir: '/dev/shm/ctb-prepared/extracted',
  },
  {
    name: 'holdout1',
    labelsPath: '/dev/shm/ctb-holdout-labels.json',
    traceDir: '/dev/shm/ctb-holdout-traces',
    artifactDir: '/dev/shm/ctb-holdout-prepared/extracted',
  },
] as const

/** A gold block of >= this many contiguous incorrect steps counts as wide. */
const WIDE_MIN_BLOCK_WIDTH = 3
const SELECTION_TOTAL = 12

const API_KEY = process.env.ZAI_GLM_API_KEY?.trim()
if (!API_KEY) throw new Error('ZAI_GLM_API_KEY is required')

// ── Frozen output contract ────────────────────────────────────────────

const BASELINE = publicBenchmarkRlmInstructions('codetracebench')
if (!BASELINE.startsWith(`${CODE_TRACE_BENCH_ANALYST_PROMPT}\n`)) {
  throw new Error('baseline instructions no longer compose as policy + contract')
}
const CONTRACT_BLOCK = BASELINE.slice(CODE_TRACE_BENCH_ANALYST_PROMPT.length + 1)
if (!CONTRACT_BLOCK.trim() || `${CODE_TRACE_BENCH_ANALYST_PROMPT}\n${CONTRACT_BLOCK}` !== BASELINE) {
  throw new Error('frozen contract block extraction failed')
}

// ── Scenarios (JSON-safe: compareOptimizationMethods structuredClones them,
//    so live trace stores are resolved by scenario id inside the dispatch) ──

interface GepaAnalystScenario extends Scenario {
  kind: 'trace-analyst'
  labelState: 'positive'
  pool: string
  trajectoryId: string
  expectedIssues: AnalystIssueExpectation[]
  labeledEvidence?: AnalystBenchmarkCase['labeledEvidence']
  /** Labeled incorrect-step count — the case's share of the micro denominator. */
  goldMass: number
  /** Widest contiguous run of labeled incorrect steps. */
  maxBlockWidth: number
  stratum: 'wide' | 'narrow'
}

interface MatchCounts {
  expectedIssues: number
  tp: number
  fp: number
  fn: number
}

interface GepaAnalystArtifact extends TraceAnalystArtifact {
  surfaceSha256: string
  rawSubjects: string[]
  matchCounts: MatchCounts
  missedIssueIds: string[]
  contractViolation?: boolean
  executionError?: string
  blockDiagnostics?: unknown
}

const storesById = new Map<string, TraceAnalysisStore>()

function seededShuffle<T>(items: readonly T[], seed: number): T[] {
  let state = seed >>> 0
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const out = [...items]
  for (let index = out.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(next() * (index + 1))
    ;[out[index], out[swap]] = [out[swap]!, out[index]!]
  }
  return out
}

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/** Widths of maximal runs of consecutive labeled incorrect steps. */
function goldBlockWidths(expectedIssues: readonly AnalystIssueExpectation[]): number[] {
  const steps = expectedIssues
    .map((issue) => Number.parseInt(issue.id.slice(issue.id.lastIndexOf(':') + 1), 10))
    .filter((value) => Number.isSafeInteger(value) && value > 0)
    .sort((a, b) => a - b)
  if (steps.length === 0) return [0]
  const widths: number[] = []
  let run = 1
  for (let index = 1; index <= steps.length; index += 1) {
    if (index < steps.length && steps[index] === steps[index - 1]! + 1) run += 1
    else {
      widths.push(run)
      run = 1
    }
  }
  return widths
}

// ── Score ledger: every judge verdict lands here, keyed by candidate hash,
//    so the selection comparison is harvested without re-running anything. ──

const SCORE_LEDGER_PATH = join(RUN_DIR, 'score-ledger.jsonl')

interface LedgerScoreRow {
  scenarioId: string
  surfaceSha256: string
  /** Gold-mass-weighted composite — the signal GEPA optimizes. */
  composite: number
  /** Unweighted judge composite (f1, averaged with critical-step accuracy). */
  rawComposite: number
  goldMassWeight: number
  f1: number
  counts: MatchCounts
  dimensions: Record<string, number>
  notes: string
}

function recordScore(row: LedgerScoreRow): void {
  appendFileSync(SCORE_LEDGER_PATH, `${JSON.stringify({ ...row, at: new Date().toISOString() })}\n`)
}

function microFromCounts(rows: readonly MatchCounts[]): {
  tp: number
  fp: number
  fn: number
  precision: number
  recall: number
  f1: number
} {
  const tp = rows.reduce((total, row) => total + row.tp, 0)
  const fp = rows.reduce((total, row) => total + row.fp, 0)
  const fn = rows.reduce((total, row) => total + row.fn, 0)
  const precision = tp + fp === 0 ? 0 : tp / (tp + fp)
  const recall = tp + fn === 0 ? 0 : tp / (tp + fn)
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall)
  return { tp, fp, fn, precision, recall, f1 }
}

async function main(): Promise<void> {
  mkdirSync(RUN_DIR, { recursive: true })
  const storage = fsCampaignStorage()
  const costLedger = createRunCostLedger({
    storage,
    runDir: join(RUN_DIR, 'cost'),
    costCeilingUsd: COST_CEILING_USD,
  })

  // ── Pool: positives from both spent splits, stratified by block width ──

  const scenarios: GepaAnalystScenario[] = []
  const poolProvenance: Array<{ name: string; labelsPath: string; labelsSha256: string }> = []
  for (const pool of POOLS) {
    const prepared = await preparePublicAnalystBenchmark({
      dataset: 'codetracebench',
      labelsPath: pool.labelsPath,
      traceDir: pool.traceDir,
      artifactDir: pool.artifactDir,
      limit: 32,
      seed: 0,
    })
    poolProvenance.push({
      name: pool.name,
      labelsPath: pool.labelsPath,
      labelsSha256: sha256Digest(readFileSync(pool.labelsPath, 'utf8')),
    })
    for (const benchmarkCase of prepared.cases) {
      if (benchmarkCase.labelState !== 'positive') continue
      if (!benchmarkCase.input.traceStore) {
        throw new Error(`prepared case '${benchmarkCase.id}' has no trace store`)
      }
      if (storesById.has(benchmarkCase.id)) {
        throw new Error(`scenario '${benchmarkCase.id}' appears in more than one pool`)
      }
      storesById.set(benchmarkCase.id, benchmarkCase.input.traceStore)
      const widths = goldBlockWidths(benchmarkCase.expectedIssues)
      const maxBlockWidth = Math.max(...widths)
      scenarios.push({
        id: benchmarkCase.id,
        kind: 'trace-analyst',
        labelState: 'positive',
        pool: pool.name,
        trajectoryId: benchmarkCase.id.replace(/^codetrace:/, ''),
        expectedIssues: [...benchmarkCase.expectedIssues],
        ...(benchmarkCase.labeledEvidence
          ? { labeledEvidence: [...benchmarkCase.labeledEvidence] }
          : {}),
        goldMass: benchmarkCase.expectedIssues.length,
        maxBlockWidth,
        stratum: maxBlockWidth >= WIDE_MIN_BLOCK_WIDTH ? 'wide' : 'narrow',
      })
    }
  }
  if (scenarios.length !== 32) {
    throw new Error(`expected 32 labeled-positive scenarios across pools, found ${scenarios.length}`)
  }
  const maxGoldMass = Math.max(...scenarios.map((scenario) => scenario.goldMass))
  const goldMassWeight = (scenario: Pick<GepaAnalystScenario, 'goldMass'>) =>
    scenario.goldMass / maxGoldMass

  const wide = seededShuffle(
    scenarios.filter((scenario) => scenario.stratum === 'wide'),
    SEED,
  )
  const narrow = seededShuffle(
    scenarios.filter((scenario) => scenario.stratum === 'narrow'),
    SEED + 1,
  )
  const selectionWide = Math.min(
    wide.length,
    Math.max(1, Math.round((SELECTION_TOTAL * wide.length) / scenarios.length)),
  )
  const selectionNarrow = SELECTION_TOTAL - selectionWide
  const fullSelection = [...wide.slice(0, selectionWide), ...narrow.slice(0, selectionNarrow)]
  const fullTrain = [...wide.slice(selectionWide), ...narrow.slice(selectionNarrow)]
  const trainScenarios = SMOKE
    ? [wide[selectionWide]!, narrow[selectionNarrow]!]
    : seededShuffle(fullTrain, SEED + 2)
  const selectionScenarios = SMOKE ? [fullSelection[0]!] : seededShuffle(fullSelection, SEED + 3)
  const describeSplit = (split: readonly GepaAnalystScenario[]) => ({
    n: split.length,
    wide: split.filter((scenario) => scenario.stratum === 'wide').length,
    narrow: split.filter((scenario) => scenario.stratum === 'narrow').length,
    dev32: split.filter((scenario) => scenario.pool === 'dev32').length,
    holdout1: split.filter((scenario) => scenario.pool === 'holdout1').length,
    goldMass: split.reduce((total, scenario) => total + scenario.goldMass, 0),
  })
  const stratification = {
    wideMinBlockWidth: WIDE_MIN_BLOCK_WIDTH,
    pool: describeSplit(scenarios),
    train: describeSplit(trainScenarios),
    selection: describeSplit(selectionScenarios),
    maxGoldMass,
  }
  console.log(`[gepa-analyst-r2] stratification ${JSON.stringify(stratification)}`)

  if (process.argv.includes('--plan')) {
    const plan = {
      kind: 'agent-eval/gepa-analyst-campaign-plan',
      round: ROUND,
      seed: SEED,
      pools: poolProvenance,
      stratification,
      trainScenarios: trainScenarios.map((scenario) => ({
        id: scenario.id,
        pool: scenario.pool,
        stratum: scenario.stratum,
        goldMass: scenario.goldMass,
        maxBlockWidth: scenario.maxBlockWidth,
      })),
      selectionScenarios: selectionScenarios.map((scenario) => ({
        id: scenario.id,
        pool: scenario.pool,
        stratum: scenario.stratum,
        goldMass: scenario.goldMass,
        maxBlockWidth: scenario.maxBlockWidth,
      })),
      weighting: {
        scheme: 'goldMass / maxGoldMass over the full 32-scenario pool',
        maxGoldMass,
      },
    }
    writeFileSync(join(RUN_DIR, 'split-plan.json'), `${JSON.stringify(plan, null, 2)}\n`)
    console.log(`[gepa-analyst-r2] plan-only: wrote ${join(RUN_DIR, 'split-plan.json')}`)
    return
  }

  // ── Engine + dispatch ───────────────────────────────────────────────

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
  //    (b) multiply the composite by the case's gold-mass weight so the mean
  //        GEPA climbs is micro-aligned, and
  //    (c) append every verdict (raw + weighted + counts) to the score ledger. ──

  const baseJudge = traceAnalystQualityJudge()
  const zeroDimensions = Object.fromEntries(baseJudge.dimensions.map(({ key }) => [key, 0]))
  const judge: JudgeConfig<GepaAnalystArtifact, GepaAnalystScenario> = {
    name: baseJudge.name,
    ...(baseJudge.judgeVersion ? { judgeVersion: `${baseJudge.judgeVersion}+gepa-r2-goldmass` } : {}),
    dimensions: [
      ...baseJudge.dimensions,
      { key: 'raw_composite', description: 'unweighted judge composite' },
      { key: 'gold_mass_weight', description: 'labeled-issue count / pool max' },
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

  // ── GEPA method ─────────────────────────────────────────────────────

  const method = gepaOptimizationMethod<GepaAnalystScenario, GepaAnalystArtifact>({
    name: 'gepa-analyst-policy-r2',
    objective:
      'Rewrite the analysis policy of a recursive coding-trace analyst so it localizes every ' +
      'incorrect assistant step (contiguous failure blocks) more accurately. Per case, the ' +
      'quality score is the harmonic mean of labeled-issue recall and finding precision, ' +
      'averaged with critical-step accuracy when defined; that score is multiplied by the ' +
      "case's gold-mass weight (labeled incorrect-step count / pool max), so cases with many " +
      'labeled incorrect steps carry proportionally more of the optimization signal — this ' +
      'matches the micro-F1 benchmark headline. Evaluation evidence carries per-case counts ' +
      '(tp = labeled issues matched, fp = findings tied to no labeled issue, fn = labeled ' +
      'issues missed) plus the missed issue ids: use the counts, not just the scalar, to ' +
      'decide what to change — high fn concentrated in wide blocks means under-flagging block ' +
      'spans; high fp means over-flagging correct steps. The candidate is the complete ' +
      'instruction string: an analysis policy followed by a fixed output contract. The ' +
      'output-contract block must be preserved BYTE-IDENTICAL as the final section of the ' +
      'candidate — it defines the machine-parsed subject grammar (incorrect-steps-<first>-' +
      '<last>-<escape>-consequence-<n>) and the block caps, and any candidate missing it ' +
      'verbatim scores 0 without being executed. Edit only the policy text above the contract.',
    background:
      `The frozen output contract (must appear verbatim at the end of every candidate):\n` +
      `${CONTRACT_BLOCK}`,
    evaluationId: 'codetracebench-analyst-instructions-r2',
    recipe: {
      kind: 'engine',
      run: {
        engine: 'gepa',
        maxEvaluations: MAX_EVALUATIONS,
        maxProposerCostUsd: MAX_PROPOSER_COST_USD,
        maxConcurrency: 1,
        engineConfig: {
          engine: {
            capture_stdio: false,
            max_workers: 1,
            parallel: false,
            raise_on_exception: true,
            seed: SEED,
          },
          reflection: { reflection_minibatch_size: 3, skip_perfect_score: false },
        },
      },
    },
    optimizer: {
      model: MODEL,
      baseUrl: BASE_URL,
      apiKey: API_KEY!,
      budget: {
        maxCostUsd: MAX_PROPOSER_COST_USD,
        maxRequests: 120,
        maxRequestBytes: 4_000_000,
        maxResponseBytes: 4_000_000,
        maxOutputTokensPerRequest: 16_384,
        maxReasoningTokensPerRequest: 32_768,
        pricing: PRICING,
      },
    },
    timeoutMs: GEPA_TIMEOUT_MS,
    describeScenario: (scenario) => ({
      id: scenario.id,
      trajectoryId: scenario.trajectoryId,
      stratum: scenario.stratum,
      goldMass: scenario.goldMass,
      maxBlockWidth: scenario.maxBlockWidth,
    }),
    describeArtifact: (artifact, scenario) => ({
      rawSubjects: artifact.rawSubjects.slice(0, 24),
      scoredFindings: artifact.findings.length,
      counts: artifact.matchCounts,
      missedIssueIds: artifact.missedIssueIds.slice(0, 24),
      goldMassWeight: goldMassWeight(scenario),
      ...(artifact.contractViolation ? { contractViolation: true } : {}),
      ...(artifact.executionError ? { executionError: artifact.executionError } : {}),
      ...(artifact.blockDiagnostics ? { blockDiagnostics: artifact.blockDiagnostics } : {}),
    }),
    runner: { command: GEPA_PYTHON },
  })

  const runOptions: OptimizationMethodRunOptions<GepaAnalystScenario, GepaAnalystArtifact> = {
    expectUsage: 'off',
    storage,
    dispatchTimeoutMs: ANALYSIS_TIMEOUT_MS + 300_000,
  }
  const input: OptimizationMethodInput<GepaAnalystScenario, GepaAnalystArtifact> = {
    baselineSurface: BASELINE,
    trainScenarios,
    selectionScenarios,
    dispatchWithSurface,
    judges: [judge],
    runDir: RUN_DIR,
    seed: SEED,
    runOptions,
    costLedger,
  }

  console.log(`[gepa-analyst-r2] starting GEPA: maxEvaluations=${MAX_EVALUATIONS} runDir=${RUN_DIR}`)
  const started = Date.now()
  const result = await method.optimize(input)
  const winner = result.winnerSurface
  if (typeof winner !== 'string') throw new Error('winner surface is not a string')
  const winnerSha256 = sha256Digest(winner)
  const baselineSha256 = sha256Digest(BASELINE)
  writeFileSync(join(RUN_DIR, 'winner-instructions.txt'), winner)
  console.log(
    `[gepa-analyst-r2] optimize done in ${((Date.now() - started) / 60_000).toFixed(1)}min ` +
      `evaluations=${result.provenance?.evaluationCount} winnerSha=${winnerSha256}`,
  )

  // ── Selection comparison: harvest judged scores from the ledger; score any
  //    missing (surface, scenario) pair directly through the same dispatch +
  //    judge. Reports the weighted metric (what GEPA optimized), the plain
  //    macro composite, plain macro f1, and pooled micro f1 side by side. ──

  interface HarvestRow {
    rawComposite: number
    weighted: number
    f1: number
    counts: MatchCounts
  }
  const harvest = new Map<string, HarvestRow>()
  for (const line of readFileSync(SCORE_LEDGER_PATH, 'utf8').split('\n')) {
    if (!line.trim()) continue
    const row = JSON.parse(line) as LedgerScoreRow
    harvest.set(`${row.surfaceSha256}:${row.scenarioId}`, {
      rawComposite: row.rawComposite,
      weighted: row.composite,
      f1: row.f1,
      counts: row.counts,
    })
  }
  const scoreDirect = async (
    surface: string,
    scenario: GepaAnalystScenario,
  ): Promise<HarvestRow> => {
    const controller = new AbortController()
    const ctx = {
      cellId: `selection-topup:${sha256Digest(surface).slice(0, 12)}:${scenario.id}`,
      rep: 0,
      seed: SEED,
      signal: controller.signal,
    } as unknown as DispatchContext
    const artifact = await dispatchWithSurface(surface, scenario, ctx)
    const verdict = await judge.score({
      artifact,
      scenario,
      signal: controller.signal,
    })
    return {
      rawComposite: verdict.dimensions.raw_composite ?? 0,
      weighted: verdict.composite,
      f1: verdict.dimensions.f1 ?? 0,
      counts: artifact.matchCounts,
    }
  }
  const comparison: Array<{
    scenarioId: string
    stratum: string
    goldMass: number
    baseline: HarvestRow
    winner: HarvestRow
    deltaWeighted: number
    deltaRaw: number
    deltaF1: number
  }> = []
  for (const scenario of selectionScenarios) {
    const baselineRow =
      harvest.get(`${baselineSha256}:${scenario.id}`) ?? (await scoreDirect(BASELINE, scenario))
    const winnerRow =
      winnerSha256 === baselineSha256
        ? baselineRow
        : (harvest.get(`${winnerSha256}:${scenario.id}`) ?? (await scoreDirect(winner, scenario)))
    comparison.push({
      scenarioId: scenario.id,
      stratum: scenario.stratum,
      goldMass: scenario.goldMass,
      baseline: baselineRow,
      winner: winnerRow,
      deltaWeighted: winnerRow.weighted - baselineRow.weighted,
      deltaRaw: winnerRow.rawComposite - baselineRow.rawComposite,
      deltaF1: winnerRow.f1 - baselineRow.f1,
    })
  }
  const mean = (values: number[]) =>
    values.length === 0 ? 0 : values.reduce((total, value) => total + value, 0) / values.length
  const summary = {
    kind: 'agent-eval/gepa-analyst-campaign-summary',
    round: ROUND,
    smoke: SMOKE,
    seed: SEED,
    model: MODEL,
    baseUrl: BASE_URL,
    runDir: RUN_DIR,
    pools: poolProvenance,
    stratification,
    scenarioCounts: {
      pool: scenarios.length,
      train: trainScenarios.length,
      selection: selectionScenarios.length,
    },
    trainScenarioIds: trainScenarios.map((scenario) => scenario.id),
    selectionScenarioIds: selectionScenarios.map((scenario) => scenario.id),
    weighting: {
      scheme: 'goldMass / maxGoldMass over the full 32-scenario pool',
      maxGoldMass,
      perScenario: Object.fromEntries(
        scenarios.map((scenario) => [scenario.id, goldMassWeight(scenario)]),
      ),
    },
    maxEvaluations: MAX_EVALUATIONS,
    evaluationsUsed: result.provenance?.evaluationCount,
    baselineSha256,
    winnerSha256,
    winnerChanged: winnerSha256 !== baselineSha256,
    // All metrics below are over the (spent) selection split; none certify.
    selectionComparison: {
      note:
        'paired per-scenario metrics over the selection split. weighted = gold-mass-weighted ' +
        'judge composite (the signal GEPA optimized); plainMacroComposite = unweighted judge ' +
        'composite; plainMacroF1 = mean per-scenario f1; microF1 = pooled per-step counts. ' +
        'Weighted and plain metrics are different quantities — never compare one arm on ' +
        'weighted against another on plain.',
      n: comparison.length,
      weighted: {
        baselineMean: mean(comparison.map((row) => row.baseline.weighted)),
        winnerMean: mean(comparison.map((row) => row.winner.weighted)),
        deltaMean: mean(comparison.map((row) => row.deltaWeighted)),
      },
      plainMacroComposite: {
        baselineMean: mean(comparison.map((row) => row.baseline.rawComposite)),
        winnerMean: mean(comparison.map((row) => row.winner.rawComposite)),
        deltaMean: mean(comparison.map((row) => row.deltaRaw)),
      },
      plainMacroF1: {
        baselineMean: mean(comparison.map((row) => row.baseline.f1)),
        winnerMean: mean(comparison.map((row) => row.winner.f1)),
        deltaMean: mean(comparison.map((row) => row.deltaF1)),
      },
      microF1: {
        baseline: microFromCounts(comparison.map((row) => row.baseline.counts)),
        winner: microFromCounts(comparison.map((row) => row.winner.counts)),
      },
      perScenario: comparison,
    },
    methodCost: result.cost,
    provenance: result.provenance,
    ledger: {
      total: costLedger.summary(),
      evaluation: costLedger.summary({ phase: EVAL_COST_PHASE }),
      optimizerModel: costLedger.summary({ phase: 'gepa.optimizer-model' }),
    },
    durationMs: Date.now() - started,
  }
  writeFileSync(join(RUN_DIR, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`)
  console.log(JSON.stringify(summary.selectionComparison, null, 2))
  console.log(
    `[gepa-analyst-r2] total ledger cost=$${costLedger.summary().totalCostUsd.toFixed(4)} ` +
      `summary=${join(RUN_DIR, 'summary.json')}`,
  )
}

main().catch((error) => {
  console.error('[gepa-analyst-r2] FAILED:', error)
  process.exitCode = 1
})
