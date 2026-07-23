/**
 * Compare prompt optimization methods on AppWorld using separate train,
 * selection, and test tasks. AppWorld's `world.evaluate()` scores the worker
 * output, so no model-based judge is involved.
 *
 * Run (overnight):
 *   export OPENAI_BASE_URL=https://router.tangle.tools/v1 OPENAI_API_KEY=$(cat /tmp/.tk)
 *   APPWORLD_DIR=/tmp/halo-repo/demo/appworld \
 *   BENCH_MODEL=gpt-5-mini TRAIN_N=4 SELECTION_N=4 TEST_N=6 MAX_GEN=2 \
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
  DEFAULT_TRACE_ANALYST_KINDS,
  FAILURE_MODE_KIND_SPEC,
  IMPROVEMENT_KIND_SPEC,
} from '../../../src'
import {
  analyzeOtlpTraceFile,
  type BuiltinOptimizationMethodConfig,
  compareOptimizationMethods,
  costFromLedgerSummary,
  type DispatchContext,
  defaultProductionGate,
  gepaParetoMethod,
  gepaReflectionMethod,
  haloProposer,
  type JudgeConfig,
  type MutableSurface,
  memoryCurationProposer,
  type OptimizationMethod,
  runImprovementLoop,
  type Scenario,
  type SurfaceProposer,
  traceAnalystProposer,
} from '../../../src/campaign'
import {
  nonNegativeIntegerEnv,
  nonNegativeNumberEnv,
  positiveIntegerEnv,
  positiveNumberEnv,
  safeIntegerEnv,
  stringEnv,
} from '../../_shared/env'

const execFileAsync = promisify(execFile)

// ── Config (env-overridable so the overnight run can be tuned) ───────────────
const APPWORLD_DIR = stringEnv('APPWORLD_DIR', '/tmp/halo-repo/demo/appworld')
const PYTHON = stringEnv('BENCH_PYTHON', `${APPWORLD_DIR}/.venv/bin/python`)
const HERE = dirname(fileURLToPath(import.meta.url))
const WORKER = join(HERE, 'repl_agent.py')
const MODEL = stringEnv('BENCH_MODEL', 'gpt-5.1')
const REFLECT_MODEL = stringEnv('BENCH_REFLECT_MODEL', MODEL)
const BASE_URL = stringEnv('OPENAI_BASE_URL', 'https://router.tangle.tools/v1')
const API_KEY = process.env.OPENAI_API_KEY?.trim() ?? ''
const TRAIN_N = positiveIntegerEnv('TRAIN_N', 3)
const SELECTION_N = positiveIntegerEnv('SELECTION_N', 3)
const TEST_N = positiveIntegerEnv('TEST_N', 5)
const MAX_GEN = positiveIntegerEnv('MAX_GEN', 1)
const POP = positiveIntegerEnv('POP', 2)
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
// HALO is opt-in (needs the halo-engine CLI + spends extra); off by default.
const WITH_HALO = process.env.WITH_HALO === '1'
// The halo binary. Default 'halo' (Responses API → OpenAI/router). For chat-
// completions backends (DeepSeek), point at examples/.../halo-chat.sh and set
// HALO_VENV_PY to the halo-engine venv python.
const HALO_BIN = stringEnv('HALO_BIN', 'halo')
const HALO_MAX_DEPTH = nonNegativeIntegerEnv('HALO_MAX_DEPTH', 0)
const HALO_MAX_TURNS = positiveIntegerEnv('HALO_MAX_TURNS', 20)
// Our trace-analyst is the symmetric opponent to HALO. Opt-in (it spends extra
// on the agentic analyst reads); turn BOTH on for the head-to-head.
const WITH_ANALYST = process.env.WITH_ANALYST === '1'
// Which analyst kinds the trace-analyst proposer runs. Default = failure-mode +
// improvement (the two that map to HALO's diagnose+fix, keeping turns/cost
// comparable). Set BENCH_ANALYST_KINDS=all for the full shipped suite.
const ANALYST_KINDS = stringEnv('BENCH_ANALYST_KINDS', 'focused')

if (TEMPERATURE > 2) throw new Error('TEMPERATURE must be between 0 and 2')
if (!['focused', 'all'].includes(ANALYST_KINDS)) {
  throw new Error('BENCH_ANALYST_KINDS must be focused or all')
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

// BENCH_DIFFICULTY filters AppWorld tasks by difficulty (1=easy … 3=hard).
// A capable worker (deepseek-chat) CEILINGS at tgc=1.0 on difficulty 1–2, which
// leaves zero lift headroom for the bake-off; difficulty 3 lands at tgc≈0 /
// sgc≈0.9 (composite ~0.45) — the movable regime where a better prompt can win.
const BENCH_DIFFICULTY_RAW = process.env.BENCH_DIFFICULTY?.trim()
const BENCH_DIFFICULTY = BENCH_DIFFICULTY_RAW ? Number(BENCH_DIFFICULTY_RAW) : undefined
if (BENCH_DIFFICULTY !== undefined && ![1, 2, 3].includes(BENCH_DIFFICULTY)) {
  throw new Error('BENCH_DIFFICULTY must be 1, 2, or 3')
}
// Which AppWorld split to draw train+selection+test from. Default 'dev' (small). For a
// difficulty-3 proof use 'train' (18 d3 tasks) — 'dev' has only 3 d3 tasks.
const BENCH_SPLIT = stringEnv('BENCH_SPLIT', 'dev')

/** AppWorld task ids — load deterministically from BENCH_SPLIT, take
 *  train+selection+test as disjoint slices. */
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

function loopMethod(
  name: string,
  config: BuiltinOptimizationMethodConfig<AppWorldScenario, AppWorldArtifact>,
  createProposer: (resolveTraces: () => string) => SurfaceProposer,
): OptimizationMethod<AppWorldScenario, AppWorldArtifact> {
  return {
    name,
    async optimize(input) {
      const started = Date.now()
      const selectionScenarios = [...input.selectionScenarios]
      const trainIds = new Set(input.trainScenarios.map((scenario) => scenario.id))
      const tracePaths: string[] = []
      const methodDispatch: typeof input.dispatchWithSurface = async (surface, scenario, ctx) => {
        const artifact = await input.dispatchWithSurface(surface, scenario, ctx)
        if (trainIds.has(scenario.id)) tracePaths.push(artifact.tracesPath)
        return artifact
      }
      const resolveTraces = () =>
        tracePaths
          .map((path) => readFileSync(path, 'utf8').trim())
          .filter(Boolean)
          .join('\n')
      const result = await runImprovementLoop<AppWorldScenario, AppWorldArtifact>({
        ...input.runOptions,
        ...(config.runOptions ?? {}),
        scenarios: [...input.trainScenarios],
        holdoutScenarios: selectionScenarios,
        baselineSurface: input.baselineSurface,
        dispatchWithSurface: methodDispatch,
        judges: [...input.judges],
        proposer: createProposer(resolveTraces),
        populationSize: config.populationSize ?? POP,
        maxGenerations: config.maxGenerations ?? MAX_GEN,
        gate: defaultProductionGate<AppWorldArtifact, AppWorldScenario>({
          holdoutScenarios: selectionScenarios,
          deltaThreshold: 0,
        }),
        autoOnPromote: 'none',
        runDir: `${input.runDir}/loop`,
        seed: config.seed ?? input.seed,
        ...(config.findings !== undefined ? { findings: config.findings } : {}),
        ...(config.analyzeGeneration ? { analyzeGeneration: config.analyzeGeneration } : {}),
        ...(config.report !== undefined ? { report: config.report } : {}),
      })
      return {
        winnerSurface:
          result.gateResult.decision === 'ship' ? result.winnerSurface : input.baselineSurface,
        cost: costFromLedgerSummary(result.cost),
        durationMs: Date.now() - started,
      }
    },
  }
}

function memoryMethod(
  config: BuiltinOptimizationMethodConfig<AppWorldScenario, AppWorldArtifact>,
): OptimizationMethod<AppWorldScenario, AppWorldArtifact> {
  const analyzeGeneration: NonNullable<typeof config.analyzeGeneration> = async ({
    generation,
    runDir,
    candidates,
    costLedger,
    costPhase,
  }) => {
    const traceText = candidates
      .flatMap((candidate) => candidate.campaign.cells.map((cell) => cell.artifact.tracesPath))
      .map((path) => readFileSync(path, 'utf8').trim())
      .filter(Boolean)
      .join('\n')
    if (!traceText) throw new Error('memory-curation: training runs produced no traces')
    mkdirSync(runDir, { recursive: true })
    const tracePath = join(runDir, 'memory-analysis-traces.jsonl')
    writeFileSync(tracePath, traceText)
    return analyzeOtlpTraceFile({
      tracePath,
      runId: `appworld-memory-${generation}`,
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      model: REFLECT_MODEL,
      kinds: analystKinds(),
      ...(costLedger ? { costLedger } : {}),
      ...(costPhase ? { costPhase } : {}),
    })
  }
  return loopMethod('memory-curation', { ...config, analyzeGeneration }, () =>
    memoryCurationProposer({}),
  )
}

function haloMethod(
  config: BuiltinOptimizationMethodConfig<AppWorldScenario, AppWorldArtifact>,
): OptimizationMethod<AppWorldScenario, AppWorldArtifact> {
  return loopMethod('halo', config, (resolveTraces) =>
    haloProposer({
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      model: REFLECT_MODEL,
      haloBin: HALO_BIN,
      maxDepth: HALO_MAX_DEPTH,
      maxTurns: HALO_MAX_TURNS,
      resolveTraces,
    }),
  )
}

function traceAnalystMethod(
  config: BuiltinOptimizationMethodConfig<AppWorldScenario, AppWorldArtifact>,
): OptimizationMethod<AppWorldScenario, AppWorldArtifact> {
  return loopMethod('trace-analyst', config, (resolveTraces) =>
    traceAnalystProposer({
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      model: REFLECT_MODEL,
      kinds: analystKinds(),
      resolveTraces,
    }),
  )
}

function analystKinds() {
  return ANALYST_KINDS === 'all'
    ? DEFAULT_TRACE_ANALYST_KINDS
    : [FAILURE_MODE_KIND_SPEC, IMPROVEMENT_KIND_SPEC]
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

  const cfg: BuiltinOptimizationMethodConfig<AppWorldScenario, AppWorldArtifact> = {
    llm: { baseUrl: BASE_URL, apiKey: API_KEY },
    model: REFLECT_MODEL,
    target: 'appworld-agent-system-prompt',
    populationSize: POP,
    maxGenerations: MAX_GEN,
  }

  let methods: OptimizationMethod<AppWorldScenario, AppWorldArtifact>[] = [
    gepaReflectionMethod(cfg),
    gepaParetoMethod(cfg),
    memoryMethod(cfg),
  ]
  if (WITH_HALO) methods.push(haloMethod(cfg))
  if (WITH_ANALYST) methods.push(traceAnalystMethod(cfg))
  // BENCH_METHODS=gepa-reflection,memory-curation selects a subset.
  const only = (process.env.BENCH_METHODS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  if (only.length > 0) {
    const available = new Set(methods.map((method) => method.name))
    const unknown = only.filter((name) => !available.has(name))
    if (unknown.length > 0) {
      throw new Error(`BENCH_METHODS contains unavailable methods: ${unknown.join(', ')}`)
    }
    methods = methods.filter((method) => only.includes(method.name))
  }
  if (methods.length === 0) {
    throw new Error(`BENCH_METHODS matched no methods: ${only.join(',')}`)
  }

  console.log(
    `[bench] model=${MODEL} reflect=${REFLECT_MODEL} train=${TRAIN_N} selection=${SELECTION_N} test=${TEST_N} gen=${MAX_GEN} pop=${POP} methods=${methods.map((method) => method.name).join(',')}`,
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
    expectUsage: 'assert',
  })

  writeFileSync(join(OUT_DIR, 'comparison.json'), JSON.stringify(comparison, null, 2))
  const md = renderReport(comparison)
  writeFileSync(join(OUT_DIR, 'report.md'), md)
  console.log(`\n${md}\n[bench] artifacts in ${OUT_DIR}`)
}

function renderReport(c: Awaited<ReturnType<typeof compareOptimizationMethods>>): string {
  const rows = c.scores
    .map(
      (s) =>
        `| ${s.rank} | ${s.name} | ${s.baselineComposite.toFixed(3)} | ${s.winnerComposite.toFixed(3)} | ${(s.lift * 100).toFixed(1)}% | [${(s.liftCi.low * 100).toFixed(1)}%, ${(s.liftCi.high * 100).toFixed(1)}%] | $${s.optimizationCost.totalCostUsd.toFixed(2)} | ${s.optimizationCost.accountingComplete ? 'yes' : 'no'} |`,
    )
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

| Rank | Method | Baseline | Winner | Lift | ${Math.round(c.confidence * 100)}% interval | Optimization cost | Cost complete |
|---|---|---|---|---|---|---|---|
${rows}

Best test lift: ${c.best.name}, ${(c.best.lift * 100).toFixed(1)}% [${(c.best.liftCi.low * 100).toFixed(1)}%, ${(c.best.liftCi.high * 100).toFixed(1)}%].
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
