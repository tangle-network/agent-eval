/**
 * Gated stop against blind continuation, at one matched token budget.
 *
 * The question: when an agent may stop only after an executable held-out check
 * passes, does a fixed total token budget finish more tasks than the same
 * budget spent on unconditional continuation? The mechanism under test is
 * budget ALLOCATION, not detection — a row that the check clears early returns
 * its unspent budget to the pool, and the pool pays for extra steps on rows
 * that have not cleared.
 *
 * Two arms, one policy, one grader:
 *
 *   blind-continue   resumes the recorded prefix and spends its whole per-row
 *                    allotment whatever the check says. Graded at its BEST
 *                    intermediate state, so it cannot lose a pass it reached
 *                    and then walked out of.
 *   gated-continue   resumes the same prefix under the same policy and stops
 *                    the moment the check passes. What it did not spend is
 *                    reallocated to rows still failing, until its realized
 *                    tokens match the blind arm.
 *
 * Both arms grade after every step with the task's own held-out suite,
 * injected from outside the container and purged after. The check that gates
 * the treatment arm is the same check that scores both, which is the strongest
 * form of the gate and the reason the blind arm is graded at its best
 * intermediate state rather than its last one.
 *
 * Every rule that decides anything is registered before a row is graded:
 * `sealExperiment` hashes the arms, the admission funnel, the estimand, the
 * interval, the matched-budget tolerance and the decision rule into one
 * digest, and `openSealedExperiment` is the only path that executes them.
 * The power floor is a registered gate, so a structure that cannot see the
 * effect refuses the spend instead of producing an interval nobody can read.
 *
 *   node --import tsx scripts/tb-gated-stop-ab.ts design
 *   node --import tsx scripts/tb-gated-stop-ab.ts pilot --rows 6 --steps 8
 *   node --import tsx scripts/tb-gated-stop-ab.ts run
 */

import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import {
  clusteredPower,
  defineExperiment,
  type EvidenceRecord,
  openSealedExperiment,
  sealExperiment,
} from '../src/experiment'
import {
  injectedTestOracle,
  MINI_SWE_SYSTEM_MESSAGE,
  parseAction,
  parseTaskOracleRegistry,
  stratumOf,
  renderFormatErrorObservation,
  renderInstanceMessage,
  renderObservation,
  renderTimeoutObservation,
  type RepairSession,
  submissionOf,
  type TestSuiteFile,
  testSuiteDigest,
} from '../src/trace-repair'
import { parseRecordedReturncode } from '../src/trajectory-replay/steps'

const run = promisify(execFile)

const TB2 = '/home/drew/bench-cache/terminal-bench-2'
const WORK = '/home/drew/bench-cache/gated-stop-ab'
const ROWS_PATH = join(WORK, 'rows-decoded.json')
const TASK_ORACLES_PATH = join(import.meta.dirname, '..', 'benchmarks', 'trace-repair', 'task-oracles.json')

/** z.ai coding plan, OpenAI-compatible. The seat this run is entitled to. */
const MODEL = 'glm-5.2'
const BASE_URL = 'https://api.z.ai/api/coding/paas/v4/chat/completions'
const PRICING = { inputUsdPerMillion: 0.6, outputUsdPerMillion: 2.2 }
/** At most three in flight on this seat, so a 429 storm cannot be mistaken for a slow model. */
const SEAT_CONCURRENCY = 3
/** A dead transport must read as dead in seconds, not in a hung run. */
const MODEL_DEADLINE_MS = 180_000
const STEP_TIMEOUT_SECONDS = 30
const REPLAY_TIMEOUT_MS = 120_000
const GRADE_TIMEOUT_MS = 420_000
const COST_CEILING_USD = 25

/** Per-row model steps the blind arm spends whatever the check says. */
const STEP_ALLOTMENT = 8
/**
 * Rows a task must carry before it is a cluster.
 *
 * Two is the smallest that lets a cluster vary. It is a floor on the cluster,
 * not a cap on the draw: the confirmatory selection takes every admitted row,
 * because a structure that drops admitted rows loses the power they carry and
 * the drop would have to be registered as a rule of its own.
 */
const ROWS_PER_CLUSTER = 2

/**
 * Strata a row may carry.
 *
 * A signal kill ends on a command the environment stopped, and substituting one
 * command does not address a timeout, so the substrate's admission excludes it
 * by default and this study reads the same rule.
 */
const ADMITTED_STRATA: readonly string[] = ['clean-exit', 'command-error']

// ── Rows ─────────────────────────────────────────────────────────────

interface CorpusRow {
  rowId: string
  taskName: string
  recordedModel: string
  trialName: string
  trialId: string
  recordedCommands: number
  placeholderCommands: number
  formatErrorTurns: number
  unknownReturncodes: number
  unknownRatio: number
  finalReturncode: number | null
  finalOutcome: string
  endedOnSubmitSentinel: boolean
  imageLocal: boolean
  steps: { step_id: number; action: string; observation: string | null }[]
}

function loadCorpus(): CorpusRow[] {
  return JSON.parse(readFileSync(ROWS_PATH, 'utf8')) as CorpusRow[]
}

/** The evidence record the sealed admission funnel reads. Never the outcome. */
function admissionRecord(
  row: CorpusRow,
  clusterSize: number,
  recordedEndStateFails: boolean,
  canonicalTrialRow: boolean,
  prefixDivergenceRatio: number,
): EvidenceRecord {
  return {
    rowId: row.rowId,
    taskName: row.taskName,
    placeholderCommands: row.placeholderCommands,
    finalReturncodeKnown: row.finalReturncode !== null,
    stratum: stratumOf(row.finalReturncode) ?? 'unreadable',
    unknownRatio: row.unknownRatio,
    recordedCommands: row.recordedCommands,
    imageLocal: row.imageLocal,
    canonicalTrialRow,
    prefixDivergenceRatio,
    clusterSize,
    recordedEndStateFails,
  }
}

/**
 * Row ids the dump holds twice.
 *
 * 885 mini-swe-agent trials appear in the published dump under both an empty
 * and a populated trial id, and the two copies are the same recorded run. A
 * cluster that pairs them carries one trajectory twice, which the bootstrap
 * reads as two independent rows. The copy carrying the trial id is canonical
 * because it identifies the run; the other is dropped.
 */
function canonicalTrialRowIds(rows: readonly CorpusRow[]): Set<string> {
  const canonical = new Map<string, CorpusRow>()
  for (const row of rows) {
    const trial = `${row.taskName}::${row.trialName}`
    const held = canonical.get(trial)
    if (held === undefined || (row.trialId !== '' && held.trialId === '')) canonical.set(trial, row)
  }
  return new Set([...canonical.values()].map((row) => row.rowId))
}

/** What the end-state screen measured about one row. */
interface EndStateMeasurement {
  endStatePassed: boolean
  replayedCommands: number
  replayDivergences: number
}

/**
 * What the end-state screen measured, by row id.
 *
 * A row whose end state already passes cannot measure a repair — every arm
 * wins it for free — so it is excluded. A row the screen has not reached is
 * excluded too, and so is a row whose screen hit a boundary failure: neither
 * produced a verdict, and an unmeasured row that reads as failing is admitted
 * on a check that never ran.
 */
function endStateScreen(): Record<string, EndStateMeasurement> {
  try {
    return JSON.parse(readFileSync(join(WORK, 'end-state-screen.json'), 'utf8')) as Record<
      string,
      EndStateMeasurement
    >
  } catch {
    return {}
  }
}

/** Share of replayed steps whose exit differed from the recording. */
function divergenceRatio(measurement: EndStateMeasurement | undefined): number {
  if (measurement === undefined || measurement.replayedCommands === 0) return 1
  return measurement.replayDivergences / measurement.replayedCommands
}

// ── The registered design ────────────────────────────────────────────

/**
 * The effect grid the power gate is judged on.
 *
 * These are the per-row net win rates the reallocation mechanism can plausibly
 * produce: the freed budget is bounded by how often a row clears the check
 * early, and one extra step on a row that eight did not fix is not a coin
 * flip. A grid that reached 0.5 would let the gate pass on an effect nothing
 * in this mechanism can generate, which is the failure the gate exists to stop.
 */
const REGISTERED_EFFECT_GRID = [0.05, 0.1, 0.15, 0.2]
const POWER_TARGET = 0.8
const POWER_SIM = { trials: 3000, resamples: 3000, seed: 20260814 }

function buildSpec(certifiedTasks: string[], sealedRowIds: string[], take: number, pilotExposed: string[]) {
  return defineExperiment({
    id: 'gated-stop-vs-blind-continue-tb-repair-v1',
    hypothesis:
      'At one matched realized-token budget, an agent that may stop only after an executable ' +
      'held-out check passes finishes more rows than the same agent spending the identical ' +
      'budget on unconditional continuation. The mechanism is budget allocation: budget freed ' +
      'by an early clear pays for extra steps on rows that have not cleared.',
    arms: [
      {
        id: 'blind-continue',
        role: 'control',
        pins: {
          model: MODEL,
          stepAllotment: STEP_ALLOTMENT,
          stopRule: 'spend-the-allotment-unconditionally',
          gradedAt: 'best-intermediate-state',
          temperature: 0,
          scaffold: 'mini-swe-agent',
        },
      },
      {
        id: 'gated-continue',
        role: 'treatment',
        pins: {
          model: MODEL,
          stepAllotment: STEP_ALLOTMENT,
          stopRule: 'stop-when-held-out-check-passes',
          reallocation: 'unspent-budget-to-rows-still-failing',
          gradedAt: 'best-intermediate-state',
          temperature: 0,
          scaffold: 'mini-swe-agent',
        },
      },
    ],
    outcome: {
      kind: 'binary',
      source: 'injected-suite',
      digestVerified: true,
      pass: 'reward-file-contains-1',
      droppedRollouts: 'forbidden',
    },
    admission: {
      population:
        'terminalbench-trajectories, mini-swe-agent rows with reward 0, on tasks whose oracle certification is checked in',
      stages: [
        {
          id: 'certified-deterministic-oracle',
          keep: { kind: 'in', field: 'taskName', values: [...certifiedTasks] },
        },
        {
          id: 'replayable-commands-and-final-returncode',
          keep: {
            kind: 'all',
            of: [
              { kind: 'compare', field: 'placeholderCommands', op: 'eq', value: 0 },
              { kind: 'compare', field: 'finalReturncodeKnown', op: 'eq', value: true },
            ],
          },
        },
        {
          id: 'stratum-carries-a-repairable-failure',
          keep: { kind: 'in', field: 'stratum', values: ['clean-exit', 'command-error'] },
        },
        {
          id: 'unknown-returncode-ratio-at-most-25pct',
          keep: { kind: 'compare', field: 'unknownRatio', op: 'lte', value: 0.25 },
        },
        {
          id: 'recorded-commands-at-most-25',
          keep: { kind: 'compare', field: 'recordedCommands', op: 'lte', value: 25 },
        },
        {
          id: 'image-present-locally-at-pinned-digest',
          keep: { kind: 'compare', field: 'imageLocal', op: 'eq', value: true },
        },
        {
          id: 'one-row-per-recorded-trial',
          keep: { kind: 'compare', field: 'canonicalTrialRow', op: 'eq', value: true },
        },
        {
          id: 'recorded-end-state-fails-its-own-suite',
          keep: { kind: 'compare', field: 'recordedEndStateFails', op: 'eq', value: true },
        },
        {
          id: 'prefix-divergence-at-most-10pct',
          keep: { kind: 'compare', field: 'prefixDivergenceRatio', op: 'lte', value: 0.1 },
        },
        {
          id: 'not-exposed-by-the-mechanism-pilot',
          keep: { kind: 'not', of: { kind: 'in', field: 'rowId', values: [...pilotExposed] } },
        },
        {
          id: 'task-carries-at-least-two-rows',
          keep: { kind: 'compare', field: 'clusterSize', op: 'gte', value: ROWS_PER_CLUSTER },
        },
      ],
    },
    selections: {
      confirmatory: {
        kind: 'round-robin',
        groupBy: 'taskName',
        groupOrder: 'lex-asc',
        withinOrder: { field: 'rowId', dir: 'asc' },
        take,
        reads: ['taskName', 'rowId'],
      },
    },
    estimands: {
      pairedContrast: {
        kind: 'paired-mean-diff',
        armField: 'arm',
        treatment: 'gated-continue',
        control: 'blind-continue',
        pairBy: 'rowId',
        value: 'passed',
        missing: 'zero-diff',
      },
    },
    intervals: {
      pairedContrast95: {
        kind: 'cluster-bootstrap',
        clusterBy: 'taskName',
        resamples: 10_000,
        seed: 20260814,
        level: 0.95,
        method: 'percentile',
      },
    },
    gates: {
      powerFloor: {
        kind: 'power-floor',
        target: POWER_TARGET,
        effectGrid: [...REGISTERED_EFFECT_GRID],
        sim: { ...POWER_SIM },
      },
      servedModel: { kind: 'identity', field: 'served-model', op: 'basename-eq', onFail: 'abort' },
    },
    halt: {
      when: { kind: 'any-gate-failed', gates: ['powerFloor'] },
      action: 'refuse-spend',
      report: 'settling-n',
    },
    matchedBudget: {
      measure: 'realized-tokens',
      tolerance: 0.05,
      onFail: 'refuse-contrast',
    },
    decision: {
      kind: 'table',
      branches: [
        {
          when: {
            kind: 'all',
            of: [
              { kind: 'interval-excludes-zero', interval: 'pairedContrast95', sign: 'positive' },
              { kind: 'obligation-met', obligation: 'matched-realized-tokens' },
            ],
          },
          verdict: 'gated-stop-survives',
          report: ['pairedContrast', 'pairedContrast95'],
        },
        {
          when: {
            kind: 'all',
            of: [
              { kind: 'interval-excludes-zero', interval: 'pairedContrast95', sign: 'negative' },
              { kind: 'obligation-met', obligation: 'matched-realized-tokens' },
            ],
          },
          verdict: 'gated-stop-dies',
          report: ['pairedContrast', 'pairedContrast95'],
        },
        {
          when: { kind: 'interval-includes-zero', interval: 'pairedContrast95' },
          verdict: 'no-effect-resolved-at-this-n',
          report: ['pairedContrast', 'pairedContrast95'],
        },
        {
          when: { kind: 'not', of: { kind: 'obligation-met', obligation: 'matched-realized-tokens' } },
          verdict: 'contrast-refused-unmatched-budget',
          report: ['pairedContrast95'],
        },
      ],
    },
    sealedSubsets: { confirmatoryRows: sealedRowIds },
    seedDerivation: { from: ['seed', 'rowId', 'rolloutIndex'] },
    seed: 20260814,
    obligations: [
      {
        id: 'matched-realized-tokens',
        appliesToVerdicts: ['gated-stop-survives', 'gated-stop-dies'],
        control:
          'realized prompt+completion tokens agree within 5 % between arms, verified by the registered matched-budget rule',
      },
    ],
  })
}

// ── Containers, replay, grading ──────────────────────────────────────

interface TaskFixture {
  name: string
  image: string
  cwd: string
  suite: TestSuiteFile[]
  suiteDigest: string
  instruction: string
}

function loadSuite(task: string): TestSuiteFile[] {
  const dir = join(TB2, task, 'tests')
  const files: TestSuiteFile[] = []
  const walk = (rel: string): void => {
    for (const entry of readdirSync(join(dir, rel))) {
      const relPath = rel ? `${rel}/${entry}` : entry
      if (statSync(join(dir, relPath)).isDirectory()) walk(relPath)
      else files.push({ path: `/tests/${relPath}`, contents: readFileSync(join(dir, relPath), 'utf8') })
    }
  }
  walk('')
  return files
}

async function loadTask(name: string): Promise<TaskFixture> {
  const tag = `alexgshaw/${name}:20251031`
  const { stdout: digest } = await run('docker', ['image', 'inspect', tag, '--format', '{{index .RepoDigests 0}}'])
  const { stdout: workdir } = await run('docker', ['image', 'inspect', tag, '--format', '{{.Config.WorkingDir}}'])
  const suite = loadSuite(name)
  return {
    name,
    image: digest.trim(),
    cwd: workdir.trim() || '/app',
    suite,
    suiteDigest: testSuiteDigest(suite),
    instruction: readFileSync(join(TB2, name, 'instruction.md'), 'utf8'),
  }
}

interface ExecResult {
  returncode: number
  output: string
  timedOut: boolean
}

async function openContainer(task: TaskFixture, label: string): Promise<RepairSession & { exec2: (c: string, ms: number) => Promise<ExecResult> }> {
  const name = `gsab-${label}-${randomUUID().slice(0, 8)}`
  await run('docker', [
    'run', '-d', '--name', name, '--entrypoint', '', '--memory', '2g', '--cpus', '1',
    task.image, 'sleep', 'infinity',
  ])
  await run('docker', ['exec', name, 'mkdir', '-p', '/logs/verifier', '/logs/agent', '/logs/artifacts'])
  const exec2 = async (command: string, timeoutMs: number): Promise<ExecResult> => {
    const seconds = Math.ceil(timeoutMs / 1000)
    try {
      const { stdout, stderr } = await run(
        'docker',
        ['exec', '-e', 'DEBIAN_FRONTEND=noninteractive', '-w', task.cwd, name, 'timeout', '--kill-after=5', String(seconds), 'bash', '-lc', command],
        { maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs + 30_000 },
      )
      return { returncode: 0, output: `${stdout}${stderr}`, timedOut: false }
    } catch (error) {
      const err = error as { code?: number; stdout?: string; stderr?: string }
      const code = typeof err.code === 'number' ? err.code : 1
      return { returncode: code, output: `${err.stdout ?? ''}${err.stderr ?? ''}`, timedOut: code === 124 || code === 137 }
    }
  }
  return {
    ref: name,
    exec: async (command: string, timeoutMs: number) => {
      const r = await exec2(command, timeoutMs)
      return { exitCode: r.returncode, stdout: r.output, stderr: '', timedOut: r.timedOut }
    },
    close: async () => {
      await run('docker', ['rm', '-f', name]).catch(() => undefined)
    },
    exec2,
  }
}

// ── The seat ─────────────────────────────────────────────────────────

interface ModelReply {
  content: string
  servedModel: string
  promptTokens: number
  completionTokens: number
}

let inFlight = 0
const waiting: (() => void)[] = []

/** At most `SEAT_CONCURRENCY` calls on the seat at once. */
async function withSeat<T>(fn: () => Promise<T>): Promise<T> {
  if (inFlight >= SEAT_CONCURRENCY) await new Promise<void>((resolve) => waiting.push(resolve))
  inFlight += 1
  try {
    return await fn()
  } finally {
    inFlight -= 1
    waiting.shift()?.()
  }
}

async function callModel(messages: { role: string; content: string }[]): Promise<ModelReply> {
  const key = process.env.ZAI_GLM_API_KEY?.trim() || process.env.ZAI_API_KEY?.trim()
  if (!key) throw new Error('ZAI_GLM_API_KEY is required')
  return withSeat(async () => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), MODEL_DEADLINE_MS)
    try {
      const response = await fetch(BASE_URL, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: MODEL, messages, temperature: 0, max_tokens: 4096 }),
        signal: controller.signal,
      })
      if (!response.ok) throw new Error(`seat answered HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`)
      const body = (await response.json()) as {
        model?: string
        choices?: { message?: { content?: string } }[]
        usage?: { prompt_tokens?: number; completion_tokens?: number }
      }
      const usage = body.usage
      if (typeof usage?.prompt_tokens !== 'number' || typeof usage?.completion_tokens !== 'number') {
        throw new Error('seat reported no usage; a token budget cannot be matched against a missing count')
      }
      return {
        content: body.choices?.[0]?.message?.content ?? '',
        servedModel: body.model ?? 'unreported',
        promptTokens: usage.prompt_tokens,
        completionTokens: usage.completion_tokens,
      }
    } finally {
      clearTimeout(timer)
    }
  })
}

// ── One row, one arm ─────────────────────────────────────────────────

interface StepRecord {
  step: number
  servedModel: string
  promptTokens: number
  completionTokens: number
  action: string | null
  formatError: boolean
  submitted: boolean
  returncode: number | null
  gradePassed: boolean
  gradeMs: number
  stepMs: number
}

interface RowRun {
  rowId: string
  taskName: string
  arm: string
  replayedCommands: number
  replayDivergences: number
  endStatePassed: boolean
  steps: StepRecord[]
  passedAtStep: number | null
  bestPassed: boolean
  promptTokens: number
  completionTokens: number
  costUsd: number
  wallMs: number
  error: string | null
}

interface RunRowOptions {
  row: CorpusRow
  task: TaskFixture
  arm: string
  /** Model steps this run may spend. */
  allotment: number
  /** Stop the moment the held-out check passes. */
  stopOnPass: boolean
  log: (line: string) => void
}

async function runRow(options: RunRowOptions): Promise<RowRun> {
  const { row, task, arm, allotment, stopOnPass, log } = options
  const startedMs = Date.now()
  const oracle = injectedTestOracle({
    files: task.suite,
    command:
      'chmod +x /tests/test.sh; rm -f /logs/verifier/reward.txt; ' +
      '(/tests/test.sh) > /logs/verifier/test-stdout.txt 2>&1; ' +
      'grep -qx 1 /logs/verifier/reward.txt',
    purge: ['/tests'],
    commandTimeoutMs: GRADE_TIMEOUT_MS,
  })
  const record: RowRun = {
    rowId: row.rowId,
    taskName: row.taskName,
    arm,
    replayedCommands: 0,
    replayDivergences: 0,
    endStatePassed: false,
    steps: [],
    passedAtStep: null,
    bestPassed: false,
    promptTokens: 0,
    completionTokens: 0,
    costUsd: 0,
    wallMs: 0,
    error: null,
  }
  const session = await openContainer(task, `${arm}-${row.taskName}`.slice(0, 40))
  try {
    const messages: { role: string; content: string }[] = [
      { role: 'system', content: MINI_SWE_SYSTEM_MESSAGE },
      { role: 'user', content: renderInstanceMessage({ task: task.instruction, systemInformation: 'Linux x86_64' }) },
    ]
    for (const step of row.steps) {
      const result = await session.exec2(step.action, REPLAY_TIMEOUT_MS)
      record.replayedCommands += 1
      const recorded = parseRecordedReturncode(step.observation)
      if (recorded !== result.returncode) record.replayDivergences += 1
      messages.push({ role: 'assistant', content: `Replaying the recorded step.\n\n\`\`\`bash\n${step.action}\n\`\`\`` })
      messages.push({
        role: 'user',
        content: result.timedOut
          ? renderTimeoutObservation(step.action, result.output.slice(0, 2000))
          : renderObservation({ returncode: result.returncode, output: result.output }),
      })
    }
    // The oracle context takes the substrate's arm vocabulary, which names the
    // container state under test: the recorded end state before any step of
    // this study, and an intervened state after one. This study's own arm
    // label rides on the record below.
    const endState = await oracle.grade(session, { rowId: row.rowId, arm: 'end-state', rolloutIndex: 0 })
    record.endStatePassed = endState.passed
    log(`${row.rowId} ${arm} replayed=${record.replayedCommands} divergences=${record.replayDivergences} endStatePassed=${endState.passed}`)

    let consecutiveFormatErrors = 0
    for (let step = 1; step <= allotment; step += 1) {
      const stepStarted = Date.now()
      const reply = await callModel(messages)
      record.promptTokens += reply.promptTokens
      record.completionTokens += reply.completionTokens
      messages.push({ role: 'assistant', content: reply.content })
      const parsed = parseAction(reply.content)
      let returncode: number | null = null
      let submitted = false
      let action: string | null = null
      if (parsed.kind === 'format-error') {
        consecutiveFormatErrors += 1
        messages.push({ role: 'user', content: renderFormatErrorObservation(parsed.actionCount) })
      } else {
        consecutiveFormatErrors = 0
        action = parsed.command
        const result = await session.exec2(parsed.command, STEP_TIMEOUT_SECONDS * 1000)
        returncode = result.returncode
        submitted = submissionOf({ returncode: result.returncode, output: result.output }) !== null
        messages.push({
          role: 'user',
          content: result.timedOut
            ? renderTimeoutObservation(parsed.command, result.output.slice(0, 2000))
            : renderObservation({ returncode: result.returncode, output: result.output }),
        })
      }
      const gradeStarted = Date.now()
      const graded = await oracle.grade(session, { rowId: row.rowId, arm: 'intervention', rolloutIndex: step })
      const gradeMs = Date.now() - gradeStarted
      if (graded.passed && record.passedAtStep === null) record.passedAtStep = step
      record.bestPassed = record.bestPassed || graded.passed
      record.steps.push({
        step,
        servedModel: reply.servedModel,
        promptTokens: reply.promptTokens,
        completionTokens: reply.completionTokens,
        action,
        formatError: parsed.kind === 'format-error',
        submitted,
        returncode,
        gradePassed: graded.passed,
        gradeMs,
        stepMs: Date.now() - stepStarted,
      })
      log(
        `${row.rowId} ${arm} step=${step}/${allotment} passed=${graded.passed} rc=${returncode} ` +
          `tokens=${reply.promptTokens}+${reply.completionTokens} gradeMs=${gradeMs}`,
      )
      if (graded.passed && stopOnPass) break
      if (consecutiveFormatErrors >= 3) {
        record.error = 'three consecutive format errors'
        break
      }
    }
  } catch (error) {
    record.error = (error as Error).message
    log(`${row.rowId} ${arm} ERROR ${record.error}`)
  } finally {
    await session.close()
  }
  record.costUsd =
    (record.promptTokens / 1e6) * PRICING.inputUsdPerMillion +
    (record.completionTokens / 1e6) * PRICING.outputUsdPerMillion
  record.wallMs = Date.now() - startedMs
  return record
}

// ── Design ───────────────────────────────────────────────────────────

interface Design {
  certifiedTasks: string[]
  records: EvidenceRecord[]
  clusters: { taskName: string; rowIds: string[] }[]
  rows: CorpusRow[]
  take: number
}

/**
 * Rows and their cluster structure, prepared for the sealed admission rule.
 *
 * Nothing here decides admission: the predicates live in the spec and run
 * through `openSealedExperiment().admit`, so the funnel a report prints is the
 * funnel the seal registered.
 */
function prepare(assumeScreened: boolean): Design {
  const corpus = loadCorpus()
  const registry = parseTaskOracleRegistry(JSON.parse(readFileSync(TASK_ORACLES_PATH, 'utf8')))
  const certifiedTasks = [...registry.values()]
    .filter((verdict) => verdict.stable)
    .map((verdict) => verdict.taskName)
    .sort()

  // Rows that would survive the row-level predicates, counted per task, so the
  // cluster-size field the last stage reads is a property of the population.
  const canonical = canonicalTrialRowIds(corpus)
  const screen = endStateScreen()
  // Every stage above the cluster count, including the end-state screen. A
  // task whose second row the screen removes is not a cluster of two, and a
  // cluster of one carries no paired contrast for the bootstrap to resample.
  const eligible = corpus.filter(
    (row) =>
      certifiedTasks.includes(row.taskName) &&
      row.placeholderCommands === 0 &&
      row.finalReturncode !== null &&
      row.unknownRatio <= 0.25 &&
      row.recordedCommands <= 25 &&
      row.imageLocal &&
      ADMITTED_STRATA.includes(stratumOf(row.finalReturncode) ?? 'unreadable') &&
      canonical.has(row.rowId) &&
      (assumeScreened || screen[row.rowId]?.endStatePassed === false) &&
      (assumeScreened || divergenceRatio(screen[row.rowId]) <= 0.1),
  )
  const sizes = new Map<string, number>()
  for (const row of eligible) sizes.set(row.taskName, (sizes.get(row.taskName) ?? 0) + 1)
  const records = corpus.map((row) =>
    admissionRecord(
      row,
      sizes.get(row.taskName) ?? 0,
      assumeScreened ? true : screen[row.rowId]?.endStatePassed === false,
      canonical.has(row.rowId),
      assumeScreened ? 0 : divergenceRatio(screen[row.rowId]),
    ),
  )
  const clusterRows = [...sizes.values()].filter((n) => n >= ROWS_PER_CLUSTER)
  return {
    certifiedTasks,
    records,
    clusters: [],
    rows: corpus,
    take: clusterRows.reduce((total, n) => total + n, 0),
  }
}

// ── Entry points ─────────────────────────────────────────────────────

/**
 * Row ids the pilot already ran on.
 *
 * The pilot wrote ids under the corpus's earlier key, which named a trial by
 * its name alone. Names repeat across trials, so an exposed id resolves to
 * every current id that extends it — the conservative reading, which excludes
 * a sibling rather than risk reusing an exposed trajectory.
 */
function pilotExposedRowIds(currentIds: readonly string[]): string[] {
  const recorded = new Set<string>()
  for (const file of ['pilot.json', 'mechanism-pilot.json']) {
    let parsed: { results?: { rowId?: string }[] }
    try {
      parsed = JSON.parse(readFileSync(join(WORK, file), 'utf8')) as { results?: { rowId?: string }[] }
    } catch {
      continue
    }
    for (const result of parsed.results ?? []) if (result.rowId) recorded.add(result.rowId)
  }
  return currentIds
    .filter((id) => [...recorded].some((exposedId) => id === exposedId || id.startsWith(`${exposedId}::`)))
    .sort()
}

function logger(path: string): (line: string) => void {
  writeFileSync(path, '', { flag: 'a' })
  return (line: string) => {
    const text = `${new Date().toISOString()} ${line}\n`
    process.stdout.write(text)
    writeFileSync(path, text, { flag: 'a' })
  }
}

async function main(): Promise<void> {
  const mode = process.argv[2] ?? 'design'
  mkdirSync(WORK, { recursive: true })
  const design = prepare(mode === 'screen')
  // Rows the mechanism pilot ran on. They are registered as excluded so a
  // later confirmatory run meets its rows unexposed.
  const exposed = pilotExposedRowIds(design.records.map((record) => String(record.rowId)))

  // The draw runs through the registered rules before the registration that
  // pins it: a draft seal executes the admission funnel and the selection, and
  // the final seal carries the ids they produced. Re-running `select` against
  // the sealed subset below is what proves the two agree.
  const draft = await openSealedExperiment(
    await sealExperiment(buildSpec(design.certifiedTasks, [], design.take, exposed)),
  )
  const admitted = draft.admit(design.records)
  const drawn = draft.select('confirmatory', admitted.survivors, { idField: 'rowId' })

  const sealed = await sealExperiment(buildSpec(design.certifiedTasks, drawn, design.take, exposed))
  const registered = await openSealedExperiment(sealed)
  const redrawn = registered.select('confirmatory', registered.admit(design.records).survivors, {
    idField: 'rowId',
  })
  if (redrawn.join('|') !== drawn.join('|')) {
    throw new Error('the sealed subset does not reproduce from the sealed selection rule')
  }

  const byRowId = new Map(design.rows.map((row) => [row.rowId, row]))
  const chosen = drawn.map((id) => byRowId.get(id)!)
  const clusters = [...new Set(chosen.map((row) => row.taskName))].sort().map((taskName) => ({
    taskName,
    rowIds: chosen.filter((row) => row.taskName === taskName).map((row) => row.rowId),
  }))
  const power = clusteredPower({
    clusterSizes: clusters.map((cluster) => cluster.rowIds.length),
    effects: [...REGISTERED_EFFECT_GRID],
    seed: POWER_SIM.seed,
    trials: POWER_SIM.trials,
    resamples: POWER_SIM.resamples,
    targetPower: POWER_TARGET,
    baseWinRate: 0.05,
    baseLossRate: 0.05,
  })
  const powerGate = registered.gate('powerFloor', {
    kind: 'power-floor',
    curve: power.curve.map((point) => ({ effect: point.effect, power: point.power })),
  })
  const halt = registered.halt([powerGate])

  const designReport = {
    generatedAt: new Date().toISOString(),
    sealDigest: sealed.digest,
    sealedAt: sealed.sealedAt,
    clusters,
    clusterCount: clusters.length,
    rowCount: chosen.length,
    funnel: admitted.funnel,
    registeredEffectGrid: REGISTERED_EFFECT_GRID,
    power,
    powerGate,
    halt,
    settlingN: null as unknown,
  }
  writeFileSync(join(WORK, 'design.json'), `${JSON.stringify(designReport, null, 2)}\n`)
  process.stdout.write(
    `seal=${sealed.digest}\nclusters=${clusters.length} rows=${chosen.length}\n` +
      `funnel: ${admitted.funnel.input} -> ${admitted.funnel.surviving} admitted -> ${chosen.length} drawn\n` +
      `power: ${power.curve.map((p) => `${p.effect}=>${p.power.toFixed(2)}`).join(' ')}\n` +
      `gate powerFloor passed=${powerGate.passed}; halt fired=${halt.fired} action=${halt.action ?? 'none'}\n`,
  )

  if (mode === 'design') return

  if (mode === 'screen') {
    // The end-state screen: replay each admitted row and grade the state the
    // recording ended on. A row whose own suite already passes there cannot
    // measure a repair, so the registered funnel drops it. No model call.
    const log = logger(join(WORK, 'screen.log'))
    // A row already screened keeps its measured verdict. The screen opens a
    // container per row and the corpus is hundreds of rows long, so a run that
    // restarted from zero after an interruption would pay for the whole set
    // again and could not be resumed at all.
    const measured = endStateScreen()
    const rows = admitted.survivors
      .map((record) => byRowId.get(String(record.rowId))!)
      .filter((row) => measured[row.rowId] === undefined)
    log(`screen start rows=${rows.length} alreadyMeasured=${Object.keys(measured).length}`)
    const tasks = new Map<string, TaskFixture>()
    for (const name of new Set(rows.map((row) => row.taskName))) tasks.set(name, await loadTask(name))
    const screened: Record<string, EndStateMeasurement> = { ...endStateScreen() }
    let next = 0
    await Promise.all(
      Array.from({ length: Math.min(SEAT_CONCURRENCY, rows.length) }, async () => {
        for (;;) {
          const index = next
          next += 1
          if (index >= rows.length) return
          const row = rows[index]!
          const result = await runRow({
            row,
            task: tasks.get(row.taskName)!,
            arm: 'end-state-screen',
            allotment: 0,
            stopOnPass: false,
            log,
          })
          // A row whose screen hit a boundary failure produced no verdict.
          // Writing its default `false` would admit it on a check that never
          // ran, which is the same corruption as a silent zero.
          if (result.error === null) {
            screened[row.rowId] = {
              endStatePassed: result.endStatePassed,
              replayedCommands: result.replayedCommands,
              replayDivergences: result.replayDivergences,
            }
            writeFileSync(join(WORK, 'end-state-screen.json'), `${JSON.stringify(screened, null, 2)}\n`)
          }
        }
      }),
    )
    const passing = Object.values(screened).filter((m) => m.endStatePassed).length
    log(`screen done rows=${rows.length} endStatePassed=${passing}`)
    return
  }

  if (mode === 'pilot') {
    // A pilot measures the mechanism's INPUT — how often a row clears the check
    // at all, and at which step — so the effect the confirmatory design would
    // need to see is estimated from data instead of assumed. It is not the
    // sealed contrast and never enters it.
    const rowsArg = Number(process.argv[process.argv.indexOf('--rows') + 1] ?? '6')
    const stepsArg = Number(process.argv[process.argv.indexOf('--steps') + 1] ?? String(STEP_ALLOTMENT))
    const log = logger(join(WORK, 'pilot.log'))
    // Rows the funnel admitted but the sealed draw did not take. The sealed 16
    // stay unexposed, so a later confirmatory run at a larger n still meets
    // them fresh.
    const drawnIds = new Set(drawn)
    const spare = admitted.survivors
      .map((record) => byRowId.get(String(record.rowId))!)
      .filter((row) => row !== undefined && !drawnIds.has(row.rowId))
      .sort((a, b) => a.rowId.localeCompare(b.rowId))
    const rows = spare.slice(0, rowsArg)
    if (rows.length < rowsArg) {
      log(`only ${rows.length} unsealed rows available; the pilot runs on those and never on the sealed draw`)
    }
    const tasks = new Map<string, TaskFixture>()
    for (const name of new Set(rows.map((r) => r.taskName))) tasks.set(name, await loadTask(name))
    log(`pilot rows=${rows.length} steps=${stepsArg} seal=${sealed.digest}`)
    const outPath = join(WORK, process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1]! : 'pilot.json')
    const results: RowRun[] = []
    let spent = 0
    let next = 0
    // Three rows at a time: the seat allows three calls in flight, so a fourth
    // row would only queue behind the same limiter and hold a container open.
    await Promise.all(
      Array.from({ length: Math.min(SEAT_CONCURRENCY, rows.length) }, async () => {
        for (;;) {
          const index = next
          next += 1
          if (index >= rows.length) return
          if (spent > COST_CEILING_USD) {
            log(`cost ceiling ${COST_CEILING_USD} reached, stopping`)
            return
          }
          const row = rows[index]!
          const result = await runRow({
            row,
            task: tasks.get(row.taskName)!,
            arm: 'pilot-blind-continue',
            allotment: stepsArg,
            stopOnPass: false,
            log,
          })
          spent += result.costUsd
          results.push(result)
          writeFileSync(outPath, `${JSON.stringify({ sealDigest: sealed.digest, stepAllotment: stepsArg, results }, null, 2)}\n`)
        }
      }),
    )
    log(`pilot done rows=${results.length} spentUsd=${spent.toFixed(4)}`)
    return
  }

  throw new Error(`unknown mode '${mode}'`)
}

main().catch((error) => {
  process.stderr.write(`${(error as Error).stack}\n`)
  process.exit(1)
})
