/**
 * Simulated search: the real kernel, ledger and policies over a scripted
 * objective, a scripted proposer and a scripted executor.
 *
 * Every artifact has a hidden true quality. A child's quality is its parent's
 * plus a seeded step, a cell scores the quality plus seeded task and noise
 * terms, and a cell costs a seeded fraction of the lane's per-cell price, some
 * above the kernel's reservation. Scores, costs and faults depend only on the
 * seed and the cell or run id, so a resumed search reproduces the uninterrupted
 * one. The executor keeps each finished attempt on disk, which is what
 * `adopt` reads back after a restart, and logs every attempt it starts and
 * finishes.
 *
 *   node --import tsx scripts/search-sim.ts run --dir DIR [options]
 *   node --import tsx scripts/search-sim.ts kill-resume --dir DIR --kills 6 [options]
 *
 * `run` runs or resumes the search in DIR to its close. `kill-resume` runs the
 * search in DIR/killed as a child process, SIGKILLs it at seeded random ledger
 * sequences, resumes it each time, then runs the same search uninterrupted in
 * DIR/reference and compares the two.
 *
 * Options: --seed N (1), --train N (2), --selection N (6), --reps N (1),
 * --population N (3), --expansions N (6), --capacity N (4), --max-usd X
 * (none), --cell-usd X (0.05), --cost-cap hard|estimate (estimate),
 * --fault-rate X (0), --delay-ms N (5), --patience N.
 *
 * Output is one JSON document on stdout. Exit 1 when a check fails.
 */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { uniform } from '../src/campaign/allocation'
import { openSearchLedger } from '../src/campaign/search-ledger'
import { developmentClaim, SearchRecorder } from '../src/campaign/search-ledger-recording'
import {
  runSearch,
  type SearchArtifactCodec,
  type SearchCellResult,
  type SearchCellWork,
  type SearchExecutor,
  type SearchProposerPort,
} from '../src/campaign/search-kernel'
import { incumbent } from '../src/campaign/search-policy'
import type { SearchSourceRef, SearchTask } from '../src/campaign/search-ledger-types'
import type { SearchStateView } from '../src/campaign/search-state'
import { hashCanonical } from '../src/ledger-core/canonical'

interface SimArtifact {
  name: string
  quality: number
}

interface SimOptions {
  seed: number
  train: number
  selection: number
  reps: number
  population: number
  expansions: number
  capacity: number
  maxUsd: number | null
  cellUsd: number
  costCap: 'hard' | 'estimate'
  faultRate: number
  delayMs: number
  patience: number | undefined
}

const SEARCH_ID = 'search-sim'
const SIM_SOURCE: SearchSourceRef = {
  uri: 'script:scripts/search-sim.ts',
  revision: hashCanonical({ simulator: 'search-sim', version: 1 }),
}
const PROPOSAL_USD = 0.002

/** Uniform [0, 1) from the seed and a key: the simulator's only randomness. */
function unit(seed: number, ...key: Array<string | number>): number {
  const digest = createHash('sha256').update(JSON.stringify([seed, ...key])).digest()
  return digest.readUInt32BE(0) / 2 ** 32
}

function benchmark(options: SimOptions): SearchSourceRef {
  const { seed, train, selection } = options
  return { uri: 'sim://tasks', revision: hashCanonical({ seed, train, selection }) }
}

function round(value: number): number {
  return Math.round(value * 1e9) / 1e9
}

function tasks(prefix: string, count: number): SearchTask[] {
  return Array.from({ length: count }, (_, index) => ({
    taskId: `${prefix}${index}`,
    unitId: `${prefix}${index}`,
    source: { uri: `sim://task/${prefix}${index}`, revision: hashCanonical([prefix, index]) },
  }))
}

async function runSimulation(dir: string, options: SimOptions): Promise<Record<string, unknown>> {
  mkdirSync(join(dir, 'executor'), { recursive: true })
  const ledger = openSearchLedger({ path: join(dir, 'ledger.jsonl'), searchId: SEARCH_ID })
  const policy = incumbent(options.patience === undefined ? {} : { patience: options.patience })
  const allocation = uniform({ reps: options.reps })
  const recorder = await SearchRecorder.open(
    { ledger },
    {
      subject: 'sim/objective',
      process: { name: 'search-sim', executionRef: SIM_SOURCE },
      artifactKind: 'prompt',
      objective: {
        metric: 'score',
        direction: 'maximize',
        judge: { unknown: 'the simulator scores cells from a hidden quality' },
        claim: developmentClaim('search-sim'),
      },
      splits: {
        train: tasks('t', options.train),
        selection: tasks('s', options.selection),
        test: [],
        heldOutUnits: true,
      },
      policy: { expansion: policy.name, allocation: allocation.name, seed: options.seed },
      budget: {
        maxUsd: options.maxUsd,
        maxCells: null,
        maxNodes: 1 + options.population * options.expansions,
        deadline: null,
        maxConcurrency: null,
        reservedClaimUsd: 0,
      },
      containment: null,
      derivedFrom: null,
      identity: {
        model: { provider: 'sim', alias: 'sim', unknown: 'the simulator runs no model' },
        agent: SIM_SOURCE,
        benchmark: benchmark(options),
      },
    },
  )

  const codec: SearchArtifactCodec<SimArtifact> = {
    node: (rec, artifact) => {
      const ref = rec.blob('surface', { kind: 'sim-artifact', artifact })
      return {
        artifactDigest: hashCanonical(artifact),
        artifact: ref,
        surfaces: [{ surfaceId: 'prompt', kind: 'prompt', artifact: ref }],
      }
    },
    diff: (rec, parent, child) =>
      rec.blob('diff', { kind: 'sim-diff', from: parent.name, to: child.name }),
    load: (rec, node) => (rec.readBlob(node.artifact) as { artifact: SimArtifact }).artifact,
  }

  let inFlight = 0
  let peak = 0
  let lastChange = Date.now()
  let busyArea = 0
  const startedAt = Date.now()
  const track = (delta: number): void => {
    const now = Date.now()
    busyArea += inFlight * (now - lastChange)
    lastChange = now
    inFlight += delta
    peak = Math.max(peak, inFlight)
  }
  const executorDir = join(dir, 'executor')
  const resultPath = (runId: string): string =>
    join(executorDir, `${createHash('sha256').update(runId).digest('hex').slice(0, 24)}.json`)
  let adopted = 0

  const executor: SearchExecutor<SimArtifact> = {
    lanes: () => [
      {
        name: 'sim',
        capacity: options.capacity,
        costCap: options.costCap,
        cellUsd: options.cellUsd,
      },
    ],
    place: () => 'sim',
    async adopt(work) {
      if (!existsSync(resultPath(work.runId))) return null
      adopted += 1
      appendFileSync(join(executorDir, 'adopted.log'), `${work.runId}\n`)
      return JSON.parse(readFileSync(resultPath(work.runId), 'utf8')) as SearchCellResult
    },
    async run(work) {
      appendFileSync(join(executorDir, 'started.log'), `${work.runId}\n`)
      track(1)
      try {
        await new Promise((done) =>
          setTimeout(done, options.delayMs * (0.5 + unit(options.seed, 'delay', work.runId))),
        )
        const result = simulateCell(work, options)
        writeFileSync(resultPath(work.runId), JSON.stringify(result))
        appendFileSync(join(executorDir, 'finished.log'), `${work.runId}\n`)
        return result
      } finally {
        track(-1)
      }
    },
  }

  const proposer: SearchProposerPort<SimArtifact> = {
    name: 'search-sim',
    kind: 'optimizer',
    source: SIM_SOURCE,
    execution: { kind: 'deterministic', source: SIM_SOURCE },
    reservationUsd: PROPOSAL_USD,
    childrenPerProposal: options.population,
    async propose(request) {
      const parent = request.parents[0]!
      // Children are numbered after the parent's existing children, so a
      // proposal lost to a crash is proposed again identically.
      const state: SearchStateView = await recorder.state()
      const born = state.node(parent.nodeId)!.children.length
      return {
        children: Array.from({ length: options.population }, (_, index) => {
          const name = `${parent.artifact.name}.${born + index}`
          const step = -0.08 + 0.18 * unit(options.seed, 'step', name)
          return {
            artifact: { name, quality: round(parent.artifact.quality + step) },
            label: `step ${name}`,
            rationale: `a seeded step from ${parent.artifact.name}`,
          }
        }),
        accounting: {
          tokens: { status: 'known', inputTokens: 0, outputTokens: 0, cachedTokens: 0 },
          cost: { status: 'known', usd: PROPOSAL_USD, source: 'pricing-table' },
        },
      }
    },
  }

  const result = await runSearch({
    recorder,
    root: { name: 'root', quality: 0.5 },
    codec,
    policy,
    allocation,
    proposer,
    executor,
    maxExpansions: options.expansions,
  })
  track(0)
  const { audit } = result.state
  return {
    reason: result.reason,
    leader: result.leader,
    audit,
    lanes: {
      capacity: options.capacity,
      peakInFlight: peak,
      meanInFlight: round(busyArea / Math.max(1, Date.now() - startedAt)),
    },
    adopted,
  }
}

function simulateCell(work: SearchCellWork<SimArtifact>, options: SimOptions): SearchCellResult {
  const identity = {
    model: { provider: 'sim', alias: 'sim', unknown: 'the simulator runs no model' },
    agent: SIM_SOURCE,
    benchmark: benchmark(options),
  }
  const fraction = 0.4 + 0.8 * unit(options.seed, 'cost', work.cellId)
  const usd = round(
    options.costCap === 'hard'
      ? Math.min(options.cellUsd, options.cellUsd * fraction)
      : options.cellUsd * fraction,
  )
  const accounting = {
    tokens: { status: 'known' as const, inputTokens: 100, outputTokens: 50, cachedTokens: 0 },
    cost: { status: 'known' as const, usd, source: 'pricing-table' as const },
  }
  if (unit(options.seed, 'fault', work.runId) < options.faultRate) {
    return {
      outcome: {
        status: 'errored',
        metrics: {},
        error: { code: 'sim-fault', message: 'a simulated environment fault', retryable: true },
      },
      accounting,
      identity,
      placement: { lane: work.lane, boxId: null },
    }
  }
  const task = -0.1 + 0.2 * unit(options.seed, 'task', work.taskId)
  const noise = -0.15 + 0.3 * unit(options.seed, 'noise', work.cellId)
  const score = round(Math.min(1, Math.max(0, work.artifact.quality + task + noise)))
  return {
    outcome: { status: 'passed', score, metrics: { score } },
    accounting,
    identity,
    placement: { lane: work.lane, boxId: null },
  }
}

/** Facts two runs of one search must share, apart from attempt and operation numbering. */
function finalFacts(dir: string): Record<string, unknown> {
  const rows = readFileSync(join(dir, 'ledger.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { event: Record<string, unknown> & { kind: string } })
  const events = rows.map((row) => row.event)
  const of = (kind: string) => events.filter((event) => event.kind === kind)
  const allocated = of('cell-allocated').map((event) => event.cellId as string)
  const decided = new Map<string, string>()
  for (const event of of('node-decided')) {
    decided.set(event.nodeId as string, (event.decision as { status: string }).status)
  }
  const scores = new Map<string, number>()
  for (const event of of('cell-settled')) {
    const outcome = event.outcome as { status: string; score?: number }
    if (outcome.score !== undefined) scores.set(event.cellId as string, outcome.score)
  }
  return {
    nodes: of('node-registered')
      .map((event) => event.nodeId as string)
      .sort(),
    edges: of('edge-recorded')
      .map((event) =>
        JSON.stringify([event.childNodeId, event.parents, event.operator, event.attribution]),
      )
      .sort(),
    cells: [...new Set(allocated)].sort(),
    duplicateCellAllocations: allocated.length - new Set(allocated).size,
    scores: [...scores.entries()].sort(),
    decisions: [...decided.entries()].sort(),
    close: of('search-closed').map((event) => event.reason),
  }
}

function lines(path: string): string[] {
  return existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean) : []
}

function ledgerLength(dir: string): number {
  return lines(join(dir, 'ledger.jsonl')).length
}

async function runChild(
  dir: string,
  argv: string[],
  killAt: number | null,
): Promise<{ killed: boolean; atSequence: number; stdout: string }> {
  return new Promise((resolveChild, reject) => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', resolve(import.meta.dirname, 'search-sim.ts'), 'run', '--dir', dir, ...argv],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    )
    let stdout = ''
    let killed = false
    let atSequence = -1
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    const poll =
      killAt === null
        ? null
        : setInterval(() => {
            const length = ledgerLength(dir)
            if (length >= killAt && !killed && child.pid !== undefined) {
              killed = true
              atSequence = length
              process.kill(child.pid, 'SIGKILL')
            }
          }, 2)
    child.on('error', reject)
    child.on('exit', () => {
      if (poll) clearInterval(poll)
      resolveChild({ killed, atSequence, stdout })
    })
  })
}

async function killResume(dir: string, options: SimOptions, argv: string[], kills: number) {
  const reference = join(dir, 'reference')
  const killed = join(dir, 'killed')
  rmSync(dir, { recursive: true, force: true })
  const referenceRun = await runChild(reference, argv, null)
  const referenceSummary = JSON.parse(referenceRun.stdout) as Record<string, unknown>
  const total = ledgerLength(reference)
  const killPoints: number[] = []
  for (let index = 0; index < kills; index++) {
    const floor = killPoints.at(-1) ?? 1
    const at = floor + 1 + Math.floor(unit(options.seed, 'kill', index) * ((total - floor) / 2))
    if (at >= total) break
    const outcome = await runChild(killed, argv, at)
    killPoints.push(outcome.killed ? outcome.atSequence : ledgerLength(killed))
    if (!outcome.killed) break
  }
  const finalRun = await runChild(killed, argv, null)
  const resumedSummary = JSON.parse(finalRun.stdout) as Record<string, unknown>
  const expected = finalFacts(reference)
  const actual = finalFacts(killed)
  const same = (key: string) =>
    JSON.stringify(expected[key]) === JSON.stringify(actual[key])
  const started = lines(join(killed, 'executor', 'started.log'))
  const finished = lines(join(killed, 'executor', 'finished.log'))
  const adopted = lines(join(killed, 'executor', 'adopted.log'))
  const audit = resumedSummary.audit as {
    spend: { committedUsd: number; overspendUsd: number }
    operations: { started: number; recorded: number }
  }
  const checks = {
    sameNodes: same('nodes'),
    sameEdges: same('edges'),
    sameCells: same('cells'),
    sameScores: same('scores'),
    sameDecisions: same('decisions'),
    sameClose: same('close'),
    noDuplicateCellAllocations: actual.duplicateCellAllocations === 0,
    everyAttemptFinishedOnce: finished.length === new Set(finished).size,
    spendWithinCap:
      options.maxUsd === null ||
      audit.spend.committedUsd <= options.maxUsd + audit.spend.overspendUsd + 1e-9,
  }
  return {
    ok: Object.values(checks).every(Boolean),
    checks,
    kills: killPoints,
    referenceEntries: total,
    resumedEntries: ledgerLength(killed),
    attempts: {
      started: started.length,
      startedTwice: started.length - new Set(started).size,
      finished: finished.length,
      adopted: adopted.length,
    },
    reference: referenceSummary,
    resumed: resumedSummary,
    counts: {
      nodes: (actual.nodes as unknown[]).length,
      cells: (actual.cells as unknown[]).length,
      decisions: actual.decisions,
    },
  }
}

async function main(): Promise<void> {
  const [mode, ...argv] = process.argv.slice(2)
  const { values } = parseArgs({
    args: argv,
    options: {
      dir: { type: 'string' },
      seed: { type: 'string', default: '1' },
      train: { type: 'string', default: '2' },
      selection: { type: 'string', default: '6' },
      reps: { type: 'string', default: '1' },
      population: { type: 'string', default: '3' },
      expansions: { type: 'string', default: '6' },
      capacity: { type: 'string', default: '4' },
      'max-usd': { type: 'string' },
      'cell-usd': { type: 'string', default: '0.05' },
      'cost-cap': { type: 'string', default: 'estimate' },
      'fault-rate': { type: 'string', default: '0' },
      'delay-ms': { type: 'string', default: '5' },
      patience: { type: 'string' },
      kills: { type: 'string', default: '6' },
    },
  })
  if (!values.dir) throw new Error('--dir is required')
  const options: SimOptions = {
    seed: Number(values.seed),
    train: Number(values.train),
    selection: Number(values.selection),
    reps: Number(values.reps),
    population: Number(values.population),
    expansions: Number(values.expansions),
    capacity: Number(values.capacity),
    maxUsd: values['max-usd'] === undefined ? null : Number(values['max-usd']),
    cellUsd: Number(values['cell-usd']),
    costCap: values['cost-cap'] === 'hard' ? 'hard' : 'estimate',
    faultRate: Number(values['fault-rate']),
    delayMs: Number(values['delay-ms']),
    patience: values.patience === undefined ? undefined : Number(values.patience),
  }
  const passthrough = argv.filter((_, index) => {
    const flag = argv[index] === '--dir' || argv[index - 1] === '--dir'
    const kills = argv[index] === '--kills' || argv[index - 1] === '--kills'
    return !flag && !kills
  })
  if (mode === 'run') {
    console.log(JSON.stringify(await runSimulation(resolve(values.dir), options)))
    return
  }
  if (mode === 'kill-resume') {
    const report = await killResume(resolve(values.dir), options, passthrough, Number(values.kills))
    console.log(JSON.stringify(report, null, 2))
    if (!report.ok) process.exitCode = 1
    return
  }
  throw new Error(`unknown mode ${String(mode)}; use run or kill-resume`)
}

await main()
