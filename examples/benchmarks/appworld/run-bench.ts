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
import {
  DEFAULT_TRACE_ANALYST_KINDS,
  FAILURE_MODE_KIND_SPEC,
  IMPROVEMENT_KIND_SPEC,
} from '../../../src'
import {
  type BuiltinProposerEntryConfig,
  compareProposers,
  type DispatchContext,
  defaultProductionGate,
  gepaParetoEntry,
  gepaReflectionEntry,
  haloProposer,
  type JudgeConfig,
  type MutableSurface,
  memoryCurationProposer,
  type ProposerEntry,
  runImprovementLoop,
  type Scenario,
  traceAnalystProposer,
} from '../../../src/campaign'

const execFileAsync = promisify(execFile)

// ── Config (env-overridable so the overnight run can be tuned) ───────────────
const APPWORLD_DIR = process.env.APPWORLD_DIR ?? '/tmp/halo-repo/demo/appworld'
const PYTHON = process.env.BENCH_PYTHON ?? `${APPWORLD_DIR}/.venv/bin/python`
const HERE = dirname(fileURLToPath(import.meta.url))
const WORKER = join(HERE, 'repl_agent.py')
const MODEL = process.env.BENCH_MODEL ?? 'gpt-5.1' // the AGENT model (worker) — a strong model
const REFLECT_MODEL = process.env.BENCH_REFLECT_MODEL ?? 'deepseek-v4-pro' // proposers' model
const BASE_URL = process.env.OPENAI_BASE_URL ?? 'https://router.tangle.tools/v1'
const API_KEY = process.env.OPENAI_API_KEY ?? ''
const TRAIN_N = Number(process.env.TRAIN_N ?? 3)
const SELECTION_N = Number(process.env.SELECTION_N ?? 3)
const TEST_N = Number(process.env.TEST_N ?? 5)
const MAX_GEN = Number(process.env.MAX_GEN ?? 1)
const POP = Number(process.env.POP ?? 2)
const REPS = Number(process.env.REPS ?? 5) // shots per test cell → bootstrap CIs over reps×scenarios
const MAX_STEPS = Number(process.env.MAX_STEPS ?? 0) // 0 = no cap (maxTurns=0)
const MAX_WALL = Number(process.env.MAX_WALL ?? 900) // per-episode wall-clock safety net (s)
const TEMPERATURE = Number(process.env.TEMPERATURE ?? 0.7) // >0 → independent shots (vs cached reps)
const MAXCONC = Number(process.env.MAXCONC ?? 3) // test-scoring concurrency (router absorbs 429s)
const CALL_TIMEOUT = Number(process.env.CALL_TIMEOUT ?? 120)
const MAX_TOKENS = Number(process.env.MAX_TOKENS ?? 6000)
const OUT_DIR = process.env.OUT_DIR ?? join(tmpdir(), 'appworld-bench')
const SEED = Number(process.env.SEED ?? 42)
// HALO is opt-in (needs the halo-engine CLI + spends extra); off by default.
const WITH_HALO = process.env.WITH_HALO === '1'
// The halo binary. Default 'halo' (Responses API → OpenAI/router). For chat-
// completions backends (DeepSeek), point at examples/.../halo-chat.sh and set
// HALO_VENV_PY to the halo-engine venv python.
const HALO_BIN = process.env.HALO_BIN ?? 'halo'
const HALO_MAX_DEPTH = Number(process.env.HALO_MAX_DEPTH ?? 0) // 0 = no subagents (cheaper, faster)
const HALO_MAX_TURNS = Number(process.env.HALO_MAX_TURNS ?? 20)
// Our trace-analyst is the symmetric opponent to HALO. Opt-in (it spends extra
// on the agentic analyst reads); turn BOTH on for the head-to-head.
const WITH_ANALYST = process.env.WITH_ANALYST === '1'
// Which analyst kinds the trace-analyst proposer runs. Default = failure-mode +
// improvement (the two that map to HALO's diagnose+fix, keeping turns/cost
// comparable). Set BENCH_ANALYST_KINDS=all for the full shipped suite.
const ANALYST_KINDS = process.env.BENCH_ANALYST_KINDS ?? 'focused'

interface AppWorldScenario extends Scenario {
  kind: 'appworld'
  taskId: string
}
interface AppWorldArtifact {
  tgc: number
  sgc: number
  completed: boolean
  costUsd: number
  inTok: number
  outTok: number
  tracesPath: string
}

if (!API_KEY) throw new Error('OPENAI_API_KEY must be set (point at the Tangle router)')
mkdirSync(OUT_DIR, { recursive: true })

// BENCH_DIFFICULTY filters AppWorld tasks by difficulty (1=easy … 3=hard).
// A capable worker (deepseek-chat) CEILINGS at tgc=1.0 on difficulty 1–2, which
// leaves zero lift headroom for the bake-off; difficulty 3 lands at tgc≈0 /
// sgc≈0.9 (composite ~0.45) — the movable regime where a better prompt can win.
const BENCH_DIFFICULTY = process.env.BENCH_DIFFICULTY // '1' | '2' | '3' | undefined
// Which AppWorld split to draw train+selection+test from. Default 'dev' (small). For a
// difficulty-3 proof use 'train' (18 d3 tasks) — 'dev' has only 3 d3 tasks.
const BENCH_SPLIT = process.env.BENCH_SPLIT ?? 'dev'

/** AppWorld task ids — load deterministically from BENCH_SPLIT, take
 *  train+selection+test as disjoint slices. */
async function loadTaskIds(): Promise<string[]> {
  const arg = BENCH_DIFFICULTY ? `, difficulty=${Number(BENCH_DIFFICULTY)}` : ''
  const { stdout } = await execFileAsync(
    PYTHON,
    [
      '-c',
      `from appworld import load_task_ids; print("\\n".join(load_task_ids("${BENCH_SPLIT}"${arg})))`,
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
          '240',
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
      return JSON.parse(readFileSync(join(dir, 'result.json'), 'utf8')) as {
        tgc: number
        sgc: number
        completed: boolean
        cost_usd: number
        token_usage?: { input?: number; output?: number }
        tokenUsage?: { input?: number; output?: number }
        traces_path?: string
      }
    },
    receipt: (result) => {
      if (Number.isNaN(result.cost_usd)) {
        throw new Error(
          `appworld bench: worker returned NaN cost for model "${MODEL}" — it is unpriced. Add it to PRICE_PER_M in repl_agent.py so the lift comparison has a real cost axis.`,
        )
      }
      return {
        model: MODEL,
        inputTokens: result.token_usage?.input ?? result.tokenUsage?.input ?? 0,
        outputTokens: result.token_usage?.output ?? result.tokenUsage?.output ?? 0,
        actualCostUsd: result.cost_usd,
      }
    },
  })
  if (!paid.succeeded) throw paid.error
  const result = paid.value
  const inTok = result.token_usage?.input ?? result.tokenUsage?.input ?? 0
  const outTok = result.token_usage?.output ?? result.tokenUsage?.output ?? 0
  return {
    tgc: result.tgc,
    sgc: result.sgc,
    completed: result.completed,
    costUsd: result.cost_usd,
    inTok,
    outTok,
    tracesPath: result.traces_path ?? join(dir, 'traces.jsonl'),
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
    return {
      dimensions: { tgc: artifact.tgc, sgc: artifact.sgc },
      composite,
      notes: `tgc=${artifact.tgc} sgc=${artifact.sgc} completed=${artifact.completed} $${artifact.costUsd.toFixed(4)}`,
    }
  },
}

/** Run the memory-curation method with the shared comparison data. */
function memoryEntry(
  config: BuiltinProposerEntryConfig<AppWorldScenario, AppWorldArtifact>,
): ProposerEntry<AppWorldScenario> {
  return {
    name: 'memory-curation',
    async optimize(data) {
      const started = Date.now()
      const selectionScenarios = [...data.selectionScenarios]
      const result = await runImprovementLoop<AppWorldScenario, AppWorldArtifact>({
        scenarios: [...data.trainScenarios],
        holdoutScenarios: selectionScenarios,
        baselineSurface: config.baselineSurface,
        dispatchWithSurface: config.dispatchWithSurface,
        judges: config.judges,
        proposer: memoryCurationProposer({}),
        populationSize: 1,
        maxGenerations: config.maxGenerations ?? MAX_GEN,
        gate: defaultProductionGate<AppWorldArtifact, AppWorldScenario>({
          holdoutScenarios: selectionScenarios,
          deltaThreshold: 0,
        }),
        autoOnPromote: 'none',
        runDir: `${config.runDir}/memory-loop`,
        seed: config.seed ?? SEED,
      })
      return {
        winnerSurface:
          result.gateResult.decision === 'ship' ? result.winnerSurface : config.baselineSurface,
        costUsd: result.cost.totalCostUsd,
        durationMs: Date.now() - started,
      }
    },
  }
}

/** Run the external HALO method with the shared comparison data. */
function haloEntry(
  config: BuiltinProposerEntryConfig<AppWorldScenario, AppWorldArtifact>,
): ProposerEntry<AppWorldScenario> {
  return {
    name: 'halo',
    async optimize(data) {
      const started = Date.now()
      const selectionScenarios = [...data.selectionScenarios]
      const result = await runImprovementLoop<AppWorldScenario, AppWorldArtifact>({
        scenarios: [...data.trainScenarios],
        holdoutScenarios: selectionScenarios,
        baselineSurface: config.baselineSurface,
        dispatchWithSurface: config.dispatchWithSurface,
        judges: config.judges,
        proposer: haloProposer({
          baseUrl: BASE_URL,
          apiKey: API_KEY,
          model: REFLECT_MODEL,
          // HALO_BIN points at the chat-completions launcher (halo-chat.sh) for
          // OpenAI-compatible chat backends like DeepSeek; defaults to the raw
          // 'halo' CLI (Responses API) for OpenAI/router.
          haloBin: HALO_BIN,
          maxDepth: HALO_MAX_DEPTH,
          maxTurns: HALO_MAX_TURNS,
          // SAME corpus the trace-analyst reads — see resolveTrainTraces.
          resolveTraces: () => resolveTrainTraces(),
        }),
        populationSize: 1,
        maxGenerations: config.maxGenerations ?? MAX_GEN,
        gate: defaultProductionGate<AppWorldArtifact, AppWorldScenario>({
          holdoutScenarios: selectionScenarios,
          deltaThreshold: 0,
        }),
        autoOnPromote: 'none',
        runDir: `${config.runDir}/halo-loop`,
        seed: config.seed ?? SEED,
      })
      return {
        winnerSurface:
          result.gateResult.decision === 'ship' ? result.winnerSurface : config.baselineSurface,
        costUsd: result.cost.totalCostUsd,
        durationMs: Date.now() - started,
      }
    },
  }
}

// Concatenate the training traces the worker just emitted — the SAME corpus
// fed to BOTH the halo CLI and our trace-analyst, so a lift delta isolates the
// analysis engine, not the input.
function resolveTrainTraces(): string {
  const lines: string[] = []
  for (const f of latestTracePaths) {
    try {
      lines.push(readFileSync(f, 'utf8').trim())
    } catch {
      /* a dropped cell has no traces; skip */
    }
  }
  return lines.filter(Boolean).join('\n')
}

// Keep execution and data fixed so only the findings method differs from HALO.
function traceAnalystEntry(
  config: BuiltinProposerEntryConfig<AppWorldScenario, AppWorldArtifact>,
): ProposerEntry<AppWorldScenario> {
  const kinds =
    ANALYST_KINDS === 'all'
      ? DEFAULT_TRACE_ANALYST_KINDS
      : [FAILURE_MODE_KIND_SPEC, IMPROVEMENT_KIND_SPEC]
  return {
    name: 'trace-analyst',
    async optimize(data) {
      const started = Date.now()
      const selectionScenarios = [...data.selectionScenarios]
      const result = await runImprovementLoop<AppWorldScenario, AppWorldArtifact>({
        scenarios: [...data.trainScenarios],
        holdoutScenarios: selectionScenarios,
        baselineSurface: config.baselineSurface,
        dispatchWithSurface: config.dispatchWithSurface,
        judges: config.judges,
        proposer: traceAnalystProposer({
          baseUrl: BASE_URL,
          apiKey: API_KEY,
          model: REFLECT_MODEL,
          kinds,
          resolveTraces: () => resolveTrainTraces(),
        }),
        populationSize: 1,
        maxGenerations: config.maxGenerations ?? MAX_GEN,
        gate: defaultProductionGate<AppWorldArtifact, AppWorldScenario>({
          holdoutScenarios: selectionScenarios,
          deltaThreshold: 0,
        }),
        autoOnPromote: 'none',
        runDir: `${config.runDir}/trace-analyst-loop`,
        seed: config.seed ?? SEED,
      })
      return {
        winnerSurface:
          result.gateResult.decision === 'ship' ? result.winnerSurface : config.baselineSurface,
        costUsd: result.cost.totalCostUsd,
        durationMs: Date.now() - started,
      }
    },
  }
}

// Track the most recent train-cell trace files so the halo proposer can analyze them.
const latestTracePaths: string[] = []

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

  // Wrap dispatch to record train-cell trace paths for the halo proposer.
  const trainIds = new Set(trainScenarios.map((s) => s.taskId))
  const recordingDispatch = async (
    surface: MutableSurface,
    scenario: AppWorldScenario,
    ctx: DispatchContext,
  ): Promise<AppWorldArtifact> => {
    const art = await dispatchWithSurface(surface, scenario, ctx)
    if (trainIds.has(scenario.taskId)) latestTracePaths.push(art.tracesPath)
    return art
  }

  const cfg: BuiltinProposerEntryConfig<AppWorldScenario, AppWorldArtifact> = {
    baselineSurface,
    dispatchWithSurface: recordingDispatch,
    judges: [appworldJudge],
    llm: { baseUrl: BASE_URL, apiKey: API_KEY },
    model: REFLECT_MODEL,
    target: 'appworld-agent-system-prompt',
    runDir: join(OUT_DIR, 'loops'),
    seed: SEED,
    populationSize: POP,
    maxGenerations: MAX_GEN,
  }

  let proposers: ProposerEntry<AppWorldScenario>[] = [
    gepaReflectionEntry(cfg),
    gepaParetoEntry(cfg),
    memoryEntry(cfg),
  ]
  if (WITH_HALO) proposers.push(haloEntry(cfg))
  if (WITH_ANALYST) proposers.push(traceAnalystEntry(cfg))
  // BENCH_PROPOSERS=gepa-reflection,memory-curation selects a subset (smoke / recovery).
  const only = (process.env.BENCH_PROPOSERS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  if (only.length > 0) proposers = proposers.filter((d) => only.includes(d.name))
  if (proposers.length === 0) {
    throw new Error(`BENCH_PROPOSERS matched no proposers: ${only.join(',')}`)
  }

  console.log(
    `[bench] model=${MODEL} reflect=${REFLECT_MODEL} train=${TRAIN_N} selection=${SELECTION_N} test=${TEST_N} gen=${MAX_GEN} pop=${POP} proposers=${proposers.map((d) => d.name).join(',')}`,
  )

  const comparison = await compareProposers<AppWorldScenario, AppWorldArtifact>({
    proposers,
    baselineSurface,
    trainScenarios,
    selectionScenarios,
    testScenarios,
    dispatchWithSurface: recordingDispatch,
    judges: [appworldJudge],
    runDir: join(OUT_DIR, 'compare'),
    seed: SEED,
    reps: REPS, // 5 shots per test cell — the CI is over reps×scenarios, not a single point
    maxConcurrency: MAXCONC, // parallelize the test-scoring fan-out (the bulk of the run)
    expectUsage: 'assert', // NO STUBS — a zero-token cell fails loud, never silently scored 0
  })

  writeFileSync(join(OUT_DIR, 'comparison.json'), JSON.stringify(comparison, null, 2))
  const md = renderReport(comparison)
  writeFileSync(join(OUT_DIR, 'REPORT.md'), md)
  console.log(`\n${md}\n[bench] artifacts in ${OUT_DIR}`)
}

function renderReport(c: Awaited<ReturnType<typeof compareProposers>>): string {
  const rows = c.scores
    .map(
      (s) =>
        `| ${s.rank} | ${s.name} | ${s.baselineComposite.toFixed(3)} | ${s.winnerComposite.toFixed(3)} | ${(s.lift * 100).toFixed(1)}% | [${(s.liftCi.low * 100).toFixed(1)}%, ${(s.liftCi.high * 100).toFixed(1)}%] | $${s.costUsd.toFixed(2)} |`,
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

| Rank | Method | Baseline | Winner | Lift | 95% interval | Optimization cost |
|---|---|---|---|---|---|---|
${rows}

Best test lift: ${c.best.name}, ${(c.best.lift * 100).toFixed(1)}% [${(c.best.liftCi.low * 100).toFixed(1)}%, ${(c.best.liftCi.high * 100).toFixed(1)}%].
Methods with an interval above zero: ${sig || 'none'}.

Best method compared with each other method:
${c.pairwise.map((p) => `- ${p.a} - ${p.b}: ${(p.deltaMean * 100).toFixed(1)}% [${(p.low * 100).toFixed(1)}%, ${(p.high * 100).toFixed(1)}%], favored=${p.favored}`).join('\n')}
`
}

main().catch((e) => {
  console.error('[bench] failed:', e instanceof Error ? e.stack : e)
  process.exit(1)
})
