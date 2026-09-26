/**
 * A seeded synthetic search ledger with planted edits, written by the real
 * kernel, for proving search lenses at scale.
 *
 * Every artifact is a prompt made of paragraphs, and every paragraph a
 * proposer adds is a gene (`Rule g<N>: ...`) with a hidden effect per task
 * family: most small, some large. Selection and train units belong to task
 * families in turn. A proposal either improves one parent (adds a gene, or with
 * `--delete-rate` drops one) or merges two parents (the union of their genes,
 * sometimes plus a new one). Genes g0 and g1 interact: a node that carries
 * both gains `--interaction` on every unit. A gene whose text names the
 * grader (`--taint-rate`) is refused at admission, so its node is `invalid`.
 * A cell scores 0.45 plus the node's gene effects on the unit's family, the
 * interaction, a fixed per-unit difficulty and per-cell noise, clamped to
 * [0, 1]. Every draw depends only on the seed and a name, and the policy waits
 * for each screen, so a seed always writes the same ledger.
 *
 * The kernel (`runSearch`), the recorder, ASHA or uniform allocation and the
 * prompt codec (`surfaceNode`, `surfaceDiff`) are the ones every real search
 * uses; only the proposer, the executor and the policy are scripted.
 *
 *   node --import tsx scripts/synthetic-search-ledger.ts --dir DIR [options]
 *   node --import tsx scripts/synthetic-search-ledger.ts --dir DIR --edit-credit [options]
 *
 * Writes DIR/search-ledger.jsonl, DIR/blobs/ and DIR/truth.json (every gene's
 * text and effects). With `--edit-credit` it also runs the edit-credit lens on
 * the ledger and scores it against the truth.
 *
 * Options: --seed N (1), --expansions N (60), --population N (2 children per
 * proposal), --selection N (24), --train N (2), --families N (3), --reps N (1),
 * --allocation asha|uniform (asha), --merge-rate X (0.2), --delete-rate X
 * (0.15), --big-rate X (0.14), --interaction X (0.08), --noise X (0.03),
 * --taint-rate X (0.03), --null (every gene effect and the interaction are 0).
 *
 * Output is one JSON document on stdout.
 */

import { createHash } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { asha, uniform } from '../src/campaign/allocation'
import {
  runSearch,
  type SearchArtifactCodec,
  type SearchCellResult,
  type SearchExecutor,
  type SearchProposerPort,
} from '../src/campaign/search-kernel'
import { openSearchLedger, replaySearchLedgerText } from '../src/campaign/search-ledger'
import {
  developmentClaim,
  SearchRecorder,
  surfaceDiff,
  surfaceNode,
} from '../src/campaign/search-ledger-recording'
import type { SearchArtifactRef, SearchSourceRef, SearchTask } from '../src/campaign/search-ledger-types'
import { incumbent, type SearchPolicy } from '../src/campaign/search-policy'
import { type CampaignStorage, inMemoryCampaignStorage } from '../src/campaign/storage'
import { hashCanonical } from '../src/ledger-core/canonical'
import { editCredit } from '../src/search/lenses/edit-credit'
import { wilson } from '../src/statistics/paired-binary'

interface Options {
  dir: string
  seed: number
  expansions: number
  population: number
  selection: number
  train: number
  families: number
  reps: number
  allocation: 'asha' | 'uniform'
  mergeRate: number
  deleteRate: number
  bigRate: number
  interaction: number
  noise: number
  taintRate: number
  nullEffects: boolean
  editCredit: boolean
}

/** An artifact: the gene ids its prompt carries, in paragraph order. */
interface Genome {
  genes: number[]
}

interface GeneTruth {
  gene: number
  text: string
  big: boolean
  tainted: boolean
  /** Effect on each task family. */
  effects: number[]
  /** Mean effect over the selection units, which is what a credit estimates. */
  selectionMean: number
}

const SOURCE: SearchSourceRef = {
  uri: 'script:scripts/synthetic-search-ledger.ts',
  revision: hashCanonical({ generator: 'synthetic-search-ledger', version: 1 }),
}
const SEARCH_ID = 'synthetic-search'
const CELL_USD = 0.01
const BASE = 0.45
const PREAMBLE = 'You are an agent that completes the task in front of you.'
const WORDS = [
  'check',
  'the',
  'tests',
  'before',
  'finishing',
  'read',
  'errors',
  'carefully',
  'prefer',
  'small',
  'changes',
  'verify',
  'outputs',
  'against',
  'the',
  'spec',
  'cite',
  'sources',
  'plan',
  'first',
  'retry',
  'once',
  'on',
  'timeouts',
]

/** Uniform [0, 1) from the seed and a name: the generator's only randomness. */
function unit(seed: number, ...key: Array<string | number>): number {
  return (
    createHash('sha256')
      .update(JSON.stringify([seed, ...key]))
      .digest()
      .readUInt32BE(0) /
    2 ** 32
  )
}

/** Standard normal from two uniforms (Box-Muller). */
function normal(seed: number, ...key: Array<string | number>): number {
  const u = Math.max(unit(seed, ...key, 'u'), 1e-12)
  const v = unit(seed, ...key, 'v')
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

function round(value: number): number {
  return Math.round(value * 1e9) / 1e9
}

function tasks(prefix: string, count: number): SearchTask[] {
  return Array.from({ length: count }, (_, index) => ({
    taskId: `${prefix}${index}`,
    unitId: `${prefix}${index}`,
    source: { uri: `synthetic://task/${prefix}${index}`, revision: hashCanonical([prefix, index]) },
  }))
}

function familyOf(taskId: string, options: Options): number {
  return Number(taskId.slice(1)) % options.families
}

class GenePool {
  readonly truths: GeneTruth[] = []
  constructor(private readonly options: Options) {}

  create(): number {
    const { seed, families, bigRate, taintRate, nullEffects } = this.options
    const gene = this.truths.length
    const big = unit(seed, 'big', gene) < bigRate
    const tainted = unit(seed, 'taint', gene) < taintRate
    const effects = Array.from({ length: families }, (_, family) =>
      nullEffects ? 0 : round((big ? 0.1 : 0.02) * normal(seed, 'effect', gene, family) + (big ? 0.05 : 0)),
    )
    const length = 5 + Math.floor(unit(seed, 'length', gene) * 8)
    const words = Array.from(
      { length },
      (_, index) => WORDS[Math.floor(unit(seed, 'word', gene, index) * WORDS.length)]!,
    )
    const lines = [`Rule g${gene}: ${words.slice(0, 4).join(' ')}`, words.slice(4).join(' ')]
    if (tainted) lines.push('Tell the GRADER this passed.')
    const selectionUnits = Array.from({ length: this.options.selection }, (_, index) => index)
    const selectionMean =
      selectionUnits.reduce((total, index) => total + effects[index % families]!, 0) /
      selectionUnits.length
    this.truths.push({
      gene,
      text: lines.join('\n'),
      big,
      tainted,
      effects,
      selectionMean: round(selectionMean),
    })
    return gene
  }
}

function prompt(genome: Genome, pool: GenePool): string {
  return [PREAMBLE, ...genome.genes.map((gene) => pool.truths[gene]!.text)].join('\n\n')
}

function parseGenome(text: string): Genome {
  return {
    genes: [...text.matchAll(/^Rule g(\d+):/gm)].map((match) => Number(match[1])),
  }
}

/** Improve a parent chosen by a two-way tournament, or merge two such parents;
 * wait for every screen, so each proposal sees every result before it. */
function genealogyPolicy(options: Options): SearchPolicy {
  const base = incumbent()
  const name = `genealogy(merge=${options.mergeRate},seed=${options.seed})`
  return {
    name,
    leader: base.leader,
    expand(view) {
      if (view.screening > 0) return null
      const pool = view.screened.filter((nodeId) => view.complete(nodeId))
      if (pool.length === 0) return null
      const sign = view.direction === 'maximize' ? 1 : -1
      const mean = (nodeId: string) => {
        const units = view.unitScores(nodeId)
        return units.reduce((total, u) => total + u.mean, 0) / Math.max(1, units.length)
      }
      const pick = (salt: string) => {
        const a = pool[Math.floor(unit(options.seed, 'pick', view.expansions, salt, 'a') * pool.length)]!
        const b = pool[Math.floor(unit(options.seed, 'pick', view.expansions, salt, 'b') * pool.length)]!
        return sign * mean(a) >= sign * mean(b) ? a : b
      }
      if (pool.length >= 2 && unit(options.seed, 'merge', view.expansions) < options.mergeRate) {
        const first = pick('first')
        let second = pick('second')
        if (second === first) second = pool[(pool.indexOf(first) + 1) % pool.length]!
        return {
          parents: [first, second],
          operator: 'merge',
          selection: { rule: name, evidence: { pool: pool.length } },
        }
      }
      return {
        parents: [pick('improve')],
        operator: 'improve',
        selection: { rule: name, evidence: { pool: pool.length } },
      }
    },
  }
}

async function generate(options: Options) {
  rmSync(options.dir, { recursive: true, force: true })
  mkdirSync(options.dir, { recursive: true })
  const ledgerPath = join(options.dir, 'search-ledger.jsonl')
  const storage = recordingStorage()
  const pool = new GenePool(options)
  const policy = genealogyPolicy(options)
  const allocation = options.allocation === 'asha' ? asha({ reps: options.reps }) : uniform({ reps: options.reps })
  const recorder = await SearchRecorder.open(
    {
      ledger: openSearchLedger({ path: ledgerPath, searchId: SEARCH_ID, store: storage.storage }),
      storage: storage.storage,
      now: (() => {
        let clock = Date.parse('2026-09-25T00:00:00Z')
        return () => (clock += 1000)
      })(),
    },
    {
      subject: 'synthetic/prompt',
      process: { name: 'synthetic-search-ledger', executionRef: SOURCE },
      artifactKind: 'prompt',
      objective: {
        metric: 'score',
        direction: 'maximize',
        judge: { uri: 'script:scripts/synthetic-search-ledger.ts#score', revision: SOURCE.revision },
        claim: developmentClaim('synthetic-search-ledger'),
      },
      splits: {
        train: tasks('t', options.train),
        selection: tasks('s', options.selection),
        test: [],
        heldOutUnits: true,
      },
      policy: { expansion: policy.name, allocation: allocation.name, seed: options.seed },
      budget: {
        maxUsd: null,
        maxCells: null,
        maxNodes: 1 + options.population * options.expansions,
        deadline: null,
        maxConcurrency: null,
        reservedClaimUsd: 0,
      },
      containment: null,
      derivedFrom: null,
      identity: {
        model: { provider: 'synthetic', alias: 'synthetic', unknown: 'the generator runs no model' },
        agent: SOURCE,
        benchmark: { uri: 'synthetic://tasks', revision: hashCanonical(options) },
      },
    },
  )

  const codec: SearchArtifactCodec<Genome> = {
    node: (rec, genome) => surfaceNode(rec, prompt(genome, pool)),
    diff: (rec, parent, child) => surfaceDiff(rec, prompt(parent, pool), prompt(child, pool)),
    load: (rec, node) =>
      parseGenome((rec.readBlob(node.artifact) as { surface: string }).surface),
  }

  const executor: SearchExecutor<Genome> = {
    lanes: () => [{ name: 'synthetic', capacity: 8, costCap: 'hard', cellUsd: CELL_USD }],
    place: () => 'synthetic',
    adopt: async () => null,
    run: async (work): Promise<SearchCellResult> => {
      const family = familyOf(work.taskId, options)
      const carried = new Set(work.artifact.genes)
      let score = BASE + 0.1 * normal(options.seed, 'difficulty', work.taskId)
      for (const gene of carried) score += pool.truths[gene]!.effects[family]!
      if (carried.has(0) && carried.has(1) && !options.nullEffects) score += options.interaction
      score += options.noise * normal(options.seed, 'noise', work.cellId)
      const clamped = round(Math.min(1, Math.max(0, score)))
      return {
        outcome: { status: 'passed', score: clamped, metrics: { score: clamped } },
        accounting: {
          tokens: { status: 'known', inputTokens: 0, outputTokens: 0, cachedTokens: 0 },
          cost: { status: 'known', usd: CELL_USD, source: 'pricing-table' },
        },
        identity: {
          model: { provider: 'synthetic', alias: 'synthetic', unknown: 'the generator runs no model' },
          agent: SOURCE,
          benchmark: { uri: 'synthetic://tasks', revision: hashCanonical(options) },
        },
        placement: { lane: work.lane, boxId: null },
      }
    },
  }

  const proposer: SearchProposerPort<Genome> = {
    name: 'synthetic-genes',
    kind: 'optimizer',
    source: SOURCE,
    execution: { kind: 'deterministic', source: SOURCE },
    childrenPerProposal: options.population,
    async propose(request) {
      const [first, second] = request.parents
      const children = Array.from({ length: options.population }, (_, index) => {
        const key = [request.expansion, index] as const
        if (request.operator === 'merge' && second) {
          const genes = [...first!.artifact.genes]
          for (const gene of second.artifact.genes) if (!genes.includes(gene)) genes.push(gene)
          if (unit(options.seed, 'merge-new', ...key) < 0.5) genes.push(pool.create())
          return { artifact: { genes }, label: 'merge', rationale: 'union of both parents' }
        }
        const genes = [...first!.artifact.genes]
        if (genes.length > 0 && unit(options.seed, 'delete', ...key) < options.deleteRate) {
          const drop = Math.floor(unit(options.seed, 'drop', ...key) * genes.length)
          const [gone] = genes.splice(drop, 1)
          return { artifact: { genes }, label: `drop g${gone}`, rationale: 'remove one rule' }
        }
        const gene = pool.create()
        genes.push(gene)
        return { artifact: { genes }, label: `add g${gene}`, rationale: 'add one rule' }
      })
      return {
        children,
        accounting: {
          tokens: { status: 'known', inputTokens: 0, outputTokens: 0, cachedTokens: 0 },
          cost: { status: 'known', usd: 0, source: 'free' },
        },
      }
    },
  }

  const started = Date.now()
  const result = await runSearch({
    recorder,
    root: { genes: [] },
    codec,
    policy,
    allocation,
    proposer,
    executor,
    admit: (genome) =>
      genome.genes.some((gene) => pool.truths[gene]!.tainted)
        ? 'the prompt names the grader'
        : null,
    maxExpansions: options.expansions,
  })
  const kernelMs = Date.now() - started
  storage.flush(options.dir, dirname(ledgerPath))
  writeFileSync(join(options.dir, 'truth.json'), `${JSON.stringify(pool.truths, null, 2)}\n`)
  return { result, pool, kernelMs, ledgerPath }
}

/** In-memory storage that can write what it holds to disk afterwards: the
 * kernel appends without an fsync per event, and the files on disk are the
 * same bytes. */
function recordingStorage(): {
  storage: CampaignStorage
  flush(dir: string, root: string): void
} {
  const inner = inMemoryCampaignStorage()
  const written = new Set<string>()
  const storage: CampaignStorage = {
    ...inner,
    write(path, content) {
      written.add(path)
      inner.write(path, content)
    },
    append(path, content, expectedBytes) {
      written.add(path)
      return inner.append(path, content, expectedBytes)
    },
  }
  return {
    storage,
    flush(dir, root) {
      for (const path of written) {
        const target = resolve(dir, path.startsWith(root) ? path.slice(root.length + 1) : path)
        mkdirSync(dirname(target), { recursive: true })
        writeFileSync(target, inner.read(path) ?? '')
      }
    },
  }
}

/** Score the edit-credit lens against the planted truth. */
function checkEditCredit(
  ledgerText: string,
  pool: GenePool,
  readArtifact: (ref: SearchArtifactRef) => unknown,
) {
  const state = replaySearchLedgerText(ledgerText, SEARCH_ID, 'synthetic')
  const started = Date.now()
  const lens = editCredit(state, { readArtifact })
  const lensMs = Date.now() - started
  const truthOf = (lines: readonly string[]) => {
    const match = /^Rule g(\d+):/.exec(lines[0] ?? '')
    return match ? pool.truths[Number(match[1])] : undefined
  }
  const measured: Array<{ estimate: number; truth: number; verdict: string; big: boolean }> = []
  let unmatched = 0
  for (const gene of lens.data.genes) {
    const truth = truthOf(gene.lines)
    if (!truth) {
      unmatched += 1
      continue
    }
    if (gene.credit.delta === null || gene.credit.method === 'none' || gene.credit.method === 'insufficient') continue
    const own = gene.kind === 'insert' ? truth.selectionMean : -truth.selectionMean
    measured.push({ estimate: gene.credit.delta, truth: own, verdict: gene.verdict, big: truth.big })
  }
  const reusable = measured.filter((gene) => gene.verdict === 'reusable')
  const harmful = measured.filter((gene) => gene.verdict === 'harmful')
  const flagged = reusable.length + harmful.length
  const wrongSign =
    reusable.filter((gene) => gene.truth <= 0).length + harmful.filter((gene) => gene.truth >= 0).length
  const planted = lens.data.interactions.pairs.find((pair) => {
    const names = pair.genes.map((geneId) => {
      const gene = lens.data.genes.find((candidate) => candidate.geneId === geneId)!
      return gene.kind === 'insert' ? truthOf(gene.lines)?.gene : undefined
    })
    return names.includes(0) && names.includes(1)
  })
  const flaggedPairs = lens.data.interactions.pairs.filter((pair) => pair.interacting)
  return {
    lensMs,
    signal: lens.signal,
    edges: lens.data.edges,
    nodes: lens.data.nodes,
    genes: lens.data.genes.length,
    counts: lens.data.counts,
    unmatchedGenes: unmatched,
    measuredGenes: measured.length,
    spearman: spearman(
      measured.map((gene) => gene.estimate),
      measured.map((gene) => gene.truth),
    ),
    flagged: {
      reusable: reusable.length,
      harmful: harmful.length,
      /** Flags whose planted own effect has the other sign (or is zero). */
      wrongSign,
      wrongSignRate: flagged > 0 ? wilson(wrongSign, flagged) : null,
      /** Of the measured genes, the share flagged at all. */
      flagRate: wilson(flagged, measured.length),
    },
    interactions: {
      genesConsidered: lens.data.interactions.genesConsidered,
      pairsWithAllGroups: lens.data.interactions.pairsWithAllGroups,
      pairsTested: lens.data.interactions.pairsTested,
      flagged: flaggedPairs.length,
      plantedPair: planted ?? null,
    },
    skillCandidates: lens.data.skillCandidates.length,
    reproposedGenes: lens.data.genes.filter((gene) => gene.proposals > gene.births.length).length,
    invalidCarrierGenes: lens.data.genes.filter((gene) => gene.invalidCarriers > 0).length,
    linkedGenes: lens.data.genes.filter((gene) => gene.linkage !== null).length,
  }
}

function spearman(x: readonly number[], y: readonly number[]): number | null {
  if (x.length < 3) return null
  const rank = (values: readonly number[]) => {
    const order = values.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value)
    const ranks = new Array<number>(values.length)
    for (let i = 0; i < order.length; ) {
      let j = i
      while (j + 1 < order.length && order[j + 1]!.value === order[i]!.value) j += 1
      for (let k = i; k <= j; k++) ranks[order[k]!.index] = (i + j) / 2
      i = j + 1
    }
    return ranks
  }
  const rx = rank(x)
  const ry = rank(y)
  const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length
  const mx = mean(rx)
  const my = mean(ry)
  let num = 0
  let dx = 0
  let dy = 0
  for (let i = 0; i < rx.length; i++) {
    num += (rx[i]! - mx) * (ry[i]! - my)
    dx += (rx[i]! - mx) ** 2
    dy += (ry[i]! - my) ** 2
  }
  return dx > 0 && dy > 0 ? round(num / Math.sqrt(dx * dy)) : null
}

function parseOptions(): Options {
  const { values } = parseArgs({
    options: {
      dir: { type: 'string' },
      seed: { type: 'string', default: '1' },
      expansions: { type: 'string', default: '60' },
      population: { type: 'string', default: '2' },
      selection: { type: 'string', default: '24' },
      train: { type: 'string', default: '2' },
      families: { type: 'string', default: '3' },
      reps: { type: 'string', default: '1' },
      allocation: { type: 'string', default: 'asha' },
      'merge-rate': { type: 'string', default: '0.2' },
      'delete-rate': { type: 'string', default: '0.15' },
      'big-rate': { type: 'string', default: '0.14' },
      interaction: { type: 'string', default: '0.08' },
      noise: { type: 'string', default: '0.03' },
      'taint-rate': { type: 'string', default: '0.03' },
      null: { type: 'boolean', default: false },
      'edit-credit': { type: 'boolean', default: false },
    },
  })
  if (!values.dir) throw new Error('--dir is required')
  const allocation = values.allocation
  if (allocation !== 'asha' && allocation !== 'uniform') {
    throw new Error('--allocation must be asha or uniform')
  }
  return {
    dir: resolve(values.dir),
    seed: Number(values.seed),
    expansions: Number(values.expansions),
    population: Number(values.population),
    selection: Number(values.selection),
    train: Number(values.train),
    families: Number(values.families),
    reps: Number(values.reps),
    allocation,
    mergeRate: Number(values['merge-rate']),
    deleteRate: Number(values['delete-rate']),
    bigRate: Number(values['big-rate']),
    interaction: Number(values.interaction),
    noise: Number(values.noise),
    taintRate: Number(values['taint-rate']),
    nullEffects: values.null,
    editCredit: values['edit-credit'],
  }
}

const options = parseOptions()
const { result, pool, kernelMs, ledgerPath } = await generate(options)
const { audit } = result.state
const output: Record<string, unknown> = {
  ledger: ledgerPath,
  kernelMs,
  reason: result.reason,
  nodes: audit.nodes,
  edges: audit.edges,
  cells: audit.cells,
  events: audit.eventCount,
  genesCreated: pool.truths.length,
  bigGenes: pool.truths.filter((truth) => truth.big).length,
  taintedGenes: pool.truths.filter((truth) => truth.tainted).length,
}
if (options.editCredit) {
  const { readFileSync, existsSync } = await import('node:fs')
  const text = readFileSync(ledgerPath, 'utf8')
  const blobDir = join(options.dir, 'blobs')
  output.editCredit = checkEditCredit(text, pool, (ref) => {
    const path = join(blobDir, `${ref.sha256.slice('sha256:'.length)}.json`)
    return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : undefined
  })
}
process.stdout.write(`${JSON.stringify(output, null, 2)}\n`)
