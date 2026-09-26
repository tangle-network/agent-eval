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
 *   node --import tsx scripts/search-sim.ts compare --seeds 200 [options]
 *   node --import tsx scripts/search-sim.ts plateau --seeds 40 --ceiling 0.62 [options]
 *   node --import tsx scripts/search-sim.ts adaptive --seeds 40 --skills 3 --pool-gap 0.05 [options]
 *   node --import tsx scripts/search-sim.ts lens-null --seeds 40 --null [options]
 *
 * `run` runs or resumes the search in DIR to its close; with `--in-memory` it
 * runs without a per-append fsync and writes the ledger and blobs to DIR at
 * the end, for scale ledgers. `kill-resume` runs the
 * search in DIR/killed as a child process, SIGKILLs it at seeded random ledger
 * sequences, resumes it each time, then runs the same search uninterrupted in
 * DIR/reference and compares the two. `claims` runs N searches with seeds
 * seed..seed+N-1 on in-memory ledgers and tallies their claims: a `ship` whose
 * selected node is no better than the root in truth is a false claim, and the
 * rate is reported with its Wilson and Clopper-Pearson 95% intervals.
 * `compare` runs the search once per seed under `uniform` and under `asha` on
 * in-memory ledgers and reports the cells each allocated, the node each kept,
 * and the units each measured edge pairs on against its parent. `plateau`
 * runs each seed under `incumbent` and under `draftOnPlateau(incumbent)` and
 * reports, paired by seed, the kept and best true quality, the drafts, and
 * the `landscape` lens (plateau score, basins) on each closed ledger.
 * `adaptive` fits `skillManifold` on one `uniform` calibration search
 * (`--calibration-seed`, 1000, on the same task bank), keeps
 * its loadings with `skillCalibration`, then runs each seed under `asha` and
 * under `asha` extended by `nextUnitExtension`, paired by seed. `lens-null`
 * runs flat searches (`--null`) and reports the landscape lens's basin count,
 * surface and plateau on each, which calibrates the lens against a known
 * flat truth.
 *
 * Options: --seed N (1), --train N (2), --selection N (6), --test N (0),
 * --reps N (1), --population N (3), --expansions N (6), --capacity N (4),
 * --max-usd X (none), --claim-usd X (0), --cell-usd X (0.05), --cost-cap
 * hard|estimate (estimate), --fault-rate X (0), --delay-ms N (5), --patience N,
 * --deadline ISO, --min-effect X (the claim's minimum effect), --null (every
 * step is 0, so no node differs from the root), --plant-gain X (the root's
 * first child is X better), --plant-divergence (the root's second child gains
 * 0.3 on train and loses 0.2 on selection and test), --judge-revision N|none (1),
 * --binary (a cell passes with probability quality + shift + task and scores 1
 * or 0), --minimize (the objective is minimized and a cell reports 1 minus its
 * score, so a better artifact scores lower), --cost-scale X (1: a cell costs X
 * times what the lane's prior assumes, so an estimate lane overspends until
 * its own cost distribution sets the hold), --allocation
 * uniform|asha|asha-adaptive (uniform), --pool-gap X (none), --pool-plant N
 * (seeded).
 *
 * Geometry options: `--skills K` gives artifacts K latent skills (axis 0
 * general, every task loads it; each task also loads one specialist axis),
 * and a cell scores 0.5 plus the skills on its task's demand; `--skill-spread
 * X` (0.12) spreads pool candidates on each specialist axis over [-X, 0);
 * `--bank-seed N` (the seed) fixes the task bank across searches;
 * `--ceiling X` caps the root's lineage at X while a draft's lineage can climb
 * 0.25 higher; `--policy incumbent|draft-on-plateau`; `--allocation
 * asha-adaptive --calibration FILE` extends asha with a saved calibration.
 * Under these options every artifact carries profile lines that each child
 * edits, so the landscape lens measures line edits between surfaces.
 *
 * `--pool-gap X` swaps the hill climb's steps for a planted pool: every child
 * is the root's quality plus a seeded step in [-0.1, 0), whatever its parent,
 * except child `c<N>` (the Nth registered, a seeded place in the pool unless
 * `--pool-plant` names it), which is the root plus X. The pool depends only on
 * the seed and the number of proposals, so `uniform` and `asha` measure the
 * same candidates and the planted child is the one right answer.
 *
 * Every run audits its ledger: each `advanced` and `pruned` decision, with its
 * rule, rank reason and estimate, must be one the allocator makes again from
 * the ledger just before it.
 *
 * Output is one JSON document on stdout. Exit 1 when a check fails.
 */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { asha, type SearchAllocator, uniform } from '../src/campaign/allocation'
import { estimateNode } from '../src/campaign/estimate-node'
import {
  runSearch,
  type SearchArtifactCodec,
  type SearchCellResult,
  type SearchCellWork,
  type SearchExecutor,
  type SearchProposerPort,
  type SearchRunResult,
} from '../src/campaign/search-kernel'
import {
  openSearchLedger,
  parseSearchLedgerLine,
  replaySearchLedgerText,
} from '../src/campaign/search-ledger'
import { developmentClaim, SearchRecorder } from '../src/campaign/search-ledger-recording'
import type {
  SearchSourceRef,
  SearchTask,
  SearchUnknown,
} from '../src/campaign/search-ledger-types'
import { SearchState, type SearchStateView } from '../src/campaign/search-state'
import { draftOnPlateau, incumbent, type SearchPolicy } from '../src/campaign/search-policy'
import { type CampaignStorage, inMemoryCampaignStorage } from '../src/campaign/storage'
import { canonicalString, hashCanonical } from '../src/ledger-core/canonical'
import {
  type LandscapeEmbedding,
  landscape,
  lineEditDistance,
} from '../src/search/lenses/landscape'
import {
  nextUnitExtension,
  type SkillCalibration,
  skillCalibration,
  skillManifold,
} from '../src/search/lenses/skill-manifold'
import { wilson } from '../src/statistics/paired-binary'
import { pairedBootstrap, pairedSignTest } from '../src/statistics/paired-tests'

interface SimArtifact {
  name: string
  quality: number
  /** Added to train scores only. */
  trainShift: number
  /** Added to selection and test scores. */
  heldShift: number
  /** Latent skills under `--skills K`: a cell's expected score is 0.5 plus
   * these loaded on its task's demand. Absent otherwise. */
  skill?: number[]
  /** The lineage's basin under `--ceiling`: 0 is the root's, and each draft
   * starts its own. Absent otherwise. */
  basin?: number
  /** Profile text under the geometry options: each child edits a line of
   * its parent's and a draft writes its own, so the landscape lens measures
   * line edits between surfaces. Absent otherwise. */
  lines?: string[]
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
  /** Pass/fail cells scoring 0 or 1. */
  binary: boolean
  /** The objective is minimized; a cell reports 1 minus its score. */
  minimize: boolean
  /** A cell's actual cost relative to the lane prior. */
  costScale: number
  allocation: 'uniform' | 'asha' | 'asha-adaptive'
  /** The planted pool's gap; null: the hill climb's seeded steps. */
  poolGap: number | null
  /** The planted child's registration index; null: seeded from the seed. */
  poolPlant: number | null
  /** Latent skill axes (0: the additive objective). Axis 0 is general, every
   * task loads it; each task also loads one specialist axis. */
  skills: number
  /** Under `--skills`, how far pool candidates spread on each specialist
   * axis: a seeded value in [-spread, 0). Default 0.12. */
  skillSpread: number
  /** Seeds the task bank (demands and task terms) under `--skills`, so
   * searches with different seeds share one bank. */
  bankSeed: number
  /** Under the additive objective, the quality a root-lineage child cannot
   * pass; a draft's lineage can climb 0.25 higher. Null: no ceiling. */
  ceiling: number | null
  policy: 'incumbent' | 'draft-on-plateau'
  /** Unit loadings `asha-adaptive` extends rungs with. */
  calibration: SkillCalibration | null
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
  const digest = createHash('sha256')
    .update(JSON.stringify([seed, ...key]))
    .digest()
  return digest.readUInt32BE(0) / 2 ** 32
}

function benchmark(options: SimOptions): SearchSourceRef {
  const { seed, train, selection, test } = options
  return { uri: 'sim://tasks', revision: hashCanonical({ seed, train, selection, test }) }
}

function judge(options: SimOptions): SearchSourceRef | SearchUnknown {
  if (options.judgeRevision === null)
    return { unknown: 'the judge is not pinned (--judge-revision none)' }
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

const MAX_ATTEMPTS = 3

function allocationOf(options: SimOptions): SearchAllocator {
  if (options.allocation === 'asha-adaptive') {
    if (options.calibration === null) throw new Error('asha-adaptive needs --calibration FILE')
    return asha({ reps: options.reps, extend: nextUnitExtension(options.calibration) })
  }
  return options.allocation === 'asha'
    ? asha({ reps: options.reps })
    : uniform({ reps: options.reps })
}

function policyOf(options: SimOptions): SearchPolicy {
  const base = incumbent(options.patience === undefined ? {} : { patience: options.patience })
  return options.policy === 'draft-on-plateau' ? draftOnPlateau(base) : base
}

/** The geometry options give artifacts profile text. */
function geometric(options: SimOptions): boolean {
  return options.skills > 0 || options.ceiling !== null || options.policy === 'draft-on-plateau'
}

/** The root artifact: the additive default, plus text, skills and a basin
 * under the geometry options. */
function rootOf(options: SimOptions): SimArtifact {
  if (!geometric(options)) return ROOT
  return {
    ...ROOT,
    lines: Array.from({ length: 8 }, (_, index) => `root line ${index}`),
    ...(options.skills > 0 ? { skill: new Array<number>(options.skills).fill(0) } : {}),
    ...(options.ceiling !== null ? { basin: 0 } : {}),
  }
}

/** A task's demand on each skill axis under `--skills`: axis 0 in [0.6, 1),
 * one specialist axis in [0.8, 1.2), the others 0. Seeded by the bank. */
function demand(options: SimOptions, taskId: string): number[] {
  const vector = new Array<number>(options.skills).fill(0)
  vector[0] = 0.6 + 0.4 * unit(options.bankSeed, 'demand', taskId)
  if (options.skills > 1) {
    const family = 1 + Math.floor(unit(options.bankSeed, 'family', taskId) * (options.skills - 1))
    vector[family] = 0.8 + 0.4 * unit(options.bankSeed, 'load', taskId)
  }
  return vector
}

/** Under `--skills`, an artifact's true quality: 0.5 plus its skills loaded
 * on the mean demand of the selection split, the objective it is ranked on. */
function skillQuality(skill: readonly number[], options: SimOptions): number {
  const selection = tasks('s', options.selection)
  let total = 0
  for (const task of selection) {
    const d = demand(options, task.taskId)
    for (let k = 0; k < skill.length; k++) total += skill[k]! * d[k]!
  }
  return round(0.5 + total / selection.length)
}

/** One line of the parent's text replaced, and sometimes one appended. */
function editLines(parent: readonly string[], name: string, options: SimOptions): string[] {
  const lines = [...parent]
  lines[Math.floor(unit(options.seed, 'edit', name) * lines.length)] = `${name} edit`
  if (unit(options.seed, 'grow', name) < 0.5) lines.push(`${name} addition`)
  return lines
}

/** The planted child's registration index: the option, or a seeded place in the pool. */
function plantIndex(options: SimOptions): number {
  return (
    options.poolPlant ??
    Math.floor(unit(options.seed, 'plant') * options.population * options.expansions)
  )
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

function memoryStore(): SimStore & { files(): Map<string, string> } {
  const results = new Map<string, SearchCellResult>()
  const inner = inMemoryCampaignStorage()
  const paths = new Set<string>()
  const storage: CampaignStorage = {
    ...inner,
    write(path, content) {
      paths.add(path)
      inner.write(path, content)
    },
    append(path, content, expectedBytes) {
      paths.add(path)
      return inner.append(path, content, expectedBytes)
    },
  }
  return {
    /** Every file the search wrote, by path: the ledger and its blobs. */
    files: () => new Map([...paths].map((path) => [path, inner.read(path) ?? ''])),
    storage,
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
): Promise<{
  result: SearchRunResult
  summary: Record<string, unknown>
  /** The hidden artifact behind a node, read back through the codec. */
  truth: (nodeId: string) => SimArtifact
}> {
  const path = join(dir, 'ledger.jsonl')
  const ledger = store.storage
    ? openSearchLedger({ path, searchId: SEARCH_ID, store: store.storage })
    : openSearchLedger({ path, searchId: SEARCH_ID })
  const policy = policyOf(options)
  const allocation = allocationOf(options)
  const root = rootOf(options)
  const claim = developmentClaim('search-sim')
  const recorder = await SearchRecorder.open(
    { ledger, ...(store.storage ? { storage: store.storage } : {}) },
    {
      subject: 'sim/objective',
      process: { name: 'search-sim', executionRef: SIM_SOURCE },
      artifactKind: 'prompt',
      objective: {
        metric: 'score',
        direction: options.minimize ? 'minimize' : 'maximize',
        judge: judge(options),
        claim:
          options.minEffect === undefined ? claim : { ...claim, minimumEffect: options.minEffect },
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
      if (request.operator === 'draft') {
        // A fresh artifact, numbered by the nodes the search holds.
        const registered = state.audit.nodes
        return {
          children: Array.from({ length: options.population }, (_, index) =>
            draftChild(registered + index, options),
          ),
          accounting: {
            tokens: { status: 'known', inputTokens: 0, outputTokens: 0, cachedTokens: 0 },
            cost: { status: 'known', usd: PROPOSAL_USD, source: 'pricing-table' },
          },
        }
      }
      if (options.poolGap !== null) {
        // The planted pool: numbered by the nodes the search holds, so a lost
        // proposal is proposed again identically, and independent of the parent.
        const registered = state.audit.nodes - 1
        return {
          children: Array.from({ length: options.population }, (_, index) =>
            poolChild(registered + index, options),
          ),
          accounting: {
            tokens: { status: 'known', inputTokens: 0, outputTokens: 0, cachedTokens: 0 },
            cost: { status: 'known', usd: PROPOSAL_USD, source: 'pricing-table' },
          },
        }
      }
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
    root,
    codec,
    policy,
    allocation,
    proposer,
    executor,
    maxExpansions: options.expansions,
    maxAttempts: MAX_ATTEMPTS,
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
      return {
        nodeId: node.nodeId,
        name: truth(node.nodeId).name,
        rule: last.rule,
        reason: last.reason,
      }
    })
  const invalidIds = new Set(invalid.map((node) => node.nodeId))
  const claimed = result.claim
  const kept = truth(result.leader)
  const ledgerText = store.storage?.read(path) ?? readFileSync(path, 'utf8')
  const best = state
    .nodes()
    .reduce(
      (top, node) => Math.max(top, truth(node.nodeId).quality),
      Number.NEGATIVE_INFINITY,
    )
  const drafts = state.edges().filter((edge) => edge.operator === 'draft')
  const summary = {
    reason: result.reason,
    leader: result.leader,
    bestQuality: best,
    drafts: drafts.map((edge) => ({
      child: truth(edge.childNodeId).name,
      evidence: edge.selection?.evidence ?? null,
    })),
    kept: {
      name: kept.name,
      quality: kept.quality,
      status: state.node(result.leader)!.status,
      planted: options.poolGap !== null && kept.name === `c${plantIndex(options)}`,
    },
    ledgerChecks: checkLedger(ledgerText, allocation),
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
        /** The selection estimate against the root the finalist was chosen on. */
        selectionDelta:
          state
            .node(finalist.nodeId)!
            .decisions.find((decision) => decision.decision.status === 'finalist')?.basis?.delta ??
          null,
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
  return { result, summary, truth }
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
  if (parent.skill !== undefined) {
    const skill = parent.skill.map((value, axis) =>
      round(value + (options.nullSteps ? 0 : -0.05 + 0.1 * unit(options.seed, 'skill', name, axis))),
    )
    artifact = { ...artifact, skill, quality: skillQuality(skill, options) }
  }
  if (parent.basin !== undefined && options.ceiling !== null) {
    const cap = options.ceiling + (parent.basin === 0 ? 0 : 0.25)
    artifact = { ...artifact, basin: parent.basin, quality: Math.min(cap, artifact.quality) }
  }
  if (parent.lines !== undefined) {
    artifact = { ...artifact, lines: editLines(parent.lines, name, options) }
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

/** A planted-pool child: the root plus a seeded step in [-0.1, 0), or the
 * root plus the gap for the planted one. */
function poolChild(index: number, options: SimOptions) {
  const name = `c${index}`
  const planted = index === plantIndex(options)
  if (options.skills > 1) {
    // Pool candidates differ mostly on the specialist axes; the planted one
    // is +gap on one specialist axis's share of the split, so only that
    // family's units separate it.
    const skill = Array.from({ length: options.skills }, (_, axis) =>
      axis === 0
        ? round(-0.02 * unit(options.seed, 'pool', name, axis))
        : round(options.skillSpread * (unit(options.seed, 'pool', name, axis) - 1)),
    )
    if (planted) {
      const family = 1 + Math.floor(unit(options.seed, 'plant-family') * (options.skills - 1))
      const selection = tasks('s', options.selection)
      const load =
        selection.reduce((sum, task) => sum + demand(options, task.taskId)[family]!, 0) /
        selection.length
      skill[family] = round(options.poolGap! / Math.max(load, 1e-9))
    }
    const artifact: SimArtifact = {
      ...rootOf(options),
      name,
      skill,
      quality: skillQuality(skill, options),
      lines: editLines(rootOf(options).lines!, name, options),
    }
    const label = planted ? `planted pool child +${options.poolGap}` : `pool child ${name}`
    return { artifact, label, rationale: `${label}, independent of its parent` }
  }
  const step = planted ? options.poolGap! : -0.1 * unit(options.seed, 'pool', name)
  const artifact: SimArtifact = { ...ROOT, name, quality: round(ROOT.quality + step) }
  const label = planted ? `planted pool child +${options.poolGap}` : `pool child ${name}`
  return { artifact, label, rationale: `${label}, independent of its parent` }
}

/** A draft: a fresh artifact written from the task, not from a parent. Under
 * `--ceiling` it starts its own basin, which can climb 0.25 higher than the
 * root's; under `--skills` its skills are drawn afresh. */
function draftChild(index: number, options: SimOptions) {
  const name = `d${index}`
  let artifact: SimArtifact = {
    ...rootOf(options),
    name,
    quality: round(ROOT.quality - 0.05 + 0.1 * unit(options.seed, 'draft', name)),
    lines: Array.from({ length: 8 }, (_, line) => `${name} line ${line}`),
  }
  if (options.skills > 0) {
    const skill = Array.from({ length: options.skills }, (_, axis) =>
      round(-0.1 + 0.2 * unit(options.seed, 'draft-skill', name, axis)),
    )
    artifact = { ...artifact, skill, quality: skillQuality(skill, options) }
  }
  if (options.ceiling !== null) artifact = { ...artifact, basin: index }
  return { artifact, label: `draft ${name}`, rationale: `draft ${name}, written afresh` }
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
 * Audit a closed ledger. Each `advanced` and `pruned` decision, with its rule,
 * rank reason and estimate, must be one the allocator returns again from the
 * ledger just before it, so every rank decision derives from recorded
 * evidence. Each measured node's contrast with its parent is counted by the
 * units they pair on, and cells are counted by stage.
 */
function checkLedger(text: string, allocation: SearchAllocator): Record<string, unknown> {
  const final = replaySearchLedgerText(text, SEARCH_ID, 'sim-ledger')
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
      // The kernel keeps the policy's leader from pruning; asking with the
      // root gives a superset, which is all the audit needs.
      const expected =
        event.decision.status === 'advanced'
          ? allocation.advance(view)
          : allocation.prune(view, before.rootNodeId!)
      // The decision, its rank reason and its estimate must all re-derive.
      const recorded = canonicalString([event.decision, event.rule, event.reason, event.basis])
      if (
        !expected.some(
          (made) =>
            made.nodeId === event.nodeId &&
            canonicalString([made.decision, made.rule, made.reason, made.basis]) === recorded,
        )
      ) {
        decisions.unexplained.push(`${index}:${event.nodeId}:${canonicalString(event.decision)}`)
      }
      decisions[event.decision.status] += 1
    }
    state.apply(entry, index)
  }
  const split = final.header!.splits.selection.tasks.length > 0 ? 'selection' : 'train'
  const edgePairs: Record<string, number> = {}
  for (const node of final.nodes()) {
    if (node.primaryParentId === null || final.scoredCells(node.nodeId, split).length === 0) {
      continue
    }
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
  for (const node of final.nodes()) {
    statuses[node.status ?? 'none'] = (statuses[node.status ?? 'none'] ?? 0) + 1
  }
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
      : options.cellUsd * fraction * options.costScale,
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
  const task =
    -0.1 +
    0.2 * unit(artifact.skill ? options.bankSeed : options.seed, 'task', work.taskId)
  const base = artifact.skill
    ? 0.5 +
      demand(options, work.taskId).reduce((sum, load, axis) => sum + load * artifact.skill![axis]!, 0)
    : artifact.quality
  const clamp = (value: number): number => Math.min(1, Math.max(0, value))
  const goodness = options.binary
    ? unit(options.seed, 'pass', work.cellId) < clamp(base + shift + task)
      ? 1
      : 0
    : clamp(base + shift + task - 0.15 + 0.3 * unit(options.seed, 'noise', work.cellId))
  const score = round(options.minimize ? 1 - goodness : goodness)
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
  /** The top finalist's selection delta minus its test delta: selection's optimism. */
  const optimism: number[] = []
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
      finalists: Array<{
        trueGain: number
        selectionDelta: number | null
        promote: boolean
        test: { delta: number } | null
      }>
    }
    decisions[claim.decision] += 1
    nodes += result.state.audit.nodes
    cells += result.state.audit.cells.allocated
    if (claim.power.powerAtMinimumEffect !== undefined)
      powers.push(claim.power.powerAtMinimumEffect)
    const top = claim.finalists[0]
    if (top?.test && top.selectionDelta !== null) optimism.push(top.selectionDelta - top.test.delta)
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
      scores: options.binary ? 'pass/fail' : 'continuous',
      direction: options.minimize ? 'minimize' : 'maximize',
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
    topFinalistSelectionMinusTest: {
      searches: optimism.length,
      mean:
        optimism.length === 0 ? null : round(optimism.reduce((a, b) => a + b, 0) / optimism.length),
      median:
        optimism.length === 0
          ? null
          : round([...optimism].sort((a, b) => a - b)[Math.floor(optimism.length / 2)]!),
    },
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
        logChoose(n, i) +
          (i === 0 ? 0 : i * Math.log(p)) +
          (n - i === 0 ? 0 : (n - i) * Math.log1p(-p)),
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
  const lower = successes === 0 ? 0 : solve((p) => (1 - cdf(successes - 1, p) < alpha ? 1 : -1))
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
  const invariants = {
    noDuplicateCellAllocations: actual.duplicateCellAllocations === 0,
    everyAttemptFinishedOnce: finished.length === new Set(finished).size,
    rankDecisionsFromEvidence: (resumedSummary.ledgerChecks as { ok: boolean }).ok,
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
 * pairs on. Ledgers and blobs are held in memory; every run's ledger audit
 * must pass.
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
    statuses: Record<string, number>
  }
  const rows: Array<{ seed: number; uniform: ArmRow; asha: ArmRow }> = []
  for (let seed = options.seed; seed < options.seed + seeds; seed++) {
    const arms = {} as Record<'uniform' | 'asha', ArmRow>
    for (const allocation of ['uniform', 'asha'] as const) {
      const { result, summary } = await runSimulation(
        `mem://search-sim/${seed}/${allocation}`,
        { ...options, seed, allocation },
        memoryStore(),
      )
      const kept = summary.kept as { name: string; quality: number; planted: boolean }
      const checks = summary.ledgerChecks as {
        ok: boolean
        edgePairs: Record<string, number>
        advancedTo: Record<string, number>
        statuses: Record<string, number>
      }
      arms[allocation] = {
        cells: result.state.audit.cells.allocated,
        nodes: result.state.audit.nodes,
        kept: kept.name,
        quality: kept.quality,
        planted: kept.planted,
        ledgerOk: checks.ok,
        edgePairs: checks.edgePairs,
        advancedTo: checks.advancedTo,
        statuses: checks.statuses,
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
    const statuses: Record<string, number> = {}
    for (const row of list) {
      add(edgePairs, row.edgePairs)
      add(advancedTo, row.advancedTo)
      add(statuses, row.statuses)
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
      missedPlantedSeeds: rows.filter((row) => !row[name].planted).map((row) => row.seed),
      meanKeptQuality: round(list.reduce((sum, row) => sum + row.quality, 0) / list.length),
      ledgerAuditsPassed: list.filter((row) => row.ledgerOk).length,
      /** Measured edges by the units they pair on against their parent. */
      edgePairs,
      minEdgePairs: pairCounts.length === 0 ? null : Math.min(...pairCounts),
      /** `advanced` decisions by the rung they opened. */
      advancedTo,
      /** Final node statuses across the searches. */
      statuses,
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

/** Paired differences (arm B minus arm A, one per seed) with a mean, a
 * percentile bootstrap interval on the mean (descriptive below 20 pairs) and
 * the exact one-sided sign test that B is better, chosen before the run:
 * `higher` when a larger value is better (quality), `lower` when a smaller
 * one is (cells). */
function pairedReport(differences: readonly number[], better: 'higher' | 'lower' = 'higher') {
  const zeros = differences.map(() => 0)
  const bootstrap = pairedBootstrap(zeros, [...differences], {
    statistic: 'mean',
    resamples: 4000,
    seed: 1,
  })
  const sign = pairedSignTest(differences, better === 'higher' ? 'greater' : 'less')
  return {
    n: differences.length,
    mean: round(bootstrap.mean),
    bootstrap95: [round(bootstrap.low), round(bootstrap.high)],
    bootstrapGateEligible: bootstrap.gateEligible,
    better: better === 'higher' ? sign.positive : sign.negative,
    same: sign.ties,
    worse: better === 'higher' ? sign.negative : sign.positive,
    signTestP: round(sign.pValue),
    method: `mean of per-seed differences (B minus A); 95% percentile bootstrap on the mean (4000 resamples, seed 1; descriptive below 20 pairs); exact one-sided sign test that B is better (${better} is better), ties excluded`,
  }
}

/** Line edits between two sim artifacts' profile texts: the distance the
 * `landscape` lens reads from blobs in `search show`. */
function simTextEdits(truth: (nodeId: string) => SimArtifact): LandscapeEmbedding {
  return {
    kind: 'distance',
    name: 'sim-text-edits',
    method: 'line insertions plus deletions between the sim artifacts’ profile lines (Myers diff)',
    distance(a, b) {
      const left = truth(a.nodeId).lines
      const right = truth(b.nodeId).lines
      return left && right ? lineEditDistance(left, right) : null
    },
  }
}

/**
 * The plateau trigger, paired by seed: each seed runs `incumbent` and
 * `draftOnPlateau(incumbent)` on in-memory ledgers with everything else
 * equal. Reports, per arm, the kept node's true quality, the best true
 * quality registered, drafts, cells, and the landscape lens on the closed
 * ledger (plateau score and basin count on profile line edits); then the
 * paired differences, draft-on-plateau minus incumbent. Run it with and
 * without `--ceiling`: with a ceiling the root's lineage cannot pass it and a
 * draft's can climb 0.25 higher, so drafting is the only way up; without one
 * a draft is no better than the root's lineage, so the trigger's cost shows.
 */
async function plateau(options: SimOptions, seeds: number) {
  interface ArmRow {
    kept: number
    best: number
    drafts: number
    cells: number
    nodes: number
    ledgerOk: boolean
    plateau: number | null
    plateauInsufficient: string | null
    basins: number | null
    firedAt: number[]
  }
  const arms = ['incumbent', 'draft-on-plateau'] as const
  const rows: Array<{ seed: number } & Record<(typeof arms)[number], ArmRow>> = []
  for (let seed = options.seed; seed < options.seed + seeds; seed++) {
    const row = { seed } as { seed: number } & Record<(typeof arms)[number], ArmRow>
    for (const policy of arms) {
      const { result, summary, truth } = await runSimulation(
        `mem://search-sim/${seed}/${policy}`,
        { ...options, seed, policy },
        memoryStore(),
      )
      const lens = landscape(result.state, simTextEdits(truth))
      const drafts = summary.drafts as Array<{ evidence: Record<string, number> | null }>
      row[policy] = {
        kept: (summary.kept as { quality: number }).quality,
        best: summary.bestQuality as number,
        drafts: drafts.length,
        cells: result.state.audit.cells.allocated,
        nodes: result.state.audit.nodes,
        ledgerOk: (summary.ledgerChecks as { ok: boolean }).ok,
        plateau: lens.signal.value,
        plateauInsufficient: lens.signal.insufficient,
        basins: lens.data.basins.count,
        firedAt: drafts.map((draft) => draft.evidence?.accepted ?? -1),
      }
    }
    rows.push(row)
  }
  const arm = (name: (typeof arms)[number]) => {
    const list = rows.map((row) => row[name])
    const mean = (values: readonly number[]) =>
      values.length === 0 ? null : round(values.reduce((sum, value) => sum + value, 0) / values.length)
    const basins: Record<string, number> = {}
    for (const entry of list) {
      const key = entry.basins === null ? 'insufficient' : String(entry.basins)
      basins[key] = (basins[key] ?? 0) + 1
    }
    const plateaus = list.flatMap((entry) => (entry.plateau === null ? [] : [entry.plateau]))
    return {
      meanKept: mean(list.map((entry) => entry.kept)),
      meanBest: mean(list.map((entry) => entry.best)),
      meanCells: mean(list.map((entry) => entry.cells)),
      meanNodes: mean(list.map((entry) => entry.nodes)),
      drafts: {
        total: list.reduce((sum, entry) => sum + entry.drafts, 0),
        searchesWithDraft: list.filter((entry) => entry.drafts > 0).length,
      },
      /** The landscape lens on each closed ledger. */
      finalPlateau: {
        measured: plateaus.length,
        belowOne: plateaus.filter((value) => value < 1).length,
        median: plateaus.length === 0 ? null : [...plateaus].sort((a, b) => a - b)[Math.floor(plateaus.length / 2)]!,
      },
      basins,
      ledgerAuditsPassed: list.filter((entry) => entry.ledgerOk).length,
    }
  }
  return {
    ok: rows.every((row) => arms.every((name) => row[name].ledgerOk)),
    seeds: rows.length,
    design: {
      ceiling: options.ceiling,
      selection: options.selection,
      train: options.train,
      population: options.population,
      expansions: options.expansions,
      allocation: options.allocation,
    },
    incumbent: arm('incumbent'),
    draftOnPlateau: arm('draft-on-plateau'),
    /** Draft-on-plateau minus incumbent, paired by seed. */
    keptQuality: pairedReport(rows.map((row) => row['draft-on-plateau'].kept - row.incumbent.kept)),
    bestQuality: pairedReport(rows.map((row) => row['draft-on-plateau'].best - row.incumbent.best)),
    cells: pairedReport(
      rows.map((row) => row['draft-on-plateau'].cells - row.incumbent.cells),
      'lower',
    ),
    perSeed: rows.map((row) => ({
      seed: row.seed,
      incumbent: [row.incumbent.kept, row.incumbent.plateau, row.incumbent.basins],
      draftOnPlateau: [
        row['draft-on-plateau'].kept,
        row['draft-on-plateau'].drafts,
        row['draft-on-plateau'].firedAt,
        row['draft-on-plateau'].basins,
      ],
    })),
  }
}

/**
 * The landscape lens under the null: `--null` makes every node as good as the
 * root, so the landscape is flat and only cell noise varies. Runs one search
 * per seed and reports how many basins the lens counts (the method promises
 * one on at least 95% of flat landscapes), whether it drew a surface, and
 * the plateau score, which should read "on a plateau" when nothing improves.
 */
async function lensNull(options: SimOptions, seeds: number) {
  if (!options.nullSteps) throw new Error('lens-null needs --null')
  const basins: Record<string, number> = {}
  const surfaces = { drawn: 0, flat: 0, insufficient: 0 }
  const plateaus: number[] = []
  let plateauInsufficient = 0
  let nodes = 0
  for (let seed = options.seed; seed < options.seed + seeds; seed++) {
    // A ceiling of 1 is inert for scores in [0, 1]; it gives every artifact
    // profile lines, so the lens measures line edits.
    const { result, truth } = await runSimulation(
      `mem://search-sim/${seed}/lens-null`,
      { ...options, seed, ceiling: options.ceiling ?? 1 },
      memoryStore(),
    )
    nodes += result.state.audit.nodes
    const lens = landscape(result.state, simTextEdits(truth))
    const key = lens.data.basins.count === null ? 'insufficient' : String(lens.data.basins.count)
    basins[key] = (basins[key] ?? 0) + 1
    if (lens.data.grid !== null) surfaces.drawn += 1
    else if (lens.data.gridInsufficient?.includes('vary no more than their noise')) surfaces.flat += 1
    else surfaces.insufficient += 1
    if (lens.signal.value === null) plateauInsufficient += 1
    else plateaus.push(lens.signal.value)
  }
  const oneBasin = basins['1'] ?? 0
  const counted = seeds - (basins.insufficient ?? 0)
  return {
    seeds,
    meanNodes: round(nodes / seeds),
    basins,
    oneBasin: { count: oneBasin, of: counted, wilson95: interval(wilson(oneBasin, counted, 0.95)) },
    surfaces,
    plateau: {
      measured: plateaus.length,
      insufficient: plateauInsufficient,
      belowOne: plateaus.filter((value) => value < 1).length,
      max: plateaus.length === 0 ? null : Math.max(...plateaus),
    },
  }
}

/**
 * Calibrate, then test adaptively. One `uniform` search over a pool
 * (`calibrationSeed`, the same task bank) measures every node on every unit;
 * `skillManifold` fits its unit loadings and `skillCalibration` keeps them.
 * Then, once per seed, the same pool search runs under `asha` and under
 * `asha-adaptive`, whose rungs add the units that best separate the leaders
 * on those loadings. Reports cells, the kept node's true quality, the regret
 * against the best node each search registered, and the ledger audits.
 */
async function adaptive(options: SimOptions, seeds: number, calibrationSeed: number) {
  if (options.skills < 2 || options.poolGap === null) {
    throw new Error('adaptive needs --skills 2 or more and --pool-gap')
  }
  const calibrationRun = await runSimulation(
    `mem://search-sim/calibration/${calibrationSeed}`,
    { ...options, seed: calibrationSeed, allocation: 'uniform', policy: 'incumbent' },
    memoryStore(),
  )
  const lens = skillManifold(calibrationRun.result.state, 'auto')
  const calibration = skillCalibration(lens)
  const calibrationReport = {
    seed: calibrationSeed,
    nodes: lens.data.matrix.rows,
    units: lens.data.matrix.units,
    intrinsicDimension: lens.data.intrinsicDimension.value,
    curve: lens.data.intrinsicDimension.curve,
    rank: lens.data.model?.rank ?? null,
    noiseVariance: lens.data.noiseVariance,
  }
  if (calibration === null) {
    return { ok: false, calibration: calibrationReport, reason: lens.data.insufficient }
  }
  interface ArmRow {
    cells: number
    kept: string
    quality: number
    best: number
    planted: boolean
    ledgerOk: boolean
  }
  const rows: Array<{ seed: number; asha: ArmRow; adaptive: ArmRow }> = []
  for (let seed = options.seed; seed < options.seed + seeds; seed++) {
    const arms = {} as Record<'asha' | 'adaptive', ArmRow>
    for (const arm of ['asha', 'adaptive'] as const) {
      const { result, summary } = await runSimulation(
        `mem://search-sim/${seed}/${arm}`,
        {
          ...options,
          seed,
          allocation: arm === 'asha' ? 'asha' : 'asha-adaptive',
          calibration,
        },
        memoryStore(),
      )
      const kept = summary.kept as { name: string; quality: number; planted: boolean }
      arms[arm] = {
        cells: result.state.audit.cells.allocated,
        kept: kept.name,
        quality: kept.quality,
        best: summary.bestQuality as number,
        planted: kept.planted,
        ledgerOk: (summary.ledgerChecks as { ok: boolean }).ok,
      }
    }
    rows.push({ seed, ...arms })
  }
  const arm = (name: 'asha' | 'adaptive') => {
    const list = rows.map((row) => row[name])
    const keptBest = list.filter((row) => row.quality >= row.best - 1e-12).length
    return {
      cells: list.reduce((sum, row) => sum + row.cells, 0),
      keptBest: {
        count: keptBest,
        of: list.length,
        wilson95: interval(wilson(keptBest, list.length, 0.95)),
      },
      keptPlanted: list.filter((row) => row.planted).length,
      meanRegret: round(list.reduce((sum, row) => sum + (row.best - row.quality), 0) / list.length),
      meanKeptQuality: round(list.reduce((sum, row) => sum + row.quality, 0) / list.length),
      ledgerAuditsPassed: list.filter((row) => row.ledgerOk).length,
    }
  }
  const ashaArm = arm('asha')
  const adaptiveArm = arm('adaptive')
  const paired = rows.map((row) => row.adaptive.quality - row.asha.quality)
  return {
    ok: ashaArm.ledgerAuditsPassed === rows.length && adaptiveArm.ledgerAuditsPassed === rows.length,
    seeds: rows.length,
    design: {
      skills: options.skills,
      bankSeed: options.bankSeed,
      selection: options.selection,
      population: options.population,
      expansions: options.expansions,
      poolGap: options.poolGap,
      binary: options.binary,
    },
    calibration: { ...calibrationReport, source: calibration.source },
    asha: ashaArm,
    adaptive: adaptiveArm,
    /** Kept quality, adaptive minus asha, paired by seed. */
    keptQuality: pairedReport(paired),
    /** Cells allocated, adaptive minus asha, paired by seed. */
    cells: pairedReport(
      rows.map((row) => row.adaptive.cells - row.asha.cells),
      'lower',
    ),
    differing: rows
      .filter((row) => row.asha.kept !== row.adaptive.kept)
      .map((row) => ({
        seed: row.seed,
        best: row.asha.best,
        asha: { kept: row.asha.kept, quality: row.asha.quality, cells: row.asha.cells },
        adaptive: { kept: row.adaptive.kept, quality: row.adaptive.quality, cells: row.adaptive.cells },
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
      binary: { type: 'boolean', default: false },
      minimize: { type: 'boolean', default: false },
      'cost-scale': { type: 'string', default: '1' },
      kills: { type: 'string', default: '6' },
      searches: { type: 'string', default: '200' },
      allocation: { type: 'string', default: 'uniform' },
      'pool-gap': { type: 'string' },
      'pool-plant': { type: 'string' },
      seeds: { type: 'string', default: '100' },
      skills: { type: 'string', default: '0' },
      'bank-seed': { type: 'string' },
      'skill-spread': { type: 'string', default: '0.12' },
      ceiling: { type: 'string' },
      policy: { type: 'string', default: 'incumbent' },
      calibration: { type: 'string' },
      'calibration-seed': { type: 'string', default: '1000' },
      'in-memory': { type: 'boolean', default: false },
    },
  })
  if (
    values.allocation !== 'uniform' &&
    values.allocation !== 'asha' &&
    values.allocation !== 'asha-adaptive'
  ) {
    throw new Error(`--allocation must be uniform, asha or asha-adaptive, got ${values.allocation}`)
  }
  if (values.policy !== 'incumbent' && values.policy !== 'draft-on-plateau') {
    throw new Error(`--policy must be incumbent or draft-on-plateau, got ${values.policy}`)
  }
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
    binary: values.binary,
    minimize: values.minimize,
    costScale: Number(values['cost-scale']),
    allocation: values.allocation,
    poolGap: values['pool-gap'] === undefined ? null : Number(values['pool-gap']),
    poolPlant: values['pool-plant'] === undefined ? null : Number(values['pool-plant']),
    skills: Number(values.skills),
    skillSpread: Number(values['skill-spread']),
    bankSeed: Number(values['bank-seed'] ?? values.seed),
    ceiling: values.ceiling === undefined ? null : Number(values.ceiling),
    policy: values.policy,
    calibration:
      values.calibration === undefined
        ? null
        : (JSON.parse(readFileSync(values.calibration, 'utf8')) as SkillCalibration),
  }
  if (mode === 'claims') {
    console.log(JSON.stringify(await claims(options, Number(values.searches)), null, 2))
    return
  }
  if (mode === 'lens-null') {
    console.log(JSON.stringify(await lensNull(options, Number(values.seeds)), null, 2))
    return
  }
  if (mode === 'plateau') {
    const report = await plateau(options, Number(values.seeds))
    console.log(JSON.stringify(report, null, 2))
    if (!report.ok) process.exitCode = 1
    return
  }
  if (mode === 'adaptive') {
    const report = await adaptive(
      options,
      Number(values.seeds),
      Number(values['calibration-seed']),
    )
    console.log(JSON.stringify(report, null, 2))
    if (!report.ok) process.exitCode = 1
    return
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
    const dir = resolve(values.dir)
    if (values['in-memory']) {
      // The ledger and its blobs live in memory while the search runs (no
      // fsync per append), then land in DIR as `run` would have written them.
      // A killed run leaves nothing to resume.
      const store = memoryStore()
      const { summary } = await runSimulation(dir, options, store)
      for (const [path, content] of store.files()) {
        mkdirSync(dirname(path), { recursive: true })
        writeFileSync(path, content)
      }
      console.log(JSON.stringify(summary))
      return
    }
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
  throw new Error(
    `unknown mode ${String(mode)}; use run, kill-resume, claims, compare, plateau, adaptive or lens-null`,
  )
}

await main()
