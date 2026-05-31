/**
 * @experimental — AppWorld driver-comparison benchmark.
 *
 * Head-to-head lift of agent-eval's self-improvement drivers on a PUBLIC
 * benchmark (AppWorld), scored objectively by `world.evaluate()` (SGC/TGC):
 *
 *   baseline  vs  gepa-reflection  vs  gepa-pareto  vs  memory-curation  vs  halo
 *
 * Each arm optimizes the SAME baseline agent instruction prompt (the surface)
 * on a TRAIN split, then every winner + the baseline are scored on a held-out
 * split via paired bootstrap CIs (compareDrivers). The agent itself is the real
 * non-MCP REPL worker (repl_agent.py) driving real AppWorld tasks through the
 * Tangle router — no mocks, objective scoring.
 *
 * Run (overnight):
 *   export OPENAI_BASE_URL=https://router.tangle.tools/v1 OPENAI_API_KEY=$(cat /tmp/.tk)
 *   APPWORLD_DIR=/tmp/halo-repo/demo/appworld \
 *   BENCH_MODEL=gpt-5-mini TRAIN_N=4 HOLDOUT_N=6 MAX_GEN=2 \
 *   pnpm tsx examples/benchmarks/appworld/run-bench.ts > /tmp/appworld-bench/run.log 2>&1
 *
 * Output: a markdown report + the raw DriverComparison JSON under OUT_DIR.
 */

import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import {
  compareDrivers,
  type DispatchContext,
  type DriverEntry,
  defaultProductionGate,
  gepaParetoEntry,
  gepaReflectionEntry,
  haloDriver,
  type JudgeConfig,
  type MutableSurface,
  memoryCurationDriver,
  type OptimizerEntryConfig,
  runImprovementLoop,
  type Scenario,
} from '../../../src/campaign'

const execFileAsync = promisify(execFile)

// ── Config (env-overridable so the overnight run can be tuned) ───────────────
const APPWORLD_DIR = process.env.APPWORLD_DIR ?? '/tmp/halo-repo/demo/appworld'
const PYTHON = process.env.BENCH_PYTHON ?? `${APPWORLD_DIR}/.venv/bin/python`
const HERE = dirname(fileURLToPath(import.meta.url))
const WORKER = join(HERE, 'repl_agent.py')
const MODEL = process.env.BENCH_MODEL ?? 'gpt-5-mini' // the AGENT model (worker)
const REFLECT_MODEL = process.env.BENCH_REFLECT_MODEL ?? 'deepseek-v4-pro' // drivers' propose model
const BASE_URL = process.env.OPENAI_BASE_URL ?? 'https://router.tangle.tools/v1'
const API_KEY = process.env.OPENAI_API_KEY ?? ''
const TRAIN_N = Number(process.env.TRAIN_N ?? 4)
const HOLDOUT_N = Number(process.env.HOLDOUT_N ?? 6)
const MAX_GEN = Number(process.env.MAX_GEN ?? 2)
const POP = Number(process.env.POP ?? 2)
const MAX_STEPS = Number(process.env.MAX_STEPS ?? 25)
const CALL_TIMEOUT = Number(process.env.CALL_TIMEOUT ?? 90)
const MAX_TOKENS = Number(process.env.MAX_TOKENS ?? 6000)
const OUT_DIR = process.env.OUT_DIR ?? join(tmpdir(), 'appworld-bench')
const SEED = Number(process.env.SEED ?? 42)
// HALO is opt-in (needs the halo-engine CLI + spends extra); off by default.
const WITH_HALO = process.env.WITH_HALO === '1'

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

/** AppWorld dev task ids — load deterministically, take train+holdout disjoint. */
async function loadTaskIds(): Promise<string[]> {
  const { stdout } = await execFileAsync(
    PYTHON,
    ['-c', 'from appworld import load_task_ids; print("\\n".join(load_task_ids("dev")))'],
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
  const { stdout } = await execFileAsync(
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
      signal: ctx.signal,
    },
  )
  // The worker prints a compact verdict line; the full record is result.json.
  const result = JSON.parse(readFileSync(join(dir, 'result.json'), 'utf8')) as {
    tgc: number
    sgc: number
    completed: boolean
    cost_usd: number
    token_usage?: { input?: number; output?: number }
    tokenUsage?: { input?: number; output?: number }
    traces_path?: string
  }
  const inTok = result.token_usage?.input ?? result.tokenUsage?.input ?? 0
  const outTok = result.token_usage?.output ?? result.tokenUsage?.output ?? 0
  // Feed the cost meter so integrity:'assert' is satisfied (no silent stub).
  ctx.cost.observeTokens({ input: inTok, output: outTok })
  if (result.cost_usd) ctx.cost.observe(result.cost_usd, 'appworld-worker')
  void stdout
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

/** memory-curation entry — runs runImprovementLoop with the CURATOR driver. */
function memoryEntry(
  config: OptimizerEntryConfig<AppWorldScenario, AppWorldArtifact>,
): DriverEntry {
  return {
    name: 'memory-curation',
    async optimize() {
      const started = Date.now()
      const result = await runImprovementLoop<AppWorldScenario, AppWorldArtifact>({
        scenarios: config.trainScenarios,
        holdoutScenarios: config.holdoutScenarios,
        baselineSurface: config.baselineSurface,
        dispatchWithSurface: config.dispatchWithSurface,
        judges: config.judges,
        driver: memoryCurationDriver({}),
        populationSize: 1,
        maxGenerations: config.maxGenerations ?? MAX_GEN,
        gate: defaultProductionGate<AppWorldArtifact, AppWorldScenario>({
          holdoutScenarios: config.holdoutScenarios,
          deltaThreshold: 0,
        }),
        autoOnPromote: 'none',
        runDir: `${config.runDir}/memory-loop`,
        seed: config.seed ?? SEED,
      })
      const costUsd =
        result.baselineCampaign.aggregates.totalCostUsd +
        result.generations.reduce(
          (s, g) => s + g.surfaces.reduce((a, sf) => a + sf.campaign.aggregates.totalCostUsd, 0),
          0,
        )
      return { winnerSurface: result.winnerSurface, costUsd, durationMs: Date.now() - started }
    },
  }
}

/** halo entry — runs runImprovementLoop with the real halo-engine driver. */
function haloEntry(config: OptimizerEntryConfig<AppWorldScenario, AppWorldArtifact>): DriverEntry {
  return {
    name: 'halo',
    async optimize() {
      const started = Date.now()
      const result = await runImprovementLoop<AppWorldScenario, AppWorldArtifact>({
        scenarios: config.trainScenarios,
        holdoutScenarios: config.holdoutScenarios,
        baselineSurface: config.baselineSurface,
        dispatchWithSurface: config.dispatchWithSurface,
        judges: config.judges,
        driver: haloDriver({
          baseUrl: BASE_URL,
          apiKey: API_KEY,
          model: REFLECT_MODEL,
          // Concatenate the training traces the worker just emitted for halo to analyze.
          resolveTraces: () => {
            const lines: string[] = []
            for (const f of latestTracePaths) {
              try {
                lines.push(readFileSync(f, 'utf8').trim())
              } catch {
                /* a dropped cell has no traces; skip */
              }
            }
            return lines.filter(Boolean).join('\n')
          },
        }),
        populationSize: 1,
        maxGenerations: config.maxGenerations ?? MAX_GEN,
        gate: defaultProductionGate<AppWorldArtifact, AppWorldScenario>({
          holdoutScenarios: config.holdoutScenarios,
          deltaThreshold: 0,
        }),
        autoOnPromote: 'none',
        runDir: `${config.runDir}/halo-loop`,
        seed: config.seed ?? SEED,
      })
      const costUsd =
        result.baselineCampaign.aggregates.totalCostUsd +
        result.generations.reduce(
          (s, g) => s + g.surfaces.reduce((a, sf) => a + sf.campaign.aggregates.totalCostUsd, 0),
          0,
        )
      return { winnerSurface: result.winnerSurface, costUsd, durationMs: Date.now() - started }
    },
  }
}

// Track the most recent train-cell trace files so the halo driver can analyze them.
const latestTracePaths: string[] = []

async function main(): Promise<void> {
  const ids = await loadTaskIds()
  if (ids.length < TRAIN_N + HOLDOUT_N) {
    throw new Error(`AppWorld dev has ${ids.length} tasks; need ${TRAIN_N + HOLDOUT_N}`)
  }
  const trainScenarios: AppWorldScenario[] = ids
    .slice(0, TRAIN_N)
    .map((taskId) => ({ id: taskId, kind: 'appworld', taskId }))
  const holdoutScenarios: AppWorldScenario[] = ids
    .slice(TRAIN_N, TRAIN_N + HOLDOUT_N)
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

  // Wrap dispatch to record train-cell trace paths for the halo driver.
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

  const cfg: OptimizerEntryConfig<AppWorldScenario, AppWorldArtifact> = {
    baselineSurface,
    trainScenarios,
    holdoutScenarios,
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

  let drivers: DriverEntry[] = [gepaReflectionEntry(cfg), gepaParetoEntry(cfg), memoryEntry(cfg)]
  if (WITH_HALO) drivers.push(haloEntry(cfg))
  // BENCH_DRIVERS=gepa-reflection,memory-curation selects a subset (smoke / recovery).
  const only = (process.env.BENCH_DRIVERS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  if (only.length > 0) drivers = drivers.filter((d) => only.includes(d.name))
  if (drivers.length === 0) throw new Error(`BENCH_DRIVERS matched no drivers: ${only.join(',')}`)

  console.log(
    `[bench] model=${MODEL} reflect=${REFLECT_MODEL} train=${TRAIN_N} holdout=${HOLDOUT_N} gen=${MAX_GEN} pop=${POP} drivers=${drivers.map((d) => d.name).join(',')}`,
  )

  const comparison = await compareDrivers<AppWorldScenario, AppWorldArtifact>({
    drivers,
    baselineSurface,
    holdoutScenarios,
    dispatchWithSurface: recordingDispatch,
    judges: [appworldJudge],
    runDir: join(OUT_DIR, 'compare'),
    seed: SEED,
    expectUsage: 'assert', // NO STUBS — a zero-token cell fails loud, never silently scored 0
  })

  writeFileSync(join(OUT_DIR, 'comparison.json'), JSON.stringify(comparison, null, 2))
  const md = renderReport(comparison)
  writeFileSync(join(OUT_DIR, 'REPORT.md'), md)
  console.log(`\n${md}\n[bench] artifacts in ${OUT_DIR}`)
}

function renderReport(c: Awaited<ReturnType<typeof compareDrivers>>): string {
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
  return `# AppWorld driver-comparison benchmark

Public benchmark (AppWorld dev), objective scoring (\`world.evaluate\` TGC/SGC), paired bootstrap CIs.
Held-out scenarios: ${c.holdoutScenarioIds.length} — \`${c.holdoutScenarioIds.join(', ')}\`

| rank | driver | baseline | winner | lift | 95% CI | cost |
|---|---|---|---|---|---|---|
${rows}

**Best:** ${c.best.name} (lift ${(c.best.lift * 100).toFixed(1)}% [${(c.best.liftCi.low * 100).toFixed(1)}%, ${(c.best.liftCi.high * 100).toFixed(1)}%]).
**Significant lift (CI lower bound > 0):** ${sig || 'none'}.

Pairwise vs best:
${c.pairwise.map((p) => `- ${p.a} − ${p.b}: ${(p.deltaMean * 100).toFixed(1)}% [${(p.low * 100).toFixed(1)}%, ${(p.high * 100).toFixed(1)}%] → favored: ${p.favored}`).join('\n')}
`
}

main().catch((e) => {
  console.error('[bench] FAILED:', e instanceof Error ? e.stack : e)
  process.exit(1)
})
