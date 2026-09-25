/**
 * Simulated search: the real kernel, ledger, policies and claim over a scripted
 * objective, a scripted proposer and a scripted executor.
 *
 * Every artifact has a hidden true quality. A child's quality is its parent's
 * plus a seeded step (zero under `--null`), a cell scores the quality plus
 * seeded task and noise terms, and a cell costs a seeded fraction of the lane's
 * per-cell price, some above the kernel's reservation. Scores, costs and faults
 * depend only on the seed and the cell or run id, so a resumed search
 * reproduces the uninterrupted one. The executor keeps each finished attempt,
 * which is what `adopt` reads back after a restart, and logs every attempt it
 * starts and finishes.
 *
 *   node --import tsx scripts/search-sim.ts run --dir DIR [options]
 *   node --import tsx scripts/search-sim.ts kill-resume --dir DIR --kills 6 [options]
 *   node --import tsx scripts/search-sim.ts claims --searches 200 [options]
 *
 * `run` runs or resumes the search in DIR to its close. `kill-resume` runs the
 * search in DIR/killed as a child process, SIGKILLs it at seeded random ledger
 * sequences, resumes it each time, then runs the same search uninterrupted in
 * DIR/reference and compares the two. `claims` runs N searches with seeds
 * seed..seed+N-1 on in-memory ledgers and tallies their claims: a `ship` whose
 * selected node is no better than the root in truth is a false claim, and the
 * rate is reported with its Wilson and Clopper-Pearson 95% intervals.
 *
 * Options: --seed N (1), --train N (2), --selection N (6), --test N (0),
 * --reps N (1), --population N (3), --expansions N (6), --capacity N (4),
 * --max-usd X (none), --claim-usd X (0), --cell-usd X (0.05), --cost-cap
 * hard|estimate (estimate), --fault-rate X (0), --delay-ms N (5), --patience N,
 * --deadline ISO, --min-effect X (the claim's minimum effect), --null (every
 * step is 0, so no node differs from the root), --plant-gain X (the root's
 * first child is X better), --plant-divergence (the root's second child gains
 * 0.3 on train and loses 0.2 on selection and test), --judge-revision N|none (1).
 *
 * Output is one JSON document on stdout. Exit 1 when a check fails.
 */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { uniform } from '../src/campaign/allocation'
import {
  runSearch,
  type SearchArtifactCodec,
  type SearchCellResult,
  type SearchCellWork,
  type SearchExecutor,
  type SearchProposerPort,
  type SearchRunResult,
} from '../src/campaign/search-kernel'
import { openSearchLedger } from '../src/campaign/search-ledger'
import { developmentClaim, SearchRecorder } from '../src/campaign/search-ledger-recording'
import type { SearchSourceRef, SearchTask, SearchUnknown } from '../src/campaign/search-ledger-types'
import type { SearchStateView } from '../src/campaign/search-state'
import { incumbent } from '../src/campaign/search-policy'
import { type CampaignStorage, inMemoryCampaignStorage } from '../src/campaign/storage'
import { hashCanonical } from '../src/ledger-core/canonical'
import { wilson } from '../src/statistics/paired-binary'

interface SimArtifact {
  name: string
  quality: number
  /** Added to train scores only. */
  trainShift: number
  /** Added to selection and test scores. */
  heldShift: number
}

interface SimOptions {
  seed: number
  train: number
  selection: number
  test: number
  reps: number
  population: number
  expansions: number
  capacity: number
  maxUsd: number | null
  claimUsd: number
  cellUsd: number
  costCap: 'hard' | 'estimate'
  faultRate: number
  delayMs: number
  patience: number | undefined
  /** ISO time after which the search stops expanding and cancels waiting cells. */
  deadline: string | null
  minEffect: number | undefined
  nullSteps: boolean
  plantGain: number | null
  plantDivergence: boolean
  /** Null: the judge is not pinned. */
  judgeRevision: number | null
}

const SEARCH_ID = 'search-sim'
const SIM_SOURCE: SearchSourceRef = {
  uri: 'script:scripts/search-sim.ts',
  revision: hashCanonical({ simulator: 'search-sim', version: 2 }),
}
const PROPOSAL_USD = 0.002
const ROOT: SimArtifact = { name: 'root', quality: 0.5, trainShift: 0, heldShift: 0 }

/** Uniform [0, 1) from the seed and a key: the simulator's only randomness. */
function unit(seed: number, ...key: Array<string | number>): number {
  const digest = createHash('sha256').update(JSON.stringify([seed, ...key])).digest()
  return digest.readUInt32BE(0) / 2 ** 32
}

function benchmark(options: SimOptions): SearchSourceRef {
  const { seed, train, selection, test } = options
  return { uri: 'sim://tasks', revision: hashCanonical({ seed, train, selection, test }) }
}

function judge(options: SimOptions): SearchSourceRef | SearchUnknown {
  if (options.judgeRevision === null) return { unknown: 'the judge is not pinned (--judge-revision none)' }
  return {
    uri: 'script:scripts/search-sim.ts#judge',
    revision: hashCanonical({ judge: 'sim-score', version: options.judgeRevision }),
  }
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

/** Where a simulation keeps its ledger, blobs and executor results: a
 * directory, or process memory for the many searches of `claims`. */
interface SimStore {
  storage: CampaignStorage | null
  has(runId: string): boolean
  read(runId: string): SearchCellResult
  write(runId: string, result: SearchCellResult): void
  log(kind: 'started' | 'finished' | 'adopted', runId: string): void
}

function diskStore(dir: string): SimStore {
  const executorDir = join(dir, 'executor')
  mkdirSync(executorDir, { recursive: true })
  const resultPath = (runId: string): string =>
    join(executorDir, `${createHash('sha256').update(runId).digest('hex').slice(0, 24)}.json`)
  return {
    storage: null,
    has: (runId) => existsSync(resultPath(runId)),
    read: (runId) => JSON.parse(readFileSync(resultPath(runId), 'utf8')) as SearchCellResult,
    write: (runId, result) => writeFileSync(resultPath(runId), JSON.stringify(result)),
    log: (kind, runId) => appendFileSync(join(executorDir, `${kind}.log`), `${runId}\n`),
  }
}

function memoryStore(): SimStore {
  const results = new Map<string, SearchCellResult>()
  return {
    storage: inMemoryCampaignStorage(),
    has: (runId) => results.has(runId),
    read: (runId) => results.get(runId)!,
    write: (runId, result) => results.set(runId, result),
    log: () => {},
  }
}

async function runSimulation(
  dir: string,
  options: SimOptions,
  store: SimStore,
): Promise<{ result: SearchRunResult; summary: Record<string, unknown> }> {
  const path = join(dir, 'ledger.jsonl')
  const ledger = store.storage
    ? openSearchLedger({ path, searchId: SEARCH_ID, store: store.storage })
    : openSearchLedger({ path, searchId: SEARCH_ID })
  const policy = incumbent(options.patience === undefined ? {} : { patience: options.patience })
  const allocation = uniform({ reps: options.reps })
  const claim = developmentClaim('search-sim')
  const recorder = await SearchRecorder.open(
    { ledger, ...(store.storage ? { storage: store.storage } : {}) },
    {
      subject: 'sim/objective',
      process: { name: 'search-sim', executionRef: SIM_SOURCE },
      artifactKind: 'prompt',
      objective: {
        metric: 'score',
        direction: 'maximize',
        judge: judge(options),
        claim: options.minEffect === undefined ? claim : { ...claim, minimumEffect: options.minEffect },
      },
      splits: {
        train: tasks('t', options.train),
        selection: tasks('s', options.selection),
        test: tasks('x', options.test),
        heldOutUnits: true,
      },
      policy: { expansion: policy.name, allocation: allocation.name, seed: options.seed },
      budget: {
        maxUsd: options.maxUsd,
        maxCells: null,
        maxNodes: 1 + options.population * options.expansions,
        deadline: options.deadline,
        maxConcurrency: null,
        reservedClaimUsd: options.claimUsd,
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
  let adopted = 0
  const pause = (ms: number): Promise<void> =>
    ms > 0 ? new Promise((done) => setTimeout(done, ms)) : Promise.resolve()

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
      if (!store.has(work.runId)) return null
      adopted += 1
      store.log('adopted', work.runId)
      return store.read(work.runId)
    },
    async run(work) {
      store.log('started', work.runId)
      track(1)
      try {
        await pause(options.delayMs * (0.5 + unit(options.seed, 'delay', work.runId)))
        const result = simulateCell(work, options)
        store.write(work.runId, result)
        store.log('finished', work.runId)
        // The worker has finished; its response takes a while to arrive, so a
        // restart in this window finds a result to adopt.
        await pause(options.delayMs / 2)
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
        children: Array.from({ length: options.population }, (_, index) =>
          childOf(parent.artifact, `${parent.artifact.name}.${born + index}`, options),
        ),
        accounting: {
          tokens: { status: 'known', inputTokens: 0, outputTokens: 0, cachedTokens: 0 },
          cost: { status: 'known', usd: PROPOSAL_USD, source: 'pricing-table' },
        },
      }
    },
  }

  const result = await runSearch({
    recorder,
    root: ROOT,
    codec,
    policy,
    allocation,
    proposer,
    executor,
    maxExpansions: options.expansions,
  })
  track(0)
  const { state } = result
  const truth = (nodeId: string): SimArtifact => codec.load(recorder, state.node(nodeId)!)
  const testCells = state.cells().filter((cell) => cell.split === 'test')
  const invalid = state
    .nodes()
    .filter((node) => node.status === 'invalid')
    .map((node) => {
      const last = node.decisions.at(-1)!
      return { nodeId: node.nodeId, name: truth(node.nodeId).name, rule: last.rule, reason: last.reason }
    })
  const invalidIds = new Set(invalid.map((node) => node.nodeId))
  const claimed = result.claim
  const summary = {
    reason: result.reason,
    leader: result.leader,
    nodes: state.audit.nodes,
    claim: claimed && {
      decision: claimed.decision,
      selected: claimed.selected && {
        nodeId: claimed.selected,
        ...truth(claimed.selected),
      },
      reason: claimed.reason,
      power: claimed.power,
      finalists: claimed.finalists.map((finalist) => ({
        nodeId: finalist.nodeId,
        name: truth(finalist.nodeId).name,
        trueGain: round(truth(finalist.nodeId).quality - ROOT.quality),
        promote: finalist.promote,
        test: finalist.test,
      })),
    },
    testCells: {
      allocated: testCells.length,
      scored: testCells.filter((cell) => cell.score !== null).length,
      spentUsd: round(testCells.reduce((total, cell) => total + cell.spentUsd, 0)),
    },
    invalid,
    edgesFromInvalidParents: state
      .edges()
      .filter((edge) => edge.parents.some((parent) => invalidIds.has(parent.nodeId))).length,
    audit: state.audit,
    lanes: {
      capacity: options.capacity,
      peakInFlight: peak,
      meanInFlight: round(busyArea / Math.max(1, Date.now() - startedAt)),
      /** Of the time any cell ran, the share with every slot busy. */
      atCapacityShare: round(fullTime / Math.max(1, busyTime)),
    },
    adopted,
  }
  return { result, summary }
}

/** A proposed child: the parent's quality plus a seeded step (none under
 * `--null`), with the planted children replacing the step. */
function childOf(parent: SimArtifact, name: string, options: SimOptions) {
  let artifact: SimArtifact = {
    name,
    quality: round(
      parent.quality + (options.nullSteps ? 0 : -0.08 + 0.18 * unit(options.seed, 'step', name)),
    ),
    trainShift: parent.trainShift,
    heldShift: parent.heldShift,
  }
  let label = `step ${name}`
  if (options.plantGain !== null && name === 'root.0') {
    artifact = { ...artifact, quality: round(parent.quality + options.plantGain) }
    label = `planted gain ${options.plantGain}`
  }
  if (options.plantDivergence && name === 'root.1') {
    artifact = { ...artifact, trainShift: 0.3, heldShift: -0.2 }
    label = 'planted train-only gain'
  }
  return { artifact, label, rationale: `${label} from ${parent.name}` }
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
  const { artifact } = work
  const shift = work.split === 'train' ? artifact.trainShift : artifact.heldShift
  const task = -0.1 + 0.2 * unit(options.seed, 'task', work.taskId)
  const noise = -0.15 + 0.3 * unit(options.seed, 'noise', work.cellId)
  const score = round(Math.min(1, Math.max(0, artifact.quality + shift + task + noise)))
  return {
    outcome: { status: 'passed', score, metrics: { score } },
    accounting,
    identity,
    placement: { lane: work.lane, boxId: null },
  }
}

// ── claims: many searches, one tally ─────────────────────────────────

async function claims(options: SimOptions, searches: number): Promise<Record<string, unknown>> {
  const startedAt = Date.now()
  const decisions = { ship: 0, hold: 0, 'test-cannot-resolve': 0 }
  let testRan = 0
  let falseClaims = 0
  let trueClaims = 0
  let finalistsTested = 0
  let finalistsPromoted = 0
  let falsePromotions = 0
  let nodes = 0
  let cells = 0
  const finalistCounts: Record<number, number> = {}
  const powers: number[] = []
  const falseClaimSeeds: number[] = []
  for (let index = 0; index < searches; index++) {
    const seed = options.seed + index
    const { result, summary } = await runSimulation(
      `mem://search-sim/${seed}`,
      { ...options, seed },
      memoryStore(),
    )
    const claim = summary.claim as {
      decision: keyof typeof decisions
      selected: (SimArtifact & { nodeId: string }) | null
      power: { powerAtMinimumEffect?: number }
      finalists: Array<{ trueGain: number; promote: boolean; test: unknown }>
    }
    decisions[claim.decision] += 1
    nodes += result.state.audit.nodes
    cells += result.state.audit.cells.allocated
    if (claim.power.powerAtMinimumEffect !== undefined) powers.push(claim.power.powerAtMinimumEffect)
    const tested = claim.finalists.filter((finalist) => finalist.test !== null)
    if (tested.length > 0) {
      testRan += 1
      finalistCounts[tested.length] = (finalistCounts[tested.length] ?? 0) + 1
    }
    finalistsTested += tested.length
    for (const finalist of tested) {
      if (!finalist.promote) continue
      finalistsPromoted += 1
      if (finalist.trueGain <= 0) falsePromotions += 1
    }
    if (claim.decision === 'ship') {
      if (claim.selected!.quality - ROOT.quality > 0) trueClaims += 1
      else {
        falseClaims += 1
        falseClaimSeeds.push(seed)
      }
    }
  }
  powers.sort((a, b) => a - b)
  const quantile = (q: number): number | null =>
    powers.length === 0 ? null : powers[Math.min(powers.length - 1, Math.floor(q * powers.length))]!
  const rate = (successes: number) => ({
    count: successes,
    of: searches,
    rate: round(successes / searches),
    wilson95: interval(wilson(successes, searches, 0.95)),
    clopperPearson95: clopperPearson(successes, searches, 0.95),
  })
  return {
    searches,
    seeds: [options.seed, options.seed + searches - 1],
    design: {
      nodesPerSearch: 1 + options.population * options.expansions,
      train: options.train,
      selection: options.selection,
      test: options.test,
      reps: options.reps,
      minimumEffect: options.minEffect ?? null,
      truth: options.nullSteps
        ? `no node differs from the root${options.plantGain === null ? '' : `, except root.0 at +${options.plantGain} and its descendants`}`
        : 'seeded steps',
    },
    decisions,
    testRan,
    falseClaims: rate(falseClaims),
    trueClaims: rate(trueClaims),
    falseClaimSeeds,
    finalists: {
      perSearchWhenTested: finalistCounts,
      tested: finalistsTested,
      promoted: finalistsPromoted,
      promotedWithNoTrueGain: falsePromotions,
    },
    powerAtMinimumEffect: { min: quantile(0), median: quantile(0.5), max: quantile(1) },
    meanNodes: round(nodes / searches),
    meanCells: round(cells / searches),
    seconds: round((Date.now() - startedAt) / 1000),
  }
}

function interval(value: { lower: number; upper: number }): [number, number] {
  return [round(value.lower), round(value.upper)]
}

/** The exact binomial interval, by bisection on the binomial tail. */
function clopperPearson(successes: number, n: number, confidence: number): [number, number] {
  const alpha = (1 - confidence) / 2
  const cdf = (k: number, p: number): number => {
    // P(X <= k) for X ~ Binomial(n, p), summed in log space.
    let total = 0
    for (let i = 0; i <= k; i++) {
      total += Math.exp(
        logChoose(n, i) + (i === 0 ? 0 : i * Math.log(p)) + (n - i === 0 ? 0 : (n - i) * Math.log1p(-p)),
      )
    }
    return total
  }
  const solve = (f: (p: number) => number): number => {
    let low = 0
    let high = 1
    for (let step = 0; step < 100; step++) {
      const mid = (low + high) / 2
      if (f(mid) > 0) low = mid
      else high = mid
    }
    return (low + high) / 2
  }
  const lower = successes === 0 ? 0 : solve((p) => 1 - cdf(successes - 1, p) < alpha ? 1 : -1)
  const upper = successes === n ? 1 : solve((p) => (cdf(successes, p) > alpha ? 1 : -1))
  return [round(lower), round(upper)]
}

function logChoose(n: number, k: number): number {
  let total = 0
  for (let i = 1; i <= k; i++) total += Math.log(n - k + i) - Math.log(i)
  return total
}

// ── kill-resume ──────────────────────────────────────────────────────

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
    close: of('search-closed').map((event) => [event.reason, event.claim]),
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
      test: { type: 'string', default: '0' },
      reps: { type: 'string', default: '1' },
      population: { type: 'string', default: '3' },
      expansions: { type: 'string', default: '6' },
      capacity: { type: 'string', default: '4' },
      'max-usd': { type: 'string' },
      'claim-usd': { type: 'string', default: '0' },
      'cell-usd': { type: 'string', default: '0.05' },
      'cost-cap': { type: 'string', default: 'estimate' },
      'fault-rate': { type: 'string', default: '0' },
      'delay-ms': { type: 'string', default: '5' },
      patience: { type: 'string' },
      deadline: { type: 'string' },
      'min-effect': { type: 'string' },
      null: { type: 'boolean', default: false },
      'plant-gain': { type: 'string' },
      'plant-divergence': { type: 'boolean', default: false },
      'judge-revision': { type: 'string', default: '1' },
      kills: { type: 'string', default: '6' },
      searches: { type: 'string', default: '200' },
    },
  })
  const options: SimOptions = {
    seed: Number(values.seed),
    train: Number(values.train),
    selection: Number(values.selection),
    test: Number(values.test),
    reps: Number(values.reps),
    population: Number(values.population),
    expansions: Number(values.expansions),
    capacity: Number(values.capacity),
    maxUsd: values['max-usd'] === undefined ? null : Number(values['max-usd']),
    claimUsd: Number(values['claim-usd']),
    cellUsd: Number(values['cell-usd']),
    costCap: values['cost-cap'] === 'hard' ? 'hard' : 'estimate',
    faultRate: Number(values['fault-rate']),
    delayMs: Number(values['delay-ms']),
    patience: values.patience === undefined ? undefined : Number(values.patience),
    deadline: values.deadline ?? null,
    minEffect: values['min-effect'] === undefined ? undefined : Number(values['min-effect']),
    nullSteps: values.null,
    plantGain: values['plant-gain'] === undefined ? null : Number(values['plant-gain']),
    plantDivergence: values['plant-divergence'],
    judgeRevision: values['judge-revision'] === 'none' ? null : Number(values['judge-revision']),
  }
  if (mode === 'claims') {
    console.log(JSON.stringify(await claims(options, Number(values.searches)), null, 2))
    return
  }
  if (!values.dir) throw new Error('--dir is required')
  const passthrough = argv.filter((_, index) => {
    const flag = argv[index] === '--dir' || argv[index - 1] === '--dir'
    const kills = argv[index] === '--kills' || argv[index - 1] === '--kills'
    return !flag && !kills
  })
  if (mode === 'run') {
    const dir = resolve(values.dir)
    const { summary } = await runSimulation(dir, options, diskStore(dir))
    console.log(JSON.stringify(summary))
    return
  }
  if (mode === 'kill-resume') {
    const report = await killResume(resolve(values.dir), options, passthrough, Number(values.kills))
    console.log(JSON.stringify(report, null, 2))
    if (!report.ok) process.exitCode = 1
    return
  }
  throw new Error(`unknown mode ${String(mode)}; use run, kill-resume or claims`)
}

await main()
