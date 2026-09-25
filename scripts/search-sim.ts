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
 *   node --import tsx scripts/search-sim.ts compare --seeds 100 [options]
 *
 * `run` runs or resumes the search in DIR to its close. `kill-resume` runs the
 * search in DIR/killed as a child process, SIGKILLs it at seeded random ledger
 * sequences, resumes it each time, then runs the same search uninterrupted in
 * DIR/reference and compares the two. `compare` runs the search once per seed
 * under `uniform` and under `asha`, with in-memory ledgers, and reports the
 * cells each spent and the node each kept.
 *
 * Options: --seed N (1), --train N (2), --selection N (6), --reps N (1),
 * --population N (3), --expansions N (6), --capacity N (4), --max-usd X
 * (none), --cell-usd X (0.05), --cost-cap hard|estimate (estimate),
 * --fault-rate X (0), --delay-ms N (5), --patience N, --deadline ISO,
 * --allocation uniform|asha (uniform), --plant-gap X (none), --plant-child N
 * (seeded).
 *
 * `--plant-gap X` swaps the hill climb's steps for a planted pool: every child
 * is the root's quality plus a seeded step in [-0.1, 0), whatever its parent,
 * except child `c<N>` (the Nth registered, a seeded place in the pool by
 * default), which is the root plus X. The pool depends only on the seed and
 * the number of proposals, so `uniform` and `asha` measure the same
 * candidates and the planted child is the one right answer.
 *
 * Every run checks its ledger: each `advanced` and `pruned` decision must be
 * one the allocator makes again from the ledger before it, and every measured
 * edge's pairs against its parent are counted.
 *
 * Output is one JSON document on stdout. Exit 1 when a check fails.
 */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { asha, type SearchAllocator, uniform } from '../src/campaign/allocation'
import { estimateNode } from '../src/campaign/estimate-node'
import {
  openSearchLedger,
  parseSearchLedgerLine,
  replaySearchLedgerText,
} from '../src/campaign/search-ledger'
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
import { SearchState, type SearchStateView } from '../src/campaign/search-state'
import { canonicalString, hashCanonical } from '../src/ledger-core/canonical'

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
  /** ISO time after which the search stops expanding and cancels waiting cells. */
  deadline: string | null
  allocation: 'uniform' | 'asha'
  plantGap: number | null
  /** The planted child's registration index; null: seeded from the seed. */
  plantChild: number | null
}

const SEARCH_ID = 'search-sim'
const SIM_SOURCE: SearchSourceRef = {
  uri: 'script:scripts/search-sim.ts',
  revision: hashCanonical({ simulator: 'search-sim', version: 1 }),
}
const PROPOSAL_USD = 0.002
const ROOT_QUALITY = 0.5

/** Uniform [0, 1) from the seed and a key: the simulator's only randomness. */
function unit(seed: number, ...key: Array<string | number>): number {
  const digest = createHash('sha256')
    .update(JSON.stringify([seed, ...key]))
    .digest()
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

const MAX_ATTEMPTS = 3

/** The planted child's registration index: the option, or a seeded place in the pool. */
function plantIndex(options: SimOptions): number {
  return (
    options.plantChild ??
    Math.floor(unit(options.seed, 'plant') * options.population * options.expansions)
  )
}

function allocationOf(options: SimOptions): SearchAllocator {
  return options.allocation === 'asha'
    ? asha({ reps: options.reps })
    : uniform({ reps: options.reps })
}

/** In-process text for `compare`: the ledger's rules without a file. */
function memoryStore(): {
  read(path: string): string | undefined
  write(path: string, text: string): void
} {
  const texts = new Map<string, string>()
  return { read: (path) => texts.get(path), write: (path, text) => void texts.set(path, text) }
}

/**
 * Run or resume the search. With a directory the ledger and the executor's
 * finished attempts are files, so a killed process can resume; without one the
 * ledger is held in memory and nothing is written.
 */
async function runSimulation(
  dir: string | null,
  options: SimOptions,
): Promise<Record<string, unknown>> {
  const store = dir === null ? memoryStore() : null
  if (dir !== null) mkdirSync(join(dir, 'executor'), { recursive: true })
  const ledgerPath = dir === null ? 'memory/ledger.jsonl' : join(dir, 'ledger.jsonl')
  const ledger = store
    ? openSearchLedger({ path: ledgerPath, searchId: SEARCH_ID, store })
    : openSearchLedger({ path: ledgerPath, searchId: SEARCH_ID })
  const policy = incumbent(options.patience === undefined ? {} : { patience: options.patience })
  const allocation = allocationOf(options)
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
        deadline: options.deadline,
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
  let busyTime = 0
  let fullTime = 0
  const startedAt = Date.now()
  const track = (delta: number): void => {
    const now = Date.now()
    const span = now - lastChange
    busyArea += inFlight * span
    if (inFlight > 0) busyTime += span
    if (inFlight >= options.capacity) fullTime += span
    lastChange = now
    inFlight += delta
    peak = Math.max(peak, inFlight)
  }
  const executorDir = dir === null ? null : join(dir, 'executor')
  const resultPath = (runId: string): string =>
    join(executorDir!, `${createHash('sha256').update(runId).digest('hex').slice(0, 24)}.json`)
  const log = (name: string, runId: string): void => {
    if (executorDir !== null) appendFileSync(join(executorDir, name), `${runId}\n`)
  }
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
      if (executorDir === null || !existsSync(resultPath(work.runId))) return null
      adopted += 1
      log('adopted.log', work.runId)
      return JSON.parse(readFileSync(resultPath(work.runId), 'utf8')) as SearchCellResult
    },
    async run(work) {
      log('started.log', work.runId)
      track(1)
      try {
        await new Promise((done) =>
          setTimeout(done, options.delayMs * (0.5 + unit(options.seed, 'delay', work.runId))),
        )
        const result = simulateCell(work, options)
        if (executorDir !== null) writeFileSync(resultPath(work.runId), JSON.stringify(result))
        log('finished.log', work.runId)
        // The worker has finished; its response takes a while to arrive, so a
        // restart in this window finds a result to adopt.
        await new Promise((done) => setTimeout(done, options.delayMs / 2))
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
      // Children are numbered from what the ledger holds, so a proposal lost
      // to a crash is proposed again identically.
      const state: SearchStateView = await recorder.state()
      if (options.plantGap !== null) {
        // The planted pool: every child is the root plus a seeded step below
        // zero, whatever its parent, except one child planted `plantGap` above
        // the root. Both allocators then measure the same candidates.
        const born = state.audit.nodes - 1
        return {
          children: Array.from({ length: options.population }, (_, index) => {
            const name = `c${born + index}`
            const step =
              born + index === plantIndex(options)
                ? options.plantGap!
                : -0.1 * unit(options.seed, 'pool', name)
            return {
              artifact: { name, quality: round(ROOT_QUALITY + step) },
              label: `pool ${name}`,
              rationale: `a seeded pool candidate, proposed from ${parent.artifact.name}`,
            }
          }),
          accounting: {
            tokens: { status: 'known', inputTokens: 0, outputTokens: 0, cachedTokens: 0 },
            cost: { status: 'known', usd: PROPOSAL_USD, source: 'pricing-table' },
          },
        }
      }
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
    root: { name: 'root', quality: ROOT_QUALITY },
    codec,
    policy,
    allocation,
    proposer,
    executor,
    maxExpansions: options.expansions,
    maxAttempts: MAX_ATTEMPTS,
  })
  track(0)
  const { audit } = result.state
  const text = store?.read(ledgerPath) ?? readFileSync(ledgerPath, 'utf8')
  const kept = result.state.node(result.leader)!
  const artifactOf = (nodeId: string): SimArtifact =>
    (recorder.readBlob(result.state.node(nodeId)!.artifact) as { artifact: SimArtifact }).artifact
  const planted =
    options.plantGap === null
      ? null
      : (result.state
          .nodes()
          .find((node) => artifactOf(node.nodeId).name === `c${plantIndex(options)}`)?.nodeId ??
        null)
  return {
    reason: result.reason,
    leader: result.leader,
    kept: { ...artifactOf(kept.nodeId), status: kept.status, planted: kept.nodeId === planted },
    audit,
    ledgerChecks: checkLedger(text, allocation),
    lanes: {
      capacity: options.capacity,
      peakInFlight: peak,
      meanInFlight: round(busyArea / Math.max(1, Date.now() - startedAt)),
      /** Of the time any cell ran, the share with every slot busy. */
      atCapacityShare: round(fullTime / Math.max(1, busyTime)),
    },
    adopted,
  }
}

/** No cell of the node can run again, as the kernel counts it. */
function idle(state: SearchStateView, nodeId: string): boolean {
  const node = state.node(nodeId)
  if (!node || node.edgeIds.length === 0 || node.status === 'invalid') return false
  return state
    .cells({ nodeId })
    .every(
      (cell) =>
        cell.final ||
        cell.cancelled !== null ||
        (cell.outcome === 'errored' && cell.attempts >= MAX_ATTEMPTS),
    )
}

/**
 * Audit a closed ledger. Each `advanced` and `pruned` decision must be one the
 * allocator returns again from the ledger just before it (pruning keeps the
 * node the search selected), so every rank decision derives from recorded
 * evidence. Each measured node's contrast with its parent is counted by the
 * units they pair on, and cells are counted by stage.
 */
function checkLedger(text: string, allocation: SearchAllocator): Record<string, unknown> {
  const final = replaySearchLedgerText(text, SEARCH_ID, 'sim-ledger')
  const keep = final.audit.selectedNodeId ?? final.rootNodeId!
  const state = new SearchState(SEARCH_ID)
  const decisions = { advanced: 0, pruned: 0, unexplained: [] as string[] }
  const lines = text.trim().split('\n')
  for (const [index, line] of lines.entries()) {
    const entry = parseSearchLedgerLine(line, SEARCH_ID, { path: 'sim-ledger', line: index + 1 })
    const { event } = entry
    if (
      event.kind === 'node-decided' &&
      (event.decision.status === 'advanced' || event.decision.status === 'pruned')
    ) {
      const before = state.snapshot()
      const view = { state: before, idle: (nodeId: string) => idle(before, nodeId) }
      const expected =
        event.decision.status === 'advanced'
          ? allocation.advance(view)
          : allocation.prune(view, keep)
      const decision = canonicalString(event.decision)
      if (
        !expected.some(
          (made) => made.nodeId === event.nodeId && canonicalString(made.decision) === decision,
        )
      ) {
        decisions.unexplained.push(`${index}:${event.nodeId}:${decision}`)
      }
      decisions[event.decision.status] += 1
    }
    state.apply(entry, index)
  }
  const split = final.header!.splits.selection.tasks.length > 0 ? 'selection' : 'train'
  const edgePairs: Record<string, number> = {}
  for (const node of final.nodes()) {
    if (node.primaryParentId === null || final.scoredCells(node.nodeId, split).length === 0)
      continue
    const { pairs } = estimateNode(final, node.nodeId, { against: node.primaryParentId, split })
    edgePairs[pairs] = (edgePairs[pairs] ?? 0) + 1
  }
  const advancedTo: Record<string, number> = {}
  for (const node of final.nodes()) {
    for (const { decision } of node.decisions) {
      if (decision.status === 'advanced') {
        advancedTo[decision.rung] = (advancedTo[decision.rung] ?? 0) + 1
      }
    }
  }
  const cellsByStage: Record<string, number> = {}
  for (const cell of final.cells()) cellsByStage[cell.stage] = (cellsByStage[cell.stage] ?? 0) + 1
  const statuses: Record<string, number> = {}
  for (const node of final.nodes())
    statuses[node.status ?? 'none'] = (statuses[node.status ?? 'none'] ?? 0) + 1
  return {
    ok: decisions.unexplained.length === 0,
    decisions,
    edgePairs,
    advancedTo,
    cellsByStage,
    statuses,
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
      [
        '--import',
        'tsx',
        resolve(import.meta.dirname, 'search-sim.ts'),
        'run',
        '--dir',
        dir,
        ...argv,
      ],
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
    if (at >= total - 1) break
    const outcome = await runChild(killed, argv, at)
    killPoints.push(outcome.killed ? outcome.atSequence : ledgerLength(killed))
    if (!outcome.killed) break
  }
  const finalRun = await runChild(killed, argv, null)
  const resumedSummary = JSON.parse(finalRun.stdout) as Record<string, unknown>
  const expected = finalFacts(reference)
  const actual = finalFacts(killed)
  const same = (key: string) => JSON.stringify(expected[key]) === JSON.stringify(actual[key])
  const started = lines(join(killed, 'executor', 'started.log'))
  const finished = lines(join(killed, 'executor', 'finished.log'))
  const adopted = lines(join(killed, 'executor', 'adopted.log'))
  const audit = resumedSummary.audit as {
    spend: { committedUsd: number; overspendUsd: number }
    operations: { started: number; recorded: number }
  }
  // A uniform search's decisions do not depend on the order cells finish in,
  // so the resumed search must equal the uninterrupted one. An asha search
  // ranks the nodes that finished a rung when a node finishes it, so a
  // restart that changes the finishing order may change a promotion; there
  // the resumed ledger must hold only rank decisions its own evidence makes.
  const reproduces = {
    sameNodes: same('nodes'),
    sameEdges: same('edges'),
    sameCells: same('cells'),
    sameScores: same('scores'),
    sameDecisions: same('decisions'),
    sameClose: same('close'),
  }
  const ledgerChecks = resumedSummary.ledgerChecks as { ok: boolean }
  const invariants = {
    noDuplicateCellAllocations: actual.duplicateCellAllocations === 0,
    everyAttemptFinishedOnce: finished.length === new Set(finished).size,
    rankDecisionsFromEvidence: ledgerChecks.ok,
    spendWithinCap:
      options.maxUsd === null ||
      audit.spend.committedUsd <= options.maxUsd + audit.spend.overspendUsd + 1e-9,
  }
  const checks = { ...reproduces, ...invariants }
  const required = options.allocation === 'uniform' ? checks : invariants
  return {
    ok: Object.values(required).every(Boolean),
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

/**
 * The same search under `uniform` and `asha`, once per seed from `options.seed`:
 * cells each allocated, the node each kept, and the units each measured edge
 * pairs on. Ledgers are held in memory; every run's ledger audit must pass.
 */
async function compare(options: SimOptions, seeds: number) {
  interface ArmRow {
    cells: number
    nodes: number
    kept: string
    quality: number
    planted: boolean
    ledgerOk: boolean
    edgePairs: Record<string, number>
    advancedTo: Record<string, number>
  }
  const rows: Array<{ seed: number; uniform: ArmRow; asha: ArmRow }> = []
  for (let seed = options.seed; seed < options.seed + seeds; seed++) {
    const arms = {} as Record<'uniform' | 'asha', ArmRow>
    for (const allocation of ['uniform', 'asha'] as const) {
      const arm = await runSimulation(null, { ...options, seed, allocation })
      const audit = arm.audit as { cells: { allocated: number }; nodes: number }
      const kept = arm.kept as { name: string; quality: number; planted: boolean }
      const checks = arm.ledgerChecks as {
        ok: boolean
        edgePairs: Record<string, number>
        advancedTo: Record<string, number>
      }
      arms[allocation] = {
        cells: audit.cells.allocated,
        nodes: audit.nodes,
        kept: kept.name,
        quality: kept.quality,
        planted: kept.planted,
        ledgerOk: checks.ok,
        edgePairs: checks.edgePairs,
        advancedTo: checks.advancedTo,
      }
    }
    rows.push({ seed, ...arms })
  }
  const add = (into: Record<string, number>, from: Record<string, number>): void => {
    for (const [key, value] of Object.entries(from)) into[key] = (into[key] ?? 0) + value
  }
  const arm = (name: 'uniform' | 'asha') => {
    const list = rows.map((row) => row[name])
    const cells = list.map((row) => row.cells).sort((a, b) => a - b)
    const edgePairs: Record<string, number> = {}
    const advancedTo: Record<string, number> = {}
    for (const row of list) {
      add(edgePairs, row.edgePairs)
      add(advancedTo, row.advancedTo)
    }
    const pairCounts = Object.keys(edgePairs).map(Number)
    return {
      cells: {
        total: cells.reduce((sum, value) => sum + value, 0),
        min: cells[0],
        median: cells[Math.floor(cells.length / 2)],
        max: cells.at(-1),
      },
      nodes: list.reduce((sum, row) => sum + row.nodes, 0),
      keptPlanted: list.filter((row) => row.planted).length,
      meanKeptQuality: round(list.reduce((sum, row) => sum + row.quality, 0) / list.length),
      ledgerAuditsPassed: list.filter((row) => row.ledgerOk).length,
      /** Measured edges by the units they pair on against their parent. */
      edgePairs,
      minEdgePairs: pairCounts.length === 0 ? null : Math.min(...pairCounts),
      /** `advanced` decisions by the rung they opened. */
      advancedTo,
    }
  }
  const uniformArm = arm('uniform')
  const ashaArm = arm('asha')
  return {
    ok: uniformArm.ledgerAuditsPassed === rows.length && ashaArm.ledgerAuditsPassed === rows.length,
    seeds: rows.length,
    sameKept: rows.filter((row) => row.uniform.kept === row.asha.kept).length,
    ashaFewerCells: rows.filter((row) => row.asha.cells < row.uniform.cells).length,
    ashaCellShare: round(ashaArm.cells.total / uniformArm.cells.total),
    uniform: uniformArm,
    asha: ashaArm,
    differing: rows
      .filter((row) => row.uniform.kept !== row.asha.kept)
      .map((row) => ({
        seed: row.seed,
        uniform: { kept: row.uniform.kept, quality: row.uniform.quality, cells: row.uniform.cells },
        asha: { kept: row.asha.kept, quality: row.asha.quality, cells: row.asha.cells },
      })),
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
      deadline: { type: 'string' },
      kills: { type: 'string', default: '6' },
      allocation: { type: 'string', default: 'uniform' },
      'plant-gap': { type: 'string' },
      'plant-child': { type: 'string' },
      seeds: { type: 'string', default: '100' },
    },
  })
  if (values.allocation !== 'uniform' && values.allocation !== 'asha') {
    throw new Error(`--allocation must be uniform or asha, got ${values.allocation}`)
  }
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
    deadline: values.deadline ?? null,
    allocation: values.allocation,
    plantGap: values['plant-gap'] === undefined ? null : Number(values['plant-gap']),
    plantChild: values['plant-child'] === undefined ? null : Number(values['plant-child']),
  }
  if (mode === 'compare') {
    const report = await compare(options, Number(values.seeds))
    console.log(JSON.stringify(report, null, 2))
    if (!report.ok) process.exitCode = 1
    return
  }
  if (!values.dir) throw new Error('--dir is required')
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
