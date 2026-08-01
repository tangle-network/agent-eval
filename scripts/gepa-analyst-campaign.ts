/**
 * GEPA campaign over the recursive CodeTraceBench analyst instructions.
 *
 * Surface: the full RLM instruction string. The output-contract block (the
 * subject grammar and block caps) is frozen: a candidate that does not contain
 * it verbatim as its final section scores 0 without spending a model call,
 * because a rewritten contract breaks the subject encoding and produces
 * parse-zero scores that are indistinguishable from bad analysis.
 *
 * Data: the SPENT pinned-32 dev split only (labels committed in this repo,
 * traces + extracted verification artifacts prepared on disk). Scenarios are
 * filtered to labelState 'positive' and split ~60/40 train/selection with a
 * seeded shuffle. There is no test partition here — final certification runs
 * on sealed splits via `analyst-benchmark --instructions-file`.
 *
 * Scores are the trace-analyst quality judge's composite (per-case f1, averaged
 * with critical-step accuracy when defined). GEPA optimizes the mean of that
 * per-case composite — a macro proxy; the benchmark headline metric is micro.
 *
 * Usage:
 *   ZAI_GLM_API_KEY=... pnpm exec tsx scripts/gepa-analyst-campaign.ts --smoke
 *   ZAI_GLM_API_KEY=... pnpm exec tsx scripts/gepa-analyst-campaign.ts
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AnalystBenchmarkCase } from '../src/analyst/benchmark'
import type { AnalystIssueExpectation } from '../src/analyst/benchmark'
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
const RUN_DIR = RUN_DIR_ARG ?? (SMOKE ? '/dev/shm/mp-tg-gepa-smoke' : '/dev/shm/mp-tg-gepa')
const SEED = 17
const MODEL = 'glm-5.2'
const BASE_URL = 'https://api.z.ai/api/coding/paas/v4'
const PRICING = { inputUsdPerMillion: 0.6, outputUsdPerMillion: 2.2 }
const MAX_EVALUATIONS = SMOKE ? 3 : 40
const COST_CEILING_USD = SMOKE ? 3 : 15
const MAX_PROPOSER_COST_USD = SMOKE ? 1 : 4
const GEPA_TIMEOUT_MS = SMOKE ? 3_600_000 : 21_600_000
const ANALYSIS_TIMEOUT_MS = 1_200_000
const EVAL_COST_PHASE = 'gepa.analyst-evaluation'
const DSPY_PYTHON = join(ROOT, 'clients/python/.venv/bin/python')
const GEPA_PYTHON = join(ROOT, 'clients/python/.venv-gepa/bin/python')
const LABELS_PATH = join(
  ROOT,
  'benchmarks/trace-analysis/codetracebench-glm52-20260730/input-labels.json',
)
const TRACE_DIR = '/dev/shm/ctb-traces'
const ARTIFACT_DIR = '/dev/shm/ctb-prepared/extracted'

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
  trajectoryId: string
  expectedIssues: AnalystIssueExpectation[]
  labeledEvidence?: AnalystBenchmarkCase['labeledEvidence']
}

interface GepaAnalystArtifact extends TraceAnalystArtifact {
  surfaceSha256: string
  rawSubjects: string[]
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

// ── Score ledger: every judge verdict lands here, keyed by candidate hash,
//    so the selection comparison is harvested without re-running anything. ──

const SCORE_LEDGER_PATH = join(RUN_DIR, 'score-ledger.jsonl')

function recordScore(row: {
  scenarioId: string
  surfaceSha256: string
  composite: number
  dimensions: Record<string, number>
  notes: string
}): void {
  appendFileSync(SCORE_LEDGER_PATH, `${JSON.stringify({ ...row, at: new Date().toISOString() })}\n`)
}

async function main(): Promise<void> {
  mkdirSync(RUN_DIR, { recursive: true })
  const storage = fsCampaignStorage()
  const costLedger = createRunCostLedger({
    storage,
    runDir: join(RUN_DIR, 'cost'),
    costCeilingUsd: COST_CEILING_USD,
  })

  const prepared = await preparePublicAnalystBenchmark({
    dataset: 'codetracebench',
    labelsPath: LABELS_PATH,
    traceDir: TRACE_DIR,
    artifactDir: ARTIFACT_DIR,
    limit: 32,
    seed: 0,
  })
  const positives = prepared.cases.filter((benchmarkCase) => benchmarkCase.labelState === 'positive')
  const scenarios: GepaAnalystScenario[] = positives.map((benchmarkCase) => {
    if (!benchmarkCase.input.traceStore) {
      throw new Error(`prepared case '${benchmarkCase.id}' has no trace store`)
    }
    storesById.set(benchmarkCase.id, benchmarkCase.input.traceStore)
    const trajectoryId = benchmarkCase.id.replace(/^codetrace:/, '')
    return {
      id: benchmarkCase.id,
      kind: 'trace-analyst',
      labelState: 'positive',
      trajectoryId,
      expectedIssues: [...benchmarkCase.expectedIssues],
      ...(benchmarkCase.labeledEvidence
        ? { labeledEvidence: [...benchmarkCase.labeledEvidence] }
        : {}),
    }
  })
  const shuffled = seededShuffle(scenarios, SEED)
  const pool = SMOKE ? shuffled.slice(0, 3) : shuffled
  const trainCount = SMOKE ? 2 : Math.ceil(pool.length * 0.6)
  const trainScenarios = pool.slice(0, trainCount)
  const selectionScenarios = pool.slice(trainCount)
  console.log(
    `[gepa-analyst] cases=${prepared.cases.length} positive=${positives.length} ` +
      `pool=${pool.length} train=${trainScenarios.length} selection=${selectionScenarios.length}`,
  )

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
      return { findings: [], rawSubjects: [], surfaceSha256, contractViolation: true }
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
      return {
        findings: adapted.findings,
        rawSubjects: rawFindings.map((finding) => finding.subject ?? ''),
        surfaceSha256,
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
        executionError: truncate(error instanceof Error ? error.message : String(error), 500),
      }
    }
  }

  // ── Judge: the shared trace-analyst quality judge, wrapped to score
  //    contract violations and execution failures as explicit zeros and to
  //    append every verdict to the score ledger. ──

  const baseJudge = traceAnalystQualityJudge()
  const zeroDimensions = Object.fromEntries(baseJudge.dimensions.map(({ key }) => [key, 0]))
  const judge: JudgeConfig<GepaAnalystArtifact, GepaAnalystScenario> = {
    name: baseJudge.name,
    ...(baseJudge.judgeVersion ? { judgeVersion: `${baseJudge.judgeVersion}+gepa-campaign` } : {}),
    dimensions: baseJudge.dimensions,
    appliesTo: (scenario) => scenario.kind === 'trace-analyst',
    async score(input) {
      const verdict = input.artifact.contractViolation
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
      recordScore({
        scenarioId: input.scenario.id,
        surfaceSha256: input.artifact.surfaceSha256,
        composite: verdict.composite,
        dimensions: verdict.dimensions,
        notes: verdict.notes ?? '',
      })
      return verdict
    },
  }

  // ── GEPA method ─────────────────────────────────────────────────────

  const method = gepaOptimizationMethod<GepaAnalystScenario, GepaAnalystArtifact>({
    name: 'gepa-analyst-policy',
    objective:
      'Rewrite the analysis policy of a recursive coding-trace analyst so it localizes every ' +
      'incorrect assistant step (contiguous failure blocks) more accurately. Per case, the score ' +
      'is the harmonic mean of labeled-issue recall and finding precision, averaged with ' +
      'critical-step accuracy when defined; maximize the mean per-case score. The candidate is ' +
      'the complete instruction string: an analysis policy followed by a fixed output contract. ' +
      'The output-contract block must be preserved BYTE-IDENTICAL as the final section of the ' +
      'candidate — it defines the machine-parsed subject grammar (incorrect-steps-<first>-<last>-' +
      '<escape>-consequence-<n>) and the block caps, and any candidate missing it verbatim ' +
      'scores 0 without being executed. Edit only the policy text above the contract.',
    background:
      `The frozen output contract (must appear verbatim at the end of every candidate):\n` +
      `${CONTRACT_BLOCK}`,
    evaluationId: 'codetracebench-analyst-instructions',
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
    }),
    describeArtifact: (artifact) => ({
      rawSubjects: artifact.rawSubjects.slice(0, 24),
      scoredFindings: artifact.findings.length,
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

  console.log(`[gepa-analyst] starting GEPA: maxEvaluations=${MAX_EVALUATIONS} runDir=${RUN_DIR}`)
  const started = Date.now()
  const result = await method.optimize(input)
  const winner = result.winnerSurface
  if (typeof winner !== 'string') throw new Error('winner surface is not a string')
  const winnerSha256 = sha256Digest(winner)
  const baselineSha256 = sha256Digest(BASELINE)
  writeFileSync(join(RUN_DIR, 'winner-instructions.txt'), winner)
  console.log(
    `[gepa-analyst] optimize done in ${((Date.now() - started) / 60_000).toFixed(1)}min ` +
      `evaluations=${result.provenance?.evaluationCount} winnerSha=${winnerSha256}`,
  )

  // ── Selection comparison: harvest judged scores from the ledger; score any
  //    missing (surface, scenario) pair directly through the same dispatch +
  //    judge. ──

  const { readFileSync } = await import('node:fs')
  const harvest = new Map<string, number>()
  for (const line of readFileSync(SCORE_LEDGER_PATH, 'utf8').split('\n')) {
    if (!line.trim()) continue
    const row = JSON.parse(line) as { scenarioId: string; surfaceSha256: string; composite: number }
    harvest.set(`${row.surfaceSha256}:${row.scenarioId}`, row.composite)
  }
  const scoreDirect = async (surface: string, scenario: GepaAnalystScenario): Promise<number> => {
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
    return verdict.composite
  }
  const comparison: Array<{
    scenarioId: string
    baseline: number
    winner: number
    delta: number
  }> = []
  for (const scenario of selectionScenarios) {
    let baselineScore = harvest.get(`${baselineSha256}:${scenario.id}`)
    if (baselineScore === undefined) baselineScore = await scoreDirect(BASELINE, scenario)
    let winnerScore = harvest.get(`${winnerSha256}:${scenario.id}`)
    if (winnerScore === undefined) winnerScore = await scoreDirect(winner, scenario)
    comparison.push({
      scenarioId: scenario.id,
      baseline: baselineScore,
      winner: winnerScore,
      delta: winnerScore - baselineScore,
    })
  }
  const mean = (values: number[]) =>
    values.length === 0 ? 0 : values.reduce((total, value) => total + value, 0) / values.length
  const summary = {
    kind: 'agent-eval/gepa-analyst-campaign-summary',
    smoke: SMOKE,
    seed: SEED,
    model: MODEL,
    baseUrl: BASE_URL,
    runDir: RUN_DIR,
    scenarioCounts: {
      prepared: prepared.cases.length,
      positive: positives.length,
      train: trainScenarios.length,
      selection: selectionScenarios.length,
    },
    trainScenarioIds: trainScenarios.map((scenario) => scenario.id),
    selectionScenarioIds: selectionScenarios.map((scenario) => scenario.id),
    maxEvaluations: MAX_EVALUATIONS,
    evaluationsUsed: result.provenance?.evaluationCount,
    baselineSha256,
    winnerSha256,
    winnerChanged: winnerSha256 !== baselineSha256,
    // Macro proxy over the selection split; the benchmark headline is micro.
    selectionComparison: {
      note: 'judge-composite macro means over selection scenarios (paired); NOT the micro benchmark metric',
      n: comparison.length,
      baselineMean: mean(comparison.map((row) => row.baseline)),
      winnerMean: mean(comparison.map((row) => row.winner)),
      deltaMean: mean(comparison.map((row) => row.delta)),
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
    `[gepa-analyst] total ledger cost=$${costLedger.summary().totalCostUsd.toFixed(4)} ` +
      `summary=${join(RUN_DIR, 'summary.json')}`,
  )
}

main().catch((error) => {
  console.error('[gepa-analyst] FAILED:', error)
  process.exitCode = 1
})
