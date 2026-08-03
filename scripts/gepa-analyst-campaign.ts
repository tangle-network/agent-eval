/**
 * GEPA campaign over the recursive CodeTraceBench analyst instructions.
 *
 * Surface: the full RLM instruction string. The output-contract block (the
 * subject grammar and block caps) is frozen: a candidate that does not contain
 * it verbatim as its final section scores 0 without spending a model call,
 * because a rewritten contract breaks the subject encoding and produces
 * parse-zero scores that are indistinguishable from bad analysis.
 *
 * Two scenario sources, selected by `--scenario-family`:
 *
 * Default (mini-SWE, round 2): the SPENT dev-32 and holdout-1 pools
 * (32 labeled-positive scenarios), stratified by gold-block width, scored by
 * the judge composite multiplied by the case's gold-mass weight.
 *
 * `--scenario-family oht2` (round 3): the TUNING-LEGAL OpenHands + Terminus2
 * dev pools. Labeled-positive rows only, both families mixed, per-family
 * seeded sample: 12 train + 8 selection per family (24 train / 16 selection,
 * disjoint). The selected traj_ids are GEPA-SPENT and recorded in a committed
 * split-plan (`benchmarks/trace-analysis/oht2-family-gepa-20260803/`);
 * certification cuts must exclude them, and every run re-derives the split and
 * refuses to start if it drifts from the committed plan. The score is the
 * plain per-case judge composite (f1 averaged with critical-step accuracy when
 * defined) with no gold-mass weighting; selection readouts report plain macro
 * and pooled micro side by side. `--recipe engine` (default) runs one bounded
 * GEPA engine; `--recipe omni` runs GEPA's official Omni composition
 * (two explore stages, then a continuation seeded by the explore winner) on
 * the same total evaluation budget — Omni requires the GEPA source venv
 * (`.venv-gepa-source`).
 *
 * Every training or selection evaluation returns per-case TP/FP/FN counts and
 * missed issue ids through the artifact evidence, so reflection sees the count
 * structure behind each scalar.
 *
 * Usage:
 *   # family split plan only, no spend, no venvs needed:
 *   pnpm exec tsx scripts/gepa-analyst-campaign.ts --scenario-family oht2 --plan
 *   # family smoke (3 scenarios, 3 evaluations, real provider — take the
 *   # measurement mutex first):
 *   until mkdir /tmp/ctb-llm-mutex.lock 2>/dev/null; do sleep 20; done; \
 *     trap 'rmdir /tmp/ctb-llm-mutex.lock' EXIT; \
 *     ZAI_GLM_API_KEY=... pnpm exec tsx scripts/gepa-analyst-campaign.ts \
 *       --scenario-family oht2 --smoke
 *   # full family run, detached, with archival on completion:
 *   setsid nohup bash -c 'until mkdir /tmp/ctb-llm-mutex.lock 2>/dev/null; do sleep 20; done; \
 *     trap "rmdir /tmp/ctb-llm-mutex.lock" EXIT; \
 *     ZAI_GLM_API_KEY=... pnpm exec tsx scripts/gepa-analyst-campaign.ts --scenario-family oht2; \
 *     rsync -a /dev/shm/mp-tg3-gepa-family-engine/ ~/bench-cache/ctb-20260801/gepa-family-engine/' \
 *     > /dev/shm/mp-tg3-gepa-family-engine.log 2>&1 &
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AnalystBenchmarkCase } from '../src/analyst/benchmark'
import type { AnalystIssueExpectation } from '../src/analyst/benchmark'
import { scoreAnalystFindings } from '../src/analyst/benchmark'
import { codeTraceBenchCase, type CodeTraceBenchRow } from '../src/analyst/benchmark-datasets'
import { adaptPublicBenchmarkFindings } from '../src/analyst/benchmark-public-adapters'
import {
  CODE_TRACE_BENCH_ANALYST_PROMPT,
  publicBenchmarkRlmInstructions,
} from '../src/analyst/benchmark-public-prompt'
import {
  loadPublicBenchmarkRows,
  preparePublicAnalystBenchmark,
} from '../src/analyst/benchmark-public-data'
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
import type {
  GepaEngineRun,
  GepaOptimizationRecipe,
} from '../src/campaign/gepa-optimization-method'
import { gepaOptimizationMethod } from '../src/campaign/gepa-optimization-method'
import type {
  OptimizationMethodInput,
  OptimizationMethodRunOptions,
} from '../src/campaign/presets/compare-optimization-methods'
import { createRunCostLedger, fsCampaignStorage } from '../src/campaign/storage'
import type { DispatchContext, JudgeConfig, MutableSurface, Scenario } from '../src/campaign/types'
import type { TraceAnalysisStore } from '../src/trace-analyst/store'
import { loadOptimizerExecutionOwner } from '../examples/_shared/optimizer-execution-owner'

// ── Configuration ─────────────────────────────────────────────────────

const SMOKE = process.argv.includes('--smoke')
const PLAN_ONLY = process.argv.includes('--plan')
const RUN_DIR_ARG = argValue('--run-dir')
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const FAMILY_ARG = argValue('--scenario-family')
if (FAMILY_ARG !== undefined && FAMILY_ARG !== 'oht2') {
  throw new Error(`--scenario-family supports only 'oht2', received '${FAMILY_ARG}'`)
}
const FAMILY = FAMILY_ARG === 'oht2'
const RECIPE_ARG = argValue('--recipe')
if (RECIPE_ARG !== undefined && !FAMILY) {
  throw new Error('--recipe requires --scenario-family oht2')
}
if (RECIPE_ARG !== undefined && RECIPE_ARG !== 'engine' && RECIPE_ARG !== 'omni') {
  throw new Error(`--recipe supports 'engine' or 'omni', received '${RECIPE_ARG}'`)
}
const RECIPE_KIND: 'engine' | 'omni' = RECIPE_ARG === 'omni' ? 'omni' : 'engine'

const RUN_DIR =
  RUN_DIR_ARG ??
  (FAMILY
    ? `/dev/shm/mp-tg3-gepa-family-${RECIPE_KIND}${SMOKE ? '-smoke' : ''}`
    : SMOKE
      ? '/dev/shm/mp-tg2-gepa-r2-smoke'
      : '/dev/shm/mp-tg2-gepa-r2')
const ROUND = FAMILY ? 3 : 2
const SEED = FAMILY ? 31 : 23
const MODEL = 'glm-5.2'
const BASE_URL = 'https://api.z.ai/api/coding/paas/v4'
const PRICING = { inputUsdPerMillion: 0.6, outputUsdPerMillion: 2.2 }
const EVALUATIONS_OVERRIDE = argValue('--max-evaluations')
const MAX_EVALUATIONS = EVALUATIONS_OVERRIDE
  ? Number.parseInt(EVALUATIONS_OVERRIDE, 10)
  : SMOKE
    ? 3
    : FAMILY
      ? 50
      : 60
const COST_CEILING_USD = SMOKE ? 3 : 20
const MAX_PROPOSER_COST_USD = SMOKE ? 1 : 5
const GEPA_TIMEOUT_MS = SMOKE ? 3_600_000 : 28_800_000
const ANALYSIS_TIMEOUT_MS = 1_200_000
const EVAL_COST_PHASE = 'gepa.analyst-evaluation'
/**
 * Concurrent analyses cap. The z.ai glm seat starts returning 429s at ~5
 * concurrent requests (measured), so the family campaign runs at most 3
 * evaluations in flight; the mini-SWE round stays strictly serial.
 */
const EVAL_CONCURRENCY = FAMILY ? 3 : 1
const DSPY_PYTHON = join(ROOT, 'clients/python/.venv/bin/python')
/** Omni needs GEPA's official composition functions, present only in the source venv. */
const GEPA_PYTHON = join(
  ROOT,
  FAMILY && RECIPE_KIND === 'omni'
    ? 'clients/python/.venv-gepa-source/bin/python'
    : 'clients/python/.venv-gepa/bin/python',
)
const GEPA_VENV_HINT =
  FAMILY && RECIPE_KIND === 'omni'
    ? 'cd clients/python && UV_PROJECT_ENVIRONMENT=.venv-gepa-source uv sync --frozen --group gepa-source'
    : 'cd clients/python && UV_PROJECT_ENVIRONMENT=.venv-gepa uv sync --frozen --group gepa-release'

/** Spent mini-SWE pools. Both are training-legal and certification-illegal. */
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

/**
 * TUNING-LEGAL family dev pools. The /dev/shm labels are the primaries; the
 * bench-cache copies are byte-identical durable backups for restoring them.
 * Rows selected into the split become GEPA-SPENT.
 */
const FAMILY_POOLS = [
  {
    name: 'openhands',
    labelsPath: '/dev/shm/ctb-openhands-dev-labels.json',
    durableLabelsPath: join(homedir(), 'bench-cache/ctb-20260801/oht2/ctb-openhands-dev-labels.json'),
    traceDir: '/dev/shm/ctb-oht2-traces-openhands',
    artifactDir: join(homedir(), 'bench-cache/ctb-20260801/oht2/work/openhands/extracted'),
  },
  {
    name: 'terminus2',
    labelsPath: '/dev/shm/ctb-terminus2-dev-labels.json',
    durableLabelsPath: join(homedir(), 'bench-cache/ctb-20260801/oht2/ctb-terminus2-dev-labels.json'),
    traceDir: '/dev/shm/ctb-oht2-traces-terminus2',
    artifactDir: join(homedir(), 'bench-cache/ctb-20260801/oht2/work/terminus2/extracted'),
  },
] as const
const FAMILY_TRAIN_PER_FAMILY = 12
const FAMILY_SELECTION_PER_FAMILY = 8
/** Committed record of the GEPA-SPENT rows; runs refuse to start on drift. */
const FAMILY_SPLIT_PLAN_PATH = join(
  ROOT,
  'benchmarks/trace-analysis/oht2-family-gepa-20260803/split-plan.json',
)

/** A gold block of >= this many contiguous incorrect steps counts as wide. */
const WIDE_MIN_BLOCK_WIDTH = 3
const SELECTION_TOTAL = 12

const API_KEY = process.env.ZAI_GLM_API_KEY?.trim()
if (!API_KEY && !PLAN_ONLY) throw new Error('ZAI_GLM_API_KEY is required')

// ── Frozen output contract ────────────────────────────────────────────

const BASELINE = publicBenchmarkRlmInstructions('codetracebench')
if (!BASELINE.startsWith(`${CODE_TRACE_BENCH_ANALYST_PROMPT}\n`)) {
  throw new Error('baseline instructions no longer compose as policy + contract')
}
const CONTRACT_BLOCK = BASELINE.slice(CODE_TRACE_BENCH_ANALYST_PROMPT.length + 1)
if (!CONTRACT_BLOCK.trim() || `${CODE_TRACE_BENCH_ANALYST_PROMPT}\n${CONTRACT_BLOCK}` !== BASELINE) {
  throw new Error('frozen contract block extraction failed')
}

// ── Scenarios (JSON-safe: the optimizer bridge serializes them, so live
//    trace stores are resolved by scenario id inside the dispatch) ──

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

interface PoolProvenance {
  name: string
  labelsPath: string
  labelsSha256: string
  filteredLabelsPath?: string
  filteredLabelsSha256?: string
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

// ── Family split: labeled-positive rows only, per-family seeded sample ──

interface FamilyPlanRow {
  trajId: string
  family: string
  goldMass: number
  maxBlockWidth: number
  stratum: 'wide' | 'narrow'
}

interface FamilyPoolSplit {
  name: string
  labelsPath: string
  labelsSha256: string
  durableLabelsPath: string
  rowCount: number
  positiveCount: number
  train: FamilyPlanRow[]
  selection: FamilyPlanRow[]
  rowsByTrajId: Map<string, Record<string, unknown>>
}

async function computeFamilySplit(): Promise<FamilyPoolSplit[]> {
  const pools: FamilyPoolSplit[] = []
  for (const [poolIndex, pool] of FAMILY_POOLS.entries()) {
    const labelsSha256 = sha256Digest(readFileSync(pool.labelsPath, 'utf8'))
    const rows = await loadPublicBenchmarkRows(pool.labelsPath)
    const rowsByTrajId = new Map<string, Record<string, unknown>>()
    const positives: FamilyPlanRow[] = []
    for (const row of rows) {
      const benchmarkCase = codeTraceBenchCase(row as unknown as CodeTraceBenchRow, undefined)
      const trajId = String(row.traj_id)
      rowsByTrajId.set(trajId, row)
      if (benchmarkCase.labelState !== 'positive') continue
      const maxBlockWidth = Math.max(...goldBlockWidths(benchmarkCase.expectedIssues))
      positives.push({
        trajId,
        family: pool.name,
        goldMass: benchmarkCase.expectedIssues.length,
        maxBlockWidth,
        stratum: maxBlockWidth >= WIDE_MIN_BLOCK_WIDTH ? 'wide' : 'narrow',
      })
    }
    const needed = FAMILY_TRAIN_PER_FAMILY + FAMILY_SELECTION_PER_FAMILY
    if (positives.length < needed) {
      throw new Error(
        `family pool '${pool.name}' has ${positives.length} labeled-positive rows; need ${needed}`,
      )
    }
    positives.sort((left, right) => left.trajId.localeCompare(right.trajId))
    const shuffled = seededShuffle(positives, SEED + poolIndex)
    pools.push({
      name: pool.name,
      labelsPath: pool.labelsPath,
      labelsSha256,
      durableLabelsPath: pool.durableLabelsPath,
      rowCount: rows.length,
      positiveCount: positives.length,
      selection: shuffled.slice(0, FAMILY_SELECTION_PER_FAMILY),
      train: shuffled.slice(
        FAMILY_SELECTION_PER_FAMILY,
        FAMILY_SELECTION_PER_FAMILY + FAMILY_TRAIN_PER_FAMILY,
      ),
      rowsByTrajId,
    })
  }
  return pools
}

function familySplitPlanDocument(pools: readonly FamilyPoolSplit[]): Record<string, unknown> {
  return {
    kind: 'agent-eval/gepa-analyst-family-split-plan',
    round: ROUND,
    scenarioFamily: 'oht2',
    seed: SEED,
    metric:
      'plain per-case judge composite (f1 averaged with critical-step accuracy when defined); no gold-mass weighting',
    spent:
      'Every traj_id under train and selection is GEPA-SPENT: certification splits must exclude these rows.',
    trainPerFamily: FAMILY_TRAIN_PER_FAMILY,
    selectionPerFamily: FAMILY_SELECTION_PER_FAMILY,
    pools: pools.map((pool) => ({
      name: pool.name,
      labelsPath: pool.labelsPath,
      labelsSha256: pool.labelsSha256,
      durableLabelsPath: pool.durableLabelsPath,
      rowCount: pool.rowCount,
      positiveCount: pool.positiveCount,
    })),
    train: pools.flatMap((pool) => pool.train),
    selection: pools.flatMap((pool) => pool.selection),
  }
}

/** The identity of a split: seed, source label digests, exact traj_id order. */
function familySplitProjection(plan: Record<string, unknown>): string {
  const pools = (plan.pools as Array<Record<string, unknown>>).map((pool) => ({
    name: pool.name,
    labelsSha256: pool.labelsSha256,
  }))
  const ids = (rows: unknown) =>
    (rows as Array<Record<string, unknown>>).map((row) => `${row.family}:${row.trajId}`)
  return JSON.stringify({
    seed: plan.seed,
    trainPerFamily: plan.trainPerFamily,
    selectionPerFamily: plan.selectionPerFamily,
    pools,
    train: ids(plan.train),
    selection: ids(plan.selection),
  })
}

function verifyCommittedFamilySplitPlan(computed: Record<string, unknown>): void {
  if (!existsSync(FAMILY_SPLIT_PLAN_PATH)) {
    throw new Error(
      `committed family split plan is missing at ${FAMILY_SPLIT_PLAN_PATH} — ` +
        'run --scenario-family oht2 --plan and commit the result before spending',
    )
  }
  const committed = JSON.parse(readFileSync(FAMILY_SPLIT_PLAN_PATH, 'utf8')) as Record<
    string,
    unknown
  >
  if (familySplitProjection(committed) !== familySplitProjection(computed)) {
    throw new Error(
      `family split drifted from the committed plan at ${FAMILY_SPLIT_PLAN_PATH} — ` +
        'the labels, seed, or split constants changed; regenerate with --plan and re-commit deliberately',
    )
  }
}

// ── Score ledger: every judge verdict lands here, keyed by candidate hash,
//    so the selection comparison is harvested without re-running anything. ──

const SCORE_LEDGER_PATH = join(RUN_DIR, 'score-ledger.jsonl')

interface LedgerScoreRow {
  scenarioId: string
  surfaceSha256: string
  /** The signal GEPA optimizes: gold-mass-weighted in round 2, plain in family mode. */
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

  // ── Pool: labeled positives, stratified; family mode splits per family ──

  const scenarios: GepaAnalystScenario[] = []
  const poolProvenance: PoolProvenance[] = []
  let trainScenarios: GepaAnalystScenario[]
  let selectionScenarios: GepaAnalystScenario[]
  let stratification: Record<string, unknown>
  let maxGoldMass: number

  if (FAMILY) {
    const split = await computeFamilySplit()
    const planDocument = familySplitPlanDocument(split)
    if (PLAN_ONLY) {
      mkdirSync(dirname(FAMILY_SPLIT_PLAN_PATH), { recursive: true })
      writeFileSync(FAMILY_SPLIT_PLAN_PATH, `${JSON.stringify(planDocument, null, 2)}\n`)
      writeFileSync(join(RUN_DIR, 'split-plan.json'), `${JSON.stringify(planDocument, null, 2)}\n`)
      console.log(`[gepa-analyst-r${ROUND}] plan-only: wrote ${FAMILY_SPLIT_PLAN_PATH}`)
      return
    }
    verifyCommittedFamilySplitPlan(planDocument)
    writeFileSync(join(RUN_DIR, 'split-plan.json'), `${JSON.stringify(planDocument, null, 2)}\n`)

    // Smoke touches one train + one selection row from openhands and one train
    // row from terminus2 — 3 scenarios, both families, both split roles.
    const activeByPool = new Map<string, { train: FamilyPlanRow[]; selection: FamilyPlanRow[] }>(
      split.map((pool) => [
        pool.name,
        SMOKE
          ? {
              train: [pool.train[0]!],
              selection: pool.name === 'openhands' ? [pool.selection[0]!] : [],
            }
          : { train: [...pool.train], selection: [...pool.selection] },
      ]),
    )

    const scenarioByTrajId = new Map<string, GepaAnalystScenario>()
    for (const pool of split) {
      const active = activeByPool.get(pool.name)!
      const activeRows = [...active.train, ...active.selection]
      if (activeRows.length === 0) continue
      const filteredLabelsPath = join(RUN_DIR, 'pool-labels', `${pool.name}.json`)
      mkdirSync(dirname(filteredLabelsPath), { recursive: true })
      writeFileSync(
        filteredLabelsPath,
        `${JSON.stringify(
          activeRows.map((row) => {
            const source = pool.rowsByTrajId.get(row.trajId)
            if (!source) throw new Error(`family pool '${pool.name}' lost row '${row.trajId}'`)
            return source
          }),
          null,
          2,
        )}\n`,
      )
      const poolConfig = FAMILY_POOLS.find((candidate) => candidate.name === pool.name)!
      const prepared = await preparePublicAnalystBenchmark({
        dataset: 'codetracebench',
        labelsPath: filteredLabelsPath,
        traceDir: poolConfig.traceDir,
        artifactDir: poolConfig.artifactDir,
        limit: activeRows.length,
        seed: 0,
      })
      if (prepared.cases.length !== activeRows.length) {
        throw new Error(
          `family pool '${pool.name}' prepared ${prepared.cases.length} cases for ${activeRows.length} rows`,
        )
      }
      poolProvenance.push({
        name: pool.name,
        labelsPath: pool.labelsPath,
        labelsSha256: pool.labelsSha256,
        filteredLabelsPath,
        filteredLabelsSha256: prepared.labelsSha256,
      })
      for (const benchmarkCase of prepared.cases) {
        if (benchmarkCase.labelState !== 'positive') {
          throw new Error(`family case '${benchmarkCase.id}' is not labeled positive`)
        }
        if (!benchmarkCase.input.traceStore) {
          throw new Error(`prepared case '${benchmarkCase.id}' has no trace store`)
        }
        if (storesById.has(benchmarkCase.id)) {
          throw new Error(`scenario '${benchmarkCase.id}' appears in more than one pool`)
        }
        storesById.set(benchmarkCase.id, benchmarkCase.input.traceStore)
        const trajId = benchmarkCase.id.replace(/^codetrace:/, '')
        const planRow = activeRows.find((row) => row.trajId === trajId)
        if (!planRow) throw new Error(`prepared case '${benchmarkCase.id}' is not in the split plan`)
        const scenario: GepaAnalystScenario = {
          id: benchmarkCase.id,
          kind: 'trace-analyst',
          labelState: 'positive',
          pool: pool.name,
          trajectoryId: trajId,
          expectedIssues: [...benchmarkCase.expectedIssues],
          ...(benchmarkCase.labeledEvidence
            ? { labeledEvidence: [...benchmarkCase.labeledEvidence] }
            : {}),
          goldMass: planRow.goldMass,
          maxBlockWidth: planRow.maxBlockWidth,
          stratum: planRow.stratum,
        }
        scenarios.push(scenario)
        scenarioByTrajId.set(trajId, scenario)
      }
    }
    const resolveScenarios = (rows: readonly FamilyPlanRow[]) =>
      rows.map((row) => {
        const scenario = scenarioByTrajId.get(row.trajId)
        if (!scenario) throw new Error(`no prepared scenario for planned row '${row.trajId}'`)
        return scenario
      })
    const plannedTrain = split.flatMap((pool) => activeByPool.get(pool.name)!.train)
    const plannedSelection = split.flatMap((pool) => activeByPool.get(pool.name)!.selection)
    trainScenarios = SMOKE
      ? resolveScenarios(plannedTrain)
      : seededShuffle(resolveScenarios(plannedTrain), SEED + 2)
    selectionScenarios = SMOKE
      ? resolveScenarios(plannedSelection)
      : seededShuffle(resolveScenarios(plannedSelection), SEED + 3)
    maxGoldMass = Math.max(...scenarios.map((scenario) => scenario.goldMass))
    const describeFamilySplit = (splitScenarios: readonly GepaAnalystScenario[]) => ({
      n: splitScenarios.length,
      wide: splitScenarios.filter((scenario) => scenario.stratum === 'wide').length,
      narrow: splitScenarios.filter((scenario) => scenario.stratum === 'narrow').length,
      byFamily: Object.fromEntries(
        split.map((pool) => [
          pool.name,
          splitScenarios.filter((scenario) => scenario.pool === pool.name).length,
        ]),
      ),
      goldMass: splitScenarios.reduce((total, scenario) => total + scenario.goldMass, 0),
    })
    stratification = {
      scheme: 'per-family seeded sample over labeled-positive rows',
      trainPerFamily: FAMILY_TRAIN_PER_FAMILY,
      selectionPerFamily: FAMILY_SELECTION_PER_FAMILY,
      pools: split.map((pool) => ({
        name: pool.name,
        rowCount: pool.rowCount,
        positiveCount: pool.positiveCount,
      })),
      train: describeFamilySplit(trainScenarios),
      selection: describeFamilySplit(selectionScenarios),
    }
  } else {
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
      throw new Error(
        `expected 32 labeled-positive scenarios across pools, found ${scenarios.length}`,
      )
    }
    maxGoldMass = Math.max(...scenarios.map((scenario) => scenario.goldMass))

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
    trainScenarios = SMOKE
      ? [wide[selectionWide]!, narrow[selectionNarrow]!]
      : seededShuffle(fullTrain, SEED + 2)
    selectionScenarios = SMOKE ? [fullSelection[0]!] : seededShuffle(fullSelection, SEED + 3)
    const describeSplit = (split: readonly GepaAnalystScenario[]) => ({
      n: split.length,
      wide: split.filter((scenario) => scenario.stratum === 'wide').length,
      narrow: split.filter((scenario) => scenario.stratum === 'narrow').length,
      dev32: split.filter((scenario) => scenario.pool === 'dev32').length,
      holdout1: split.filter((scenario) => scenario.pool === 'holdout1').length,
      goldMass: split.reduce((total, scenario) => total + scenario.goldMass, 0),
    })
    stratification = {
      wideMinBlockWidth: WIDE_MIN_BLOCK_WIDTH,
      pool: describeSplit(scenarios),
      train: describeSplit(trainScenarios),
      selection: describeSplit(selectionScenarios),
      maxGoldMass,
    }

    if (PLAN_ONLY) {
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
      console.log(`[gepa-analyst-r${ROUND}] plan-only: wrote ${join(RUN_DIR, 'split-plan.json')}`)
      return
    }
  }
  console.log(`[gepa-analyst-r${ROUND}] stratification ${JSON.stringify(stratification)}`)

  /**
   * Round 2 weights the composite by gold mass so the optimized mean tracks
   * micro-F1. The family campaign scores the plain per-case composite: every
   * case counts equally, and the weight is identically 1.
   */
  const goldMassWeight = FAMILY
    ? () => 1
    : (scenario: Pick<GepaAnalystScenario, 'goldMass'>) => scenario.goldMass / maxGoldMass

  if (!existsSync(DSPY_PYTHON)) {
    throw new Error(
      `${DSPY_PYTHON} is missing — run: cd clients/python && uv sync --frozen --extra dspy`,
    )
  }
  if (!existsSync(GEPA_PYTHON)) {
    throw new Error(`${GEPA_PYTHON} is missing — run: ${GEPA_VENV_HINT}`)
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

  // ── GEPA method ─────────────────────────────────────────────────────

  const optimizerExecution = await loadOptimizerExecutionOwner(MODEL)

  const round2Objective =
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
    'verbatim scores 0 without being executed. Edit only the policy text above the contract.'
  const familyObjective =
    'Rewrite the analysis policy of a recursive coding-trace analyst so it localizes every ' +
    'incorrect assistant step (contiguous failure blocks) in long OpenHands and Terminus2 ' +
    'trajectories (median 48 steps, roughly double the trajectories the current policy was ' +
    'tuned on). Per case, the quality score is the harmonic mean of labeled-issue recall ' +
    'and finding precision, averaged with critical-step accuracy when defined; the ' +
    'optimized signal is the plain mean of that per-case score — every case counts ' +
    'equally. Measured failure profile of the current policy on these agent families: ' +
    '(1) mislocalization dominates — nearly half the labeled gold mass is missed with ' +
    'every citation more than 2 steps away, yet crediting the existing citations at any ' +
    'distance would roughly double the score, so the analyst finds real incidents but ' +
    'reports the wrong steps; (2) under-enumeration — about 1.6 predicted blocks per run ' +
    'against about 3.0 labeled blocks per case, capping recall near 55% before any ' +
    'localization error; (3) early anchoring — predictions sit earlier in the trajectory ' +
    'than the labels (predicted start fraction p50 about 0.5 versus gold about 0.67): the ' +
    'analyst commits to the first convincing incident and never reaches the mid-late ' +
    'segment where the labels live. Evaluation evidence carries per-case counts (tp = ' +
    'labeled issues matched, fp = findings tied to no labeled issue, fn = labeled issues ' +
    'missed) plus the missed issue ids: use the counts, not just the scalar, to decide ' +
    'what to change. The candidate is the complete instruction string: an analysis policy ' +
    'followed by a fixed output contract. The output-contract block must be preserved ' +
    'BYTE-IDENTICAL as the final section of the candidate — it defines the machine-parsed ' +
    'subject grammar (incorrect-steps-<first>-<last>-<escape>-consequence-<n>) and the ' +
    'block caps, and any candidate missing it verbatim scores 0 without being executed. ' +
    'Edit only the policy text above the contract.'

  const engineRun = (maxEvaluations: number, runSeed: number): GepaEngineRun => ({
    engine: 'gepa',
    maxEvaluations,
    maxProposerCostUsd: MAX_PROPOSER_COST_USD,
    maxConcurrency: EVAL_CONCURRENCY,
    engineConfig: {
      engine: {
        capture_stdio: false,
        max_workers: EVAL_CONCURRENCY,
        parallel: EVAL_CONCURRENCY > 1,
        raise_on_exception: true,
        seed: runSeed,
      },
      reflection: { reflection_minibatch_size: 3, skip_perfect_score: false },
    },
  })
  let recipe: GepaOptimizationRecipe
  if (FAMILY && RECIPE_KIND === 'omni') {
    // Same total evaluation budget as the engine recipe, split across GEPA's
    // official Omni composition: two explore stages then a continuation that
    // starts from the explore winner. maxWorkers 1 keeps the explore stages
    // sequential so the global concurrency cap stays at EVAL_CONCURRENCY.
    const exploreEvaluations = Math.max(1, Math.round(MAX_EVALUATIONS * 0.24))
    const continueEvaluations = MAX_EVALUATIONS - 2 * exploreEvaluations
    if (continueEvaluations < 1) {
      throw new Error(
        `--max-evaluations ${MAX_EVALUATIONS} cannot fund the omni recipe (needs 2 explore stages + a continuation)`,
      )
    }
    recipe = {
      kind: 'omni',
      explore: [
        engineRun(exploreEvaluations, SEED + 101),
        engineRun(exploreEvaluations, SEED + 102),
      ],
      continueWith: engineRun(continueEvaluations, SEED + 103),
      maxWorkers: 1,
    }
  } else {
    recipe = { kind: 'engine', run: engineRun(MAX_EVALUATIONS, SEED) }
  }

  const method = gepaOptimizationMethod<GepaAnalystScenario, GepaAnalystArtifact>({
    name: FAMILY ? `gepa-analyst-family-r3-${RECIPE_KIND}` : 'gepa-analyst-policy-r2',
    objective: FAMILY ? familyObjective : round2Objective,
    background:
      `The frozen output contract (must appear verbatim at the end of every candidate):\n` +
      `${CONTRACT_BLOCK}`,
    evaluationId: FAMILY
      ? 'codetracebench-analyst-instructions-r3-oht2'
      : 'codetracebench-analyst-instructions-r2',
    recipe,
    optimizer: {
      model: MODEL,
      ...optimizerExecution,
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
      pool: scenario.pool,
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

  console.log(
    `[gepa-analyst-r${ROUND}] starting GEPA: recipe=${recipe.kind} ` +
      `maxEvaluations=${MAX_EVALUATIONS} concurrency=${EVAL_CONCURRENCY} runDir=${RUN_DIR}`,
  )
  const started = Date.now()
  const result = await method.optimize(input)
  const winner = result.winnerSurface
  if (typeof winner !== 'string') throw new Error('winner surface is not a string')
  const winnerSha256 = sha256Digest(winner)
  const baselineSha256 = sha256Digest(BASELINE)
  writeFileSync(join(RUN_DIR, 'winner-instructions.txt'), winner)
  console.log(
    `[gepa-analyst-r${ROUND}] optimize done in ${((Date.now() - started) / 60_000).toFixed(1)}min ` +
      `evaluations=${result.provenance?.evaluationCount} winnerSha=${winnerSha256}`,
  )

  // ── Selection comparison: harvest judged scores from the ledger; score any
  //    missing (surface, scenario) pair directly through the same dispatch +
  //    judge. Reports the optimized metric alongside the plain macro
  //    composite, plain macro f1, and pooled micro f1, plus a per-pool
  //    breakdown so family results are readable per agent family. ──

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
    pool: string
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
      pool: scenario.pool,
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
  const comparisonBlock = (rows: readonly (typeof comparison)[number][]) => ({
    n: rows.length,
    weighted: {
      baselineMean: mean(rows.map((row) => row.baseline.weighted)),
      winnerMean: mean(rows.map((row) => row.winner.weighted)),
      deltaMean: mean(rows.map((row) => row.deltaWeighted)),
    },
    plainMacroComposite: {
      baselineMean: mean(rows.map((row) => row.baseline.rawComposite)),
      winnerMean: mean(rows.map((row) => row.winner.rawComposite)),
      deltaMean: mean(rows.map((row) => row.deltaRaw)),
    },
    plainMacroF1: {
      baselineMean: mean(rows.map((row) => row.baseline.f1)),
      winnerMean: mean(rows.map((row) => row.winner.f1)),
      deltaMean: mean(rows.map((row) => row.deltaF1)),
    },
    microF1: {
      baseline: microFromCounts(rows.map((row) => row.baseline.counts)),
      winner: microFromCounts(rows.map((row) => row.winner.counts)),
    },
  })
  const selectionPools = [...new Set(selectionScenarios.map((scenario) => scenario.pool))]
  const summary = {
    kind: 'agent-eval/gepa-analyst-campaign-summary',
    round: ROUND,
    scenarioFamily: FAMILY ? 'oht2' : null,
    recipeKind: recipe.kind,
    smoke: SMOKE,
    seed: SEED,
    model: MODEL,
    baseUrl: BASE_URL,
    runDir: RUN_DIR,
    ...(FAMILY ? { splitPlanPath: FAMILY_SPLIT_PLAN_PATH } : {}),
    pools: poolProvenance,
    stratification,
    scenarioCounts: {
      pool: scenarios.length,
      train: trainScenarios.length,
      selection: selectionScenarios.length,
    },
    trainScenarioIds: trainScenarios.map((scenario) => scenario.id),
    selectionScenarioIds: selectionScenarios.map((scenario) => scenario.id),
    weighting: FAMILY
      ? { scheme: 'none — plain per-case judge composite (weight identically 1)' }
      : {
          scheme: 'goldMass / maxGoldMass over the full 32-scenario pool',
          maxGoldMass,
          perScenario: Object.fromEntries(
            scenarios.map((scenario) => [scenario.id, goldMassWeight(scenario)]),
          ),
        },
    maxEvaluations: MAX_EVALUATIONS,
    evaluationsUsed: result.provenance?.evaluationCount,
    evalConcurrency: EVAL_CONCURRENCY,
    baselineSha256,
    winnerSha256,
    winnerChanged: winnerSha256 !== baselineSha256,
    // All metrics below are over the (spent) selection split; none certify.
    selectionComparison: {
      note:
        'paired per-scenario metrics over the selection split. weighted = the signal GEPA ' +
        'optimized (gold-mass-weighted judge composite in round 2; identical to the plain ' +
        'composite in family mode); plainMacroComposite = unweighted judge composite; ' +
        'plainMacroF1 = mean per-scenario f1; microF1 = pooled per-step counts. Weighted ' +
        'and plain metrics are different quantities — never compare one arm on weighted ' +
        'against another on plain.',
      ...comparisonBlock(comparison),
      perPool: Object.fromEntries(
        selectionPools.map((pool) => [
          pool,
          comparisonBlock(comparison.filter((row) => row.pool === pool)),
        ]),
      ),
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
    `[gepa-analyst-r${ROUND}] total ledger cost=$${costLedger.summary().totalCostUsd.toFixed(4)} ` +
      `summary=${join(RUN_DIR, 'summary.json')}`,
  )
}

main().catch((error) => {
  console.error('[gepa-analyst] FAILED:', error)
  process.exitCode = 1
})
