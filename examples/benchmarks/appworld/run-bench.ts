/**
 * Compare official GEPA and SkillOpt on AppWorld with separate train,
 * selection, and final tasks. AppWorld's world.evaluate() supplies scores.
 *
 * Run (overnight):
 *   export OPENAI_BASE_URL=https://router.tangle.tools/v1 OPENAI_API_KEY=$(cat /tmp/.tk)
 *   APPWORLD_DIR=/tmp/halo-repo/demo/appworld \
 *   BENCH_MODEL=gpt-5-mini TRAIN_N=4 SELECTION_N=4 TEST_N=6 \
 *   pnpm tsx examples/benchmarks/appworld/run-bench.ts > /tmp/appworld-bench/run.log 2>&1
 *
 * Output: a Markdown report and the comparison JSON under OUT_DIR.
 */

import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { z } from 'zod'
import {
  compareOptimizationMethods,
  type DispatchContext,
  gepaOptimizationMethod,
  type JudgeConfig,
  type MutableSurface,
  type OptimizationMethod,
  type Scenario,
  skillOptOptimizationMethod,
} from '../../../src/campaign'
import {
  nonNegativeIntegerEnv,
  nonNegativeNumberEnv,
  positiveIntegerEnv,
  positiveNumberEnv,
  safeIntegerEnv,
  stringEnv,
} from '../../_shared/env'
import { assertMatchedMethodLimits } from '../../_shared/matched-method-limits'
import { optimizerModelBudgetFromEnv } from '../../_shared/optimizer-model-budget'

const execFileAsync = promisify(execFile)

// ── Config (env-overridable so the overnight run can be tuned) ───────────────
const APPWORLD_DIR = stringEnv('APPWORLD_DIR', '/tmp/halo-repo/demo/appworld')
const PYTHON = stringEnv('BENCH_PYTHON', `${APPWORLD_DIR}/.venv/bin/python`)
const OPTIMIZER_PYTHON = stringEnv('OPTIMIZER_PYTHON', 'python')
const HERE = dirname(fileURLToPath(import.meta.url))
const WORKER = join(HERE, 'repl_agent.py')
const MODEL = stringEnv('BENCH_MODEL', 'gpt-5.1')
const GEPA_MODEL = stringEnv('GEPA_MODEL', MODEL)
const SKILLOPT_MODEL = stringEnv('SKILLOPT_MODEL', MODEL)
const BASE_URL = stringEnv('OPENAI_BASE_URL', 'https://router.tangle.tools/v1')
const API_KEY = process.env.OPENAI_API_KEY?.trim() ?? ''
const TRAIN_N = positiveIntegerEnv('TRAIN_N', 3)
const SELECTION_N = positiveIntegerEnv('SELECTION_N', 3)
const TEST_N = positiveIntegerEnv('TEST_N', 5)
const MAX_OPTIMIZER_MODEL_COST_USD = positiveNumberEnv('MAX_OPTIMIZER_MODEL_COST_USD', 5)
const MAX_TOTAL_COST_USD = positiveNumberEnv('MAX_TOTAL_COST_USD', 125)
const GEPA_MAX_PROPOSER_COST_USD = positiveNumberEnv(
  'GEPA_MAX_PROPOSER_COST_USD',
  MAX_OPTIMIZER_MODEL_COST_USD,
)
const SKILLOPT_EPOCHS = positiveIntegerEnv('SKILLOPT_EPOCHS', 1)
const SKILLOPT_BATCH_SIZE = positiveIntegerEnv('SKILLOPT_BATCH_SIZE', 2)
const SKILLOPT_CORE_EVALUATIONS =
  SELECTION_N +
  SKILLOPT_EPOCHS * Math.ceil(TRAIN_N / SKILLOPT_BATCH_SIZE) * (SKILLOPT_BATCH_SIZE + SELECTION_N)
const SKILLOPT_MAX_EVALUATIONS = positiveIntegerEnv(
  'SKILLOPT_MAX_EVALUATIONS',
  SKILLOPT_CORE_EVALUATIONS,
)
const GEPA_MAX_EVALUATIONS = positiveIntegerEnv('GEPA_MAX_EVALUATIONS', SKILLOPT_CORE_EVALUATIONS)
const REPS = positiveIntegerEnv('REPS', 5)
const MAX_STEPS = nonNegativeIntegerEnv('MAX_STEPS', 30)
const MAX_WALL = positiveNumberEnv('MAX_WALL', 900)
const TEMPERATURE = nonNegativeNumberEnv('TEMPERATURE', 0.7)
const MAXCONC = positiveIntegerEnv('MAXCONC', 3)
const OPTIMIZATION_CONCURRENCY = positiveIntegerEnv('OPTIMIZATION_CONCURRENCY', 1)
const CALL_TIMEOUT = positiveNumberEnv('CALL_TIMEOUT', 120)
const MAX_TOKENS = positiveIntegerEnv('MAX_TOKENS', 6000)
const RATE_LIMIT_BUDGET = positiveNumberEnv('RATE_LIMIT_BUDGET', 240)
const OUT_DIR = stringEnv('OUT_DIR', join(tmpdir(), 'appworld-bench'))
const SEED = safeIntegerEnv('SEED', 42)
if (TEMPERATURE > 2) throw new Error('TEMPERATURE must be between 0 and 2')
if (SKILLOPT_MAX_EVALUATIONS < SKILLOPT_CORE_EVALUATIONS) {
  throw new Error(`SKILLOPT_MAX_EVALUATIONS must be at least ${SKILLOPT_CORE_EVALUATIONS}`)
}

interface AppWorldScenario extends Scenario {
  kind: 'appworld'
  taskId: string
}
interface AppWorldArtifact {
  tgc: number
  sgc: number
  completed: boolean
  costUsd: number | null
  inTok: number
  outTok: number
  tracesPath: string
}

const AppWorldResult = z.object({
  tgc: z.number().finite().min(0).max(1),
  sgc: z.number().finite().min(0).max(1),
  completed: z.boolean(),
  cost_usd: z.number().finite().nonnegative().nullable(),
  token_usage: z.object({
    input: z.number().int().nonnegative(),
    output: z.number().int().nonnegative(),
  }),
  traces_path: z.string().min(1),
})

if (!API_KEY) throw new Error('OPENAI_API_KEY must be set (point at the Tangle router)')
mkdirSync(OUT_DIR, { recursive: true })

// BENCH_DIFFICULTY filters AppWorld tasks by difficulty from 1 to 3.
// A capable worker can saturate difficulty 1 and 2, leaving no room to measure lift.
// Difficulty 3 is usually more useful for optimization comparisons.
const BENCH_DIFFICULTY_RAW = process.env.BENCH_DIFFICULTY?.trim()
const BENCH_DIFFICULTY = BENCH_DIFFICULTY_RAW ? Number(BENCH_DIFFICULTY_RAW) : undefined
if (BENCH_DIFFICULTY !== undefined && ![1, 2, 3].includes(BENCH_DIFFICULTY)) {
  throw new Error('BENCH_DIFFICULTY must be 1, 2, or 3')
}
// Draw all three disjoint partitions from this AppWorld split.
// Use train for more difficulty-3 tasks; dev contains only three.
const BENCH_SPLIT = stringEnv('BENCH_SPLIT', 'dev')

/** Load AppWorld task ids deterministically, then take disjoint slices. */
async function loadTaskIds(): Promise<string[]> {
  const { stdout } = await execFileAsync(
    PYTHON,
    [
      '-c',
      'from appworld import load_task_ids; import sys; kwargs = {} if not sys.argv[2] else {"difficulty": int(sys.argv[2])}; print("\\n".join(load_task_ids(sys.argv[1], **kwargs)))',
      BENCH_SPLIT,
      BENCH_DIFFICULTY?.toString() ?? '',
    ],
    { cwd: APPWORLD_DIR, env: process.env, maxBuffer: 8 * 1024 * 1024 },
  )
  return stdout
    .trim()
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
}

let dispatchCount = 0
/** Run ONE AppWorld task with `surface` as the agent's instruction prompt. */
async function dispatchWithSurface(
  surface: MutableSurface,
  scenario: AppWorldScenario,
  ctx: DispatchContext,
): Promise<AppWorldArtifact> {
  if (typeof surface !== 'string') {
    throw new Error('appworld bench: surface must be a string prompt (prompt-tier)')
  }
  const n = dispatchCount++
  const dir = mkdtempSync(join(OUT_DIR, `cell-${scenario.taskId}-`))
  const promptFile = join(dir, 'surface.txt')
  writeFileSync(promptFile, surface)
  const experiment = `bench_${scenario.taskId}_${n}` // unique → no AppWorld output-dir collision
  const paid = await ctx.cost.runPaidCall({
    actor: 'appworld-worker',
    model: MODEL,
    execute: async (signal) => {
      await execFileAsync(
        PYTHON,
        [
          WORKER,
          '--task-id',
          scenario.taskId,
          '--model',
          MODEL,
          '--system-prompt-file',
          promptFile,
          '--experiment-name',
          experiment,
          '--max-steps',
          String(MAX_STEPS),
          '--max-wall-seconds',
          String(MAX_WALL),
          '--temperature',
          String(TEMPERATURE),
          '--seed',
          String(SEED + n),
          '--call-timeout',
          String(CALL_TIMEOUT),
          '--max-tokens',
          String(MAX_TOKENS),
          '--rate-limit-budget',
          String(RATE_LIMIT_BUDGET),
          '--out-dir',
          dir,
        ],
        {
          cwd: APPWORLD_DIR,
          env: { ...process.env, OPENAI_BASE_URL: BASE_URL, OPENAI_API_KEY: API_KEY },
          maxBuffer: 64 * 1024 * 1024,
          signal,
        },
      )
      return AppWorldResult.parse(JSON.parse(readFileSync(join(dir, 'result.json'), 'utf8')))
    },
    receipt: (result) => {
      const usage = {
        model: MODEL,
        inputTokens: result.token_usage.input,
        outputTokens: result.token_usage.output,
      }
      return result.cost_usd === null
        ? { ...usage, costUnknown: true }
        : { ...usage, actualCostUsd: result.cost_usd }
    },
  })
  if (!paid.succeeded) throw paid.error
  const result = paid.value
  const inTok = result.token_usage.input
  const outTok = result.token_usage.output
  return {
    tgc: result.tgc,
    sgc: result.sgc,
    completed: result.completed,
    costUsd: result.cost_usd,
    inTok,
    outTok,
    tracesPath: result.traces_path,
  }
}

/** Objective judge: composite = 0.5·TGC + 0.5·SGC (task-goal + scenario-goal completion). */
const appworldJudge: JudgeConfig<AppWorldArtifact, AppWorldScenario> = {
  name: 'appworld-eval',
  dimensions: [
    { key: 'tgc', description: 'task goal completion (1 if the whole task passed)' },
    { key: 'sgc', description: 'scenario goal completion (fraction of sub-tests passed)' },
  ],
  score({ artifact }) {
    const composite = 0.5 * artifact.tgc + 0.5 * artifact.sgc
    const cost = artifact.costUsd === null ? 'cost=unknown' : `cost=$${artifact.costUsd.toFixed(4)}`
    return {
      dimensions: { tgc: artifact.tgc, sgc: artifact.sgc },
      composite,
      notes: `tgc=${artifact.tgc} sgc=${artifact.sgc} completed=${artifact.completed} ${cost}`,
    }
  },
}

function officialMethods(
  selected: ReadonlySet<string>,
  budgets: {
    gepa?: ReturnType<typeof optimizerModelBudgetFromEnv>
    skillopt?: ReturnType<typeof optimizerModelBudgetFromEnv>
  },
): OptimizationMethod<AppWorldScenario, AppWorldArtifact>[] {
  const runner = {
    command: OPTIMIZER_PYTHON,
  }
  const describeScenario = (scenario: AppWorldScenario) => ({ taskId: scenario.taskId })
  const describeArtifact = (artifact: AppWorldArtifact) => ({
    taskGoalCompletion: artifact.tgc,
    scenarioGoalCompletion: artifact.sgc,
    completed: artifact.completed,
    trace: readFileSync(artifact.tracesPath, 'utf8').slice(-80_000),
  })
  const methods: OptimizationMethod<AppWorldScenario, AppWorldArtifact>[] = []
  if (selected.has('gepa')) {
    if (!budgets.gepa) throw new Error('missing GEPA optimizer-model budget')
    methods.push(
      gepaOptimizationMethod<AppWorldScenario, AppWorldArtifact>({
        name: 'gepa',
        objective: 'Improve the AppWorld agent system prompt to complete more requested tasks.',
        background:
          'The artifact includes AppWorld task scores and the execution trace for candidate feedback.',
        evaluationId: 'appworld-repl',
        recipe: {
          kind: 'engine',
          run: {
            engine: 'gepa',
            maxEvaluations: GEPA_MAX_EVALUATIONS,
            maxProposerCostUsd: GEPA_MAX_PROPOSER_COST_USD,
          },
        },
        optimizer: {
          model: GEPA_MODEL,
          baseUrl: BASE_URL,
          apiKey: API_KEY,
          budget: budgets.gepa,
        },
        describeScenario,
        describeArtifact,
        runner,
      }),
    )
  }
  if (selected.has('skillopt')) {
    if (!budgets.skillopt) throw new Error('missing SkillOpt optimizer-model budget')
    methods.push(
      skillOptOptimizationMethod<AppWorldScenario, AppWorldArtifact>({
        name: 'skillopt',
        objective: 'Improve the AppWorld agent system prompt to complete more requested tasks.',
        background:
          'The artifact includes AppWorld task scores and the execution trace for candidate feedback.',
        evaluationId: 'appworld-repl',
        trainer: {
          epochs: SKILLOPT_EPOCHS,
          batchSize: SKILLOPT_BATCH_SIZE,
        },
        optimizer: {
          model: SKILLOPT_MODEL,
          baseUrl: BASE_URL,
          apiKey: API_KEY,
          budget: budgets.skillopt,
        },
        maxEvaluations: SKILLOPT_MAX_EVALUATIONS,
        maxEvidenceChars: 100_000,
        describeScenario,
        describeArtifact,
        runner,
      }),
    )
  }
  return methods
}

async function main(): Promise<void> {
  const ids = await loadTaskIds()
  if (ids.length < TRAIN_N + SELECTION_N + TEST_N) {
    throw new Error(
      `AppWorld ${BENCH_SPLIT} has ${ids.length} tasks; need ${TRAIN_N + SELECTION_N + TEST_N}`,
    )
  }
  const trainScenarios: AppWorldScenario[] = ids
    .slice(0, TRAIN_N)
    .map((taskId) => ({ id: taskId, kind: 'appworld', taskId }))
  const selectionScenarios: AppWorldScenario[] = ids
    .slice(TRAIN_N, TRAIN_N + SELECTION_N)
    .map((taskId) => ({ id: taskId, kind: 'appworld', taskId }))
  const testScenarios: AppWorldScenario[] = ids
    .slice(TRAIN_N + SELECTION_N, TRAIN_N + SELECTION_N + TEST_N)
    .map((taskId) => ({ id: taskId, kind: 'appworld', taskId }))

  // Baseline surface = the worker's baseline SYSTEM_PROMPT.
  const { stdout: baselineSurface } = await execFileAsync(
    PYTHON,
    [WORKER, '--print-baseline-prompt'],
    {
      cwd: APPWORLD_DIR,
      env: process.env,
      maxBuffer: 8 * 1024 * 1024,
    },
  )

  const only = (process.env.BENCH_METHODS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  const selected = new Set(only.length > 0 ? only : ['gepa', 'skillopt'])
  const unknown = [...selected].filter((name) => name !== 'gepa' && name !== 'skillopt')
  if (unknown.length > 0) {
    throw new Error(`BENCH_METHODS contains unavailable methods: ${unknown.join(', ')}`)
  }
  assertMatchedMethodLimits(
    selected,
    { gepa: GEPA_MAX_EVALUATIONS, skillopt: SKILLOPT_MAX_EVALUATIONS },
    'Candidate-task evaluation limits',
  )
  const budgets = {
    ...(selected.has('gepa')
      ? { gepa: optimizerModelBudgetFromEnv('GEPA', MAX_OPTIMIZER_MODEL_COST_USD) }
      : {}),
    ...(selected.has('skillopt')
      ? { skillopt: optimizerModelBudgetFromEnv('SKILLOPT', MAX_OPTIMIZER_MODEL_COST_USD) }
      : {}),
  }
  const methods = officialMethods(selected, budgets)
  if (methods.length === 0) {
    throw new Error(`BENCH_METHODS matched no methods: ${only.join(',')}`)
  }

  console.log(
    `[bench] worker=${MODEL} gepa=${GEPA_MODEL} skillopt=${SKILLOPT_MODEL} train=${TRAIN_N} selection=${SELECTION_N} test=${TEST_N} methods=${methods.map((method) => method.name).join(',')}`,
  )

  const comparison = await compareOptimizationMethods<AppWorldScenario, AppWorldArtifact>({
    methods,
    baselineSurface,
    trainScenarios,
    selectionScenarios,
    testScenarios,
    dispatchWithSurface,
    judges: [appworldJudge],
    runDir: join(OUT_DIR, 'comparison'),
    seed: SEED,
    reps: REPS, // shots are averaged within each task; bootstrap resamples tasks
    optimizationConcurrency: OPTIMIZATION_CONCURRENCY,
    maxConcurrency: MAXCONC, // parallelize the test-scoring fan-out (the bulk of the run)
    optimizationRunOptions: {
      maxConcurrency: MAXCONC,
      expectUsage: 'assert',
    },
    costCeiling: MAX_TOTAL_COST_USD,
    expectUsage: 'assert',
  })

  const artifact = {
    task: {
      corpus: 'appworld',
      split: BENCH_SPLIT,
      difficulty: BENCH_DIFFICULTY ?? null,
      trainScenarioIds: trainScenarios.map(({ id }) => id),
      selectionScenarioIds: selectionScenarios.map(({ id }) => id),
      finalScenarioIds: comparison.testScenarioIds,
    },
    models: {
      worker: { model: MODEL, baseUrl: BASE_URL },
      optimizer: {
        python: OPTIMIZER_PYTHON,
        gepa: selected.has('gepa') ? { model: GEPA_MODEL, budget: budgets.gepa } : null,
        skillopt: selected.has('skillopt')
          ? { model: SKILLOPT_MODEL, budget: budgets.skillopt }
          : null,
      },
    },
    limits: {
      candidateTaskEvaluations: {
        gepa: selected.has('gepa') ? GEPA_MAX_EVALUATIONS : null,
        skillopt: selected.has('skillopt') ? SKILLOPT_MAX_EVALUATIONS : null,
      },
      gepaMaxProposerCostUsd: selected.has('gepa') ? GEPA_MAX_PROPOSER_COST_USD : null,
      optimizerModelCostUsdPerMethod: MAX_OPTIMIZER_MODEL_COST_USD,
      allRunCostUsd: MAX_TOTAL_COST_USD,
      repetitionsPerFinalTask: REPS,
      optimizationConcurrency: OPTIMIZATION_CONCURRENCY,
      taskConcurrency: MAXCONC,
      worker: {
        maxSteps: MAX_STEPS,
        maxWallSeconds: MAX_WALL,
        callTimeoutSeconds: CALL_TIMEOUT,
        maxOutputTokens: MAX_TOKENS,
        rateLimitRetrySeconds: RATE_LIMIT_BUDGET,
        temperature: TEMPERATURE,
      },
    },
    costContext: {
      worker:
        'Estimated from the model price table in repl_agent.py; unknown models remain unpriced.',
      optimizers:
        'Provider-reported cost is used when present; otherwise configured token rates estimate cost.',
      accountingComplete:
        'Every observed call was priced; this does not mean the amount was reconciled to an invoice.',
    },
    comparison,
  }
  writeFileSync(join(OUT_DIR, 'comparison.json'), JSON.stringify(artifact, null, 2))
  const md = renderReport(comparison)
  writeFileSync(join(OUT_DIR, 'report.md'), md)
  console.log(`\n${md}\n[bench] artifacts in ${OUT_DIR}`)
}

function renderReport(c: Awaited<ReturnType<typeof compareOptimizationMethods>>): string {
  const rows = c.scores
    .map((s) => {
      const allocated =
        s.name === 'gepa'
          ? GEPA_MAX_EVALUATIONS
          : s.name === 'skillopt'
            ? SKILLOPT_MAX_EVALUATIONS
            : null
      const actual = s.provenance?.evaluationCount ?? null
      return `| ${s.rank} | ${s.name} | ${s.baselineComposite.toFixed(3)} | ${s.winnerComposite.toFixed(3)} | ${(s.lift * 100).toFixed(1)}% | [${(s.liftCi.low * 100).toFixed(1)}%, ${(s.liftCi.high * 100).toFixed(1)}%] | ${actual ?? 'unknown'}/${allocated ?? 'unknown'} | $${s.optimizationCost.totalCostUsd.toFixed(2)} | ${s.optimizationCost.accountingComplete ? 'yes' : 'no'} |`
    })
    .join('\n')
  const sig = c.scores
    .filter((s) => s.liftCi.low > 0)
    .map((s) => s.name)
    .join(', ')
  return `# AppWorld Optimization Comparison

Dataset: AppWorld ${BENCH_SPLIT}.
Scoring: \`world.evaluate\` TGC/SGC.
Test tasks (${c.testScenarioIds.length}): \`${c.testScenarioIds.join(', ')}\`.
${c.reps} repetitions are averaged within each task before tasks are resampled.
The ${Math.round(c.confidence * 100)}% simultaneous intervals adjust ${c.comparisonCount} method contrasts; each interval uses ${(c.intervalConfidence * 100).toFixed(3)}% confidence.
Multi-method runs reject unequal candidate-task limits.

| Rank | Method | Baseline | Winner | Lift | ${Math.round(c.confidence * 100)}% interval | Candidate calls used/limit | Optimization cost | Cost complete |
|---|---|---|---|---|---|---|---|---|
${rows}

Top-ranked test result: ${c.best.name}, ${(c.best.lift * 100).toFixed(1)}% [${(c.best.liftCi.low * 100).toFixed(1)}%, ${(c.best.liftCi.high * 100).toFixed(1)}%].
Methods with an interval above zero: ${sig || 'none'}.

Optimization cost: $${c.optimizationCost.totalCostUsd.toFixed(2)} (${c.optimizationCost.accountingComplete ? 'complete' : 'incomplete'}).
Final test cost: $${c.testCost.totalCostUsd.toFixed(2)} (${c.testCost.accountingComplete ? 'complete' : 'incomplete'}).
Total comparison cost: $${c.totalCost.totalCostUsd.toFixed(2)} (${c.totalCost.accountingComplete ? 'complete' : 'incomplete'}).

Best method compared with each other method:
${c.pairwise.map((p) => `- ${p.a} vs ${p.b}: ${(p.deltaMean * 100).toFixed(1)}% [${(p.low * 100).toFixed(1)}%, ${(p.high * 100).toFixed(1)}%], favored=${p.favored}`).join('\n')}
`
}

main().catch((e) => {
  console.error('[bench] failed:', e instanceof Error ? e.stack : e)
  process.exit(1)
})
