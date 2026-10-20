/** Campaign flags, paths, budgets, and frozen output-contract validation. */
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CODE_TRACE_BENCH_ANALYST_PROMPT,
  publicBenchmarkRlmInstructions,
} from '../../src/analyst/benchmark-public-prompt'

export const SMOKE = process.argv.includes('--smoke')
export const PLAN_ONLY = process.argv.includes('--plan')
export const RUN_DIR_ARG = argValue('--run-dir')
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

export const FAMILY_ARG = argValue('--scenario-family')
if (FAMILY_ARG !== undefined && FAMILY_ARG !== 'oht2') {
  throw new Error(`--scenario-family supports only 'oht2', received '${FAMILY_ARG}'`)
}
export const FAMILY = FAMILY_ARG === 'oht2'
export const RECIPE_ARG = argValue('--recipe')
if (RECIPE_ARG !== undefined && !FAMILY) {
  throw new Error('--recipe requires --scenario-family oht2')
}
if (RECIPE_ARG !== undefined && RECIPE_ARG !== 'engine' && RECIPE_ARG !== 'omni') {
  throw new Error(`--recipe supports 'engine' or 'omni', received '${RECIPE_ARG}'`)
}
export const RECIPE_KIND: 'engine' | 'omni' = RECIPE_ARG === 'omni' ? 'omni' : 'engine'

export const RUN_DIR =
  RUN_DIR_ARG ??
  (FAMILY
    ? `/dev/shm/mp-tg3-gepa-family-${RECIPE_KIND}${SMOKE ? '-smoke' : ''}`
    : SMOKE
      ? '/dev/shm/mp-tg2-gepa-r2-smoke'
      : '/dev/shm/mp-tg2-gepa-r2')
export const ROUND = FAMILY ? 3 : 2
export const SEED = FAMILY ? 31 : 23
export const MODEL = 'glm-5.2'
export const BASE_URL = 'https://api.z.ai/api/coding/paas/v4'
export const PRICING = { inputUsdPerMillion: 0.6, outputUsdPerMillion: 2.2 }
export const EVALUATIONS_OVERRIDE = argValue('--max-evaluations')
/** In family mode this is the upstream evaluation target GEPA optimizes with,
 * not the callback's hard cap — see the budget-geometry note at the recipe. */
export const MAX_EVALUATIONS = EVALUATIONS_OVERRIDE
  ? Number.parseInt(EVALUATIONS_OVERRIDE, 10)
  : SMOKE
    ? 3
    : FAMILY
      ? 50
      : 60
// Family analyses run on trajectories roughly twice mini-SWE length, and the
// callback cap intentionally exceeds the upstream target by one iteration
// burst, so the family ceiling carries ~2x headroom over expected spend — a
// runaway guard, not a target.
export const COST_CEILING_USD = SMOKE ? 3 : FAMILY ? 30 : 20
export const MAX_PROPOSER_COST_USD = SMOKE ? 1 : 5
export const GEPA_TIMEOUT_MS = SMOKE ? 3_600_000 : 28_800_000
export const ANALYSIS_TIMEOUT_MS = 1_200_000
export const EVAL_COST_PHASE = 'gepa.analyst-evaluation'
/** GEPA reflection minibatch size; also a term of the budget-overshoot bound. */
export const REFLECTION_MINIBATCH_SIZE = 3
export const DSPY_PYTHON = join(ROOT, 'clients/python/.venv/bin/python')
/** Omni needs GEPA's official composition functions, present only in the source venv. */
export const GEPA_PYTHON = join(
  ROOT,
  FAMILY && RECIPE_KIND === 'omni'
    ? 'clients/python/.venv-gepa-source/bin/python'
    : 'clients/python/.venv-gepa/bin/python',
)
export const GEPA_VENV_HINT =
  FAMILY && RECIPE_KIND === 'omni'
    ? 'cd clients/python && UV_PROJECT_ENVIRONMENT=.venv-gepa-source uv sync --frozen --group gepa-source'
    : 'cd clients/python && UV_PROJECT_ENVIRONMENT=.venv-gepa uv sync --frozen --group gepa-release'

/** Spent mini-SWE pools. Both are training-legal and certification-illegal. */
export const POOLS = [
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
export const FAMILY_POOLS = [
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
export const FAMILY_TRAIN_PER_FAMILY = 12
export const FAMILY_SELECTION_PER_FAMILY = 8
/** Committed record of the GEPA-SPENT rows; runs refuse to start on drift. */
export const FAMILY_SPLIT_PLAN_PATH = join(
  ROOT,
  'benchmarks/trace-analysis/oht2-family-gepa-20260803/split-plan.json',
)

/** A gold block of >= this many contiguous incorrect steps counts as wide. */
export const WIDE_MIN_BLOCK_WIDTH = 3
export const SELECTION_TOTAL = 12

export const API_KEY = process.env.ZAI_GLM_API_KEY?.trim()
if (!API_KEY && !PLAN_ONLY) throw new Error('ZAI_GLM_API_KEY is required')

// ── Frozen output contract ────────────────────────────────────────────

export const BASELINE = publicBenchmarkRlmInstructions('codetracebench')
if (!BASELINE.startsWith(`${CODE_TRACE_BENCH_ANALYST_PROMPT}\n`)) {
  throw new Error('baseline instructions no longer compose as policy + contract')
}
export const CONTRACT_BLOCK = BASELINE.slice(CODE_TRACE_BENCH_ANALYST_PROMPT.length + 1)
if (!CONTRACT_BLOCK.trim() || `${CODE_TRACE_BENCH_ANALYST_PROMPT}\n${CONTRACT_BLOCK}` !== BASELINE) {
  throw new Error('frozen contract block extraction failed')
}

export const SCORE_LEDGER_PATH = join(RUN_DIR, 'score-ledger.jsonl')

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag)
  return index >= 0 ? process.argv[index + 1] : undefined
}
