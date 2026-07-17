/**
 * Lineage DAG — a git-graph of improvement candidates.
 *
 * The improvement loop (`run-optimization.ts`) records a LINEAR `GenerationRecord[]`
 * with no parent pointers, computes a Pareto frontier within a run, then collapses
 * to one gated winner and discards the rest. This module adds the missing
 * first-class structure: a directed acyclic graph of candidate versions where
 *
 *   - a node with ONE parent is a mutation,
 *   - a node with ZERO parents is a root/seed,
 *   - a node with 2+ parents is a MERGE (a "collapse") — nothing special-cased,
 *     just a multi-parent node,
 *   - a `track` groups a lineage into an island, and each track runs a distinct
 *     `vision` (a proposer strategy — e.g. a "solve" vision, an "outside-the-box"
 *     vision, and an adversarial "contrarian" vision that attacks the leader).
 *
 * An agent-managed {@link Governor} decides the next operation (extend / branch /
 * merge / prune / stop), so branching AND collapsing are choices a supervisor
 * makes by reading the graph, not hard-coded control flow.
 *
 * DETERMINISM is a hard invariant: no `Date.now`, `Math.random`, or `new Date`.
 * Ids are content+lineage hashes; order is a monotone insertion counter; every
 * query returns nodes in `seq` order. Same inputs ⇒ identical graph.
 */

import { createHash } from 'node:crypto'
import { dirname } from 'node:path'
import { canonicalJson } from '../verdict-cache'
import { type CampaignStorage, fsCampaignStorage } from './storage'

export interface LineageNode {
  /** Deterministic content+lineage hash (see {@link lineageNodeId}). */
  id: string
  /** `[]` = root/seed; `[x]` = mutation; `[x, y, ...]` = MERGE (collapse). */
  parentIds: string[]
  /** Logical island/track this node belongs to. */
  track: string
  /** Human label for the strategy driving this track (e.g. `solve`, `contrarian`). */
  vision?: string
  /** Candidate content (prompt text, skill document, config JSON, ...). */
  surface: string
  /** Scalar fitness (e.g. mean holdout composite); higher is better. */
  score: number
  /** Optional per-scenario objective vector for Pareto dominance. */
  scoreVector?: number[]
  /** Which proposer produced it (`gepa`, `skill-opt`, `merge`, `seed`, ...). */
  proposer: string
  rationale?: string
  /** Gate verdict, when this node was gated. */
  gate?: 'ship' | 'hold'
  /** Step index within its track (root = 0). */
  generation: number
  /** Monotone global insertion order (assigned by {@link Lineage.addNode}). */
  seq: number
}

export interface LineageEdge {
  /** Parent node id. */
  from: string
  /** Child node id. */
  to: string
}

export interface LineageGraph {
  nodes: LineageNode[]
  edges: LineageEdge[]
}

/** Deterministic node id: a hash of the node's lineage + content + proposer.
 *  Pure — identical inputs always yield the same id (a re-derived node collapses
 *  onto its original rather than duplicating). */
export function lineageNodeId(input: {
  parentIds: string[]
  track: string
  surface: string
  proposer: string
}): string {
  const parents = [...input.parentIds].sort().join(',')
  const payload = `${parents}|${input.track}|${input.surface}|${input.proposer}`
  return createHash('sha256').update(payload).digest('hex').slice(0, 16)
}

/** Input to {@link Lineage.addNode}: everything but the derived `id`/`seq` and the
 *  optional `generation` (derived from parents when omitted). */
export type LineageNodeInput = Omit<LineageNode, 'id' | 'seq' | 'generation'> & {
  generation?: number
}

/** Deterministic improvement-candidate graph with mutation, merge, frontier, and persistence helpers. */
export class Lineage {
  private readonly byId = new Map<string, LineageNode>()
  private readonly childIds = new Map<string, string[]>()
  private nextSeq = 0

  constructor(nodes?: readonly LineageNode[]) {
    if (!nodes) return
    // Rehydrate in seq order so parents always precede children and the monotone
    // counter resumes past the highest persisted seq.
    for (const node of [...nodes].sort((a, b) => a.seq - b.seq)) {
      this.index(node)
      this.nextSeq = Math.max(this.nextSeq, node.seq + 1)
    }
  }

  /** Append a node. Derives `id` (via {@link lineageNodeId}), assigns the next
   *  `seq`, and derives `generation` as `max(parent.generation) + 1` (root = 0)
   *  when omitted. Throws on an unknown parent. Idempotent: re-adding an identical
   *  node returns the existing one.
   *
   *  Acyclicity is guaranteed by construction, not by a runtime check: every
   *  parent must already exist (a child can never point at a not-yet-added node),
   *  ids are immutable content hashes (an existing node can never gain new
   *  parents), and the store is append-only — so no back-edge can form. (Traversal
   *  is still cycle-safe against hand-corrupted deserialized input via visited
   *  sets in {@link ancestors}/{@link descendants}.) */
  addNode(input: LineageNodeInput): LineageNode {
    for (const parentId of input.parentIds) {
      if (!this.byId.has(parentId)) {
        throw new Error(`Lineage.addNode: unknown parent '${parentId}'`)
      }
    }
    const id = lineageNodeId({
      parentIds: input.parentIds,
      track: input.track,
      surface: input.surface,
      proposer: input.proposer,
    })
    const existing = this.byId.get(id)
    if (existing) return existing

    const generation =
      input.generation ??
      (input.parentIds.length === 0
        ? 0
        : Math.max(...input.parentIds.map((p) => this.byId.get(p)!.generation)) + 1)

    const node: LineageNode = {
      id,
      parentIds: [...input.parentIds],
      track: input.track,
      surface: input.surface,
      score: input.score,
      proposer: input.proposer,
      generation,
      seq: this.nextSeq++,
      ...(input.vision !== undefined ? { vision: input.vision } : {}),
      ...(input.scoreVector !== undefined ? { scoreVector: [...input.scoreVector] } : {}),
      ...(input.rationale !== undefined ? { rationale: input.rationale } : {}),
      ...(input.gate !== undefined ? { gate: input.gate } : {}),
    }
    this.index(node)
    return node
  }

  /** Collapse 2+ parents into a single node (a merge/"collapse"). A merge is an
   *  ordinary multi-parent node; this is a guarded convenience. */
  merge(input: {
    parentIds: string[]
    track: string
    surface: string
    score: number
    proposer?: string
    vision?: string
    scoreVector?: number[]
    rationale?: string
  }): LineageNode {
    if (input.parentIds.length < 2) {
      throw new Error(`Lineage.merge: a merge needs >= 2 parents, got ${input.parentIds.length}`)
    }
    return this.addNode({ ...input, proposer: input.proposer ?? 'merge' })
  }

  get(id: string): LineageNode | undefined {
    return this.byId.get(id)
  }

  has(id: string): boolean {
    return this.byId.has(id)
  }

  /** All nodes, in insertion (`seq`) order. */
  all(): LineageNode[] {
    return [...this.byId.values()].sort(bySeq)
  }

  roots(): LineageNode[] {
    return this.all().filter((n) => n.parentIds.length === 0)
  }

  parents(id: string): LineageNode[] {
    const node = this.byId.get(id)
    if (!node) return []
    return node.parentIds
      .map((p) => this.byId.get(p))
      .filter((n): n is LineageNode => n !== undefined)
      .sort(bySeq)
  }

  children(id: string): LineageNode[] {
    return (this.childIds.get(id) ?? []).map((c) => this.byId.get(c)!).sort(bySeq)
  }

  /** Transitive ancestors (excludes `id`). */
  ancestors(id: string): Set<string> {
    const out = new Set<string>()
    const stack = [...(this.byId.get(id)?.parentIds ?? [])]
    while (stack.length > 0) {
      const cur = stack.pop()!
      if (out.has(cur)) continue
      out.add(cur)
      const node = this.byId.get(cur)
      if (node) stack.push(...node.parentIds)
    }
    return out
  }

  /** Transitive descendants (excludes `id`). */
  descendants(id: string): Set<string> {
    const out = new Set<string>()
    const stack = [...(this.childIds.get(id) ?? [])]
    while (stack.length > 0) {
      const cur = stack.pop()!
      if (out.has(cur)) continue
      out.add(cur)
      stack.push(...(this.childIds.get(cur) ?? []))
    }
    return out
  }

  /** Nodes with no children (leaf/branch tips). */
  tips(): LineageNode[] {
    return this.all().filter((n) => (this.childIds.get(n.id) ?? []).length === 0)
  }

  /** Distinct track ids, in first-seen (`seq`) order. */
  tracks(): string[] {
    const seen = new Set<string>()
    const out: string[] = []
    for (const node of this.all()) {
      if (!seen.has(node.track)) {
        seen.add(node.track)
        out.push(node.track)
      }
    }
    return out
  }

  trackNodes(track: string): LineageNode[] {
    return this.all().filter((n) => n.track === track)
  }

  /** The highest-`score` tip of a track (ties broken by lowest `seq`). */
  trackTip(track: string): LineageNode | undefined {
    return pickBest(this.tips().filter((n) => n.track === track))
  }

  /** The highest-`score` node overall (ties broken by lowest `seq`). */
  best(): LineageNode | undefined {
    return pickBest(this.all())
  }

  /** The Pareto-non-dominated set among TIPS. Uses `scoreVector` when every
   *  compared tip carries one, else the scalar `score`. A dominates B iff A is
   *  >= B on every component and > B on at least one. */
  frontier(): LineageNode[] {
    const tips = this.tips()
    const useVector = tips.length > 0 && tips.every((n) => n.scoreVector !== undefined)
    const vecOf = (n: LineageNode): number[] => (useVector ? n.scoreVector! : [n.score])
    return tips
      .filter((a) => !tips.some((b) => b.id !== a.id && dominates(vecOf(b), vecOf(a))))
      .sort(bySeq)
  }

  toGraph(): LineageGraph {
    const nodes = this.all()
    const edges: LineageEdge[] = []
    for (const node of nodes) {
      for (const parentId of node.parentIds) {
        edges.push({ from: parentId, to: node.id })
      }
    }
    return { nodes, edges }
  }

  /** One JSON node per line, in `seq` order. */
  toJSONL(): string {
    return this.all()
      .map((n) => JSON.stringify(n))
      .join('\n')
  }

  static fromJSONL(text: string): Lineage {
    const nodes = text
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as LineageNode)
    return new Lineage(nodes)
  }

  private index(node: LineageNode): void {
    this.byId.set(node.id, node)
    for (const parentId of node.parentIds) {
      const list = this.childIds.get(parentId)
      if (list) {
        if (!list.includes(node.id)) list.push(node.id)
      } else {
        this.childIds.set(parentId, [node.id])
      }
    }
  }
}

function bySeq(a: LineageNode, b: LineageNode): number {
  return a.seq - b.seq
}

/** Highest score, ties broken by lowest seq. */
function pickBest(nodes: LineageNode[]): LineageNode | undefined {
  let best: LineageNode | undefined
  for (const node of nodes) {
    if (!best || node.score > best.score || (node.score === best.score && node.seq < best.seq)) {
      best = node
    }
  }
  return best
}

/** True iff `a` Pareto-dominates `b`: `a[i] >= b[i]` for all i and `a[i] > b[i]`
 *  for some i. Vectors of unequal length never dominate (incomparable). */
function dominates(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false
  let strictlyBetter = false
  for (let i = 0; i < a.length; i += 1) {
    if (a[i]! < b[i]!) return false
    if (a[i]! > b[i]!) strictlyBetter = true
  }
  return strictlyBetter
}

// ── Persistence ──────────────────────────────────────────────────────────────

export interface LineageStore {
  /** Load the persisted lineage (an empty `Lineage` when nothing is stored). */
  load(): Promise<Lineage>
  /** Persist one node durably and idempotently; conflicting content must throw. */
  append(node: LineageNode): Promise<void>
  /** Overwrite with a full snapshot. */
  save(lineage: Lineage): Promise<void>
}

export class LineageStoreConflictError extends Error {
  override readonly name = 'LineageStoreConflictError'
}

/**
 * Store a lineage through CampaignStorage. Appends use its compare-and-append
 * primitive, so retries are idempotent and a second controller fails instead
 * of assigning the same sequence number to different nodes.
 */
export function campaignLineageStore(
  storage: CampaignStorage,
  path: string,
  options: { maxAppendAttempts?: number } = {},
): LineageStore {
  const maxAppendAttempts = options.maxAppendAttempts ?? 100
  if (!Number.isInteger(maxAppendAttempts) || maxAppendAttempts < 1) {
    throw new Error('campaignLineageStore: maxAppendAttempts must be a positive integer')
  }
  storage.ensureDir(dirname(path))

  const read = (): { text: string; lineage: Lineage } => {
    const stored = storage.read(path)
    if (stored === undefined && storage.exists(path)) {
      throw new Error(`campaignLineageStore: cannot read existing lineage '${path}'`)
    }
    const text = stored ?? ''
    return { text, lineage: Lineage.fromJSONL(text) }
  }

  return {
    async load() {
      return read().lineage
    },
    async append(node) {
      if (!storage.append) {
        throw new Error('campaignLineageStore: CampaignStorage.append is required')
      }
      for (let attempt = 0; attempt < maxAppendAttempts; attempt += 1) {
        const { text, lineage } = read()
        const existing = lineage.get(node.id)
        if (existing) {
          assertSamePersistedNode(existing, node, 'campaignLineageStore')
          return
        }
        for (const parentId of node.parentIds) {
          if (!lineage.has(parentId)) {
            throw new LineageStoreConflictError(
              `campaignLineageStore: node '${node.id}' has unknown persisted parent '${parentId}'`,
            )
          }
        }
        const persisted = lineage.all()
        const expectedSeq =
          persisted.length === 0 ? 0 : Math.max(...persisted.map((entry) => entry.seq)) + 1
        if (node.seq !== expectedSeq) {
          throw new LineageStoreConflictError(
            `campaignLineageStore: stale controller tried sequence ${node.seq}; expected ${expectedSeq}`,
          )
        }
        const line = `${JSON.stringify(node)}\n`
        const expectedBytes = new TextEncoder().encode(text).byteLength
        if (storage.append(path, line, expectedBytes) !== undefined) return
      }
      throw new LineageStoreConflictError(
        `campaignLineageStore: could not append after ${maxAppendAttempts} attempts`,
      )
    },
    async save(lineage) {
      const jsonl = lineage.toJSONL()
      storage.write(path, jsonl.length > 0 ? `${jsonl}\n` : '')
    },
  }
}

/** Filesystem convenience over the conflict-safe CampaignStorage implementation. */
export function fsLineageStore(path: string): LineageStore {
  return campaignLineageStore(fsCampaignStorage(), path)
}

/** In-memory store (default; for tests and ephemeral runs). */
export function memLineageStore(): LineageStore {
  const nodes: LineageNode[] = []
  return {
    async load() {
      return new Lineage(nodes)
    },
    async append(node) {
      const existing = nodes.find((entry) => entry.id === node.id)
      if (existing) {
        assertSamePersistedNode(existing, node, 'memLineageStore')
        return
      }
      nodes.push(node)
    },
    async save(lineage) {
      nodes.length = 0
      nodes.push(...lineage.all())
    },
  }
}

function assertSamePersistedNode(
  existing: LineageNode,
  candidate: LineageNode,
  store: string,
): void {
  if (canonicalJson(existing) !== canonicalJson(candidate)) {
    throw new LineageStoreConflictError(
      `${store}: node '${candidate.id}' already exists with different content`,
    )
  }
}

// ── Governor (agent-managed decision layer) ──────────────────────────────────

export type GovernorOp =
  | { op: 'extend'; track: string }
  | { op: 'branch'; fromNodeId: string; track: string; proposer: string; vision?: string }
  | { op: 'merge'; parentIds: string[]; track: string }
  | { op: 'prune'; track: string }
  | { op: 'stop' }

export interface GovernorContext {
  lineage: Lineage
  /** Operations executed so far. */
  step: number
  budgetRemaining: number
  /** Tracks already pruned — the governor must not target these for extend/branch. */
  prunedTracks: string[]
}

export interface Governor {
  decide(ctx: GovernorContext): Promise<GovernorOp> | GovernorOp
}

export interface HeuristicGovernorOptions {
  /** Cap on live tracks before branching a new one. Default 3. */
  maxTracks?: number
  /** Non-improving steps a track may take before it is pruned. Default 2. */
  plateauSteps?: number
  /** Frontier-tip count (across distinct tracks) that triggers a merge. Default 2. */
  mergeFrontierAt?: number
}

/** The reference deterministic policy an agent {@link Governor} can replace.
 *  Reads only the lineage + context — no LLM, no randomness. */
export function heuristicGovernor(opts: HeuristicGovernorOptions = {}): Governor {
  const maxTracks = opts.maxTracks ?? 3
  const plateauSteps = opts.plateauSteps ?? 2
  const mergeFrontierAt = opts.mergeFrontierAt ?? 2

  return {
    decide(ctx: GovernorContext): GovernorOp {
      const { lineage } = ctx
      if (ctx.budgetRemaining <= 0) return { op: 'stop' }

      const pruned = new Set(ctx.prunedTracks)
      const liveTracks = lineage.tracks().filter((t) => !pruned.has(t))
      if (liveTracks.length === 0) return { op: 'stop' }

      // Merge first: when distinct-track frontier tips have accumulated, collapse
      // them into the best-scoring track so parallel progress consolidates.
      const frontierByTrack = new Map<string, LineageNode>()
      for (const tip of lineage.frontier()) {
        if (pruned.has(tip.track)) continue
        if (!frontierByTrack.has(tip.track)) frontierByTrack.set(tip.track, tip)
      }
      if (frontierByTrack.size >= mergeFrontierAt) {
        const tips = [...frontierByTrack.values()].sort(bySeq)
        const target = pickBest(tips)!
        return { op: 'merge', parentIds: tips.map((t) => t.id), track: target.track }
      }

      // Prune a plateaued track (best score unchanged over the last `plateauSteps`
      // nodes of the track).
      for (const track of liveTracks) {
        if (isPlateaued(lineage.trackNodes(track), plateauSteps)) {
          // Only prune if another live track remains OR we can branch — otherwise
          // pruning the last track just stops the run prematurely.
          if (liveTracks.length > 1 || liveTracks.length < maxTracks) {
            return { op: 'prune', track }
          }
        }
      }

      // Branch a fresh track when there is headroom and the leader has plateaued.
      const leader = pickBest(liveTracks.map((t) => lineage.trackTip(t)!).filter(Boolean))
      if (
        leader &&
        liveTracks.length < maxTracks &&
        isPlateaued(lineage.trackNodes(leader.track), plateauSteps)
      ) {
        return {
          op: 'branch',
          fromNodeId: leader.id,
          track: `${leader.track}+${lineage.tracks().length}`,
          proposer: 'gepa',
        }
      }

      // Otherwise extend the best climbing track.
      if (leader) return { op: 'extend', track: leader.track }
      return { op: 'stop' }
    },
  }
}

/** The LLM-supervisor slot: a governor whose `decide` defers to a caller-supplied
 *  async function (which may read `ctx.lineage.toGraph()`). */
export function callbackGovernor(decide: (ctx: GovernorContext) => Promise<GovernorOp>): Governor {
  return { decide }
}

/** A track is plateaued when its best score has not improved across its most
 *  recent `window` nodes (needs > `window` nodes to judge). */
function isPlateaued(trackNodes: LineageNode[], window: number): boolean {
  if (trackNodes.length <= window) return false
  const ordered = [...trackNodes].sort(bySeq)
  const head = ordered.slice(0, ordered.length - window)
  const tail = ordered.slice(ordered.length - window)
  const bestBefore = Math.max(...head.map((n) => n.score))
  const bestRecent = Math.max(...tail.map((n) => n.score))
  return bestRecent <= bestBefore
}

// ── Orchestration ────────────────────────────────────────────────────────────

export interface RunLineageSeed {
  surface: string
  track: string
  vision?: string
  proposer: string
  score: number
  scoreVector?: number[]
}

export interface RunLineageStepResult {
  surface: string
  score: number
  scoreVector?: number[]
  rationale?: string
  gate?: 'ship' | 'hold'
}

export interface RunLineageOptions {
  seeds: RunLineageSeed[]
  /** Produce one new candidate from a track's tip (propose + measure + gate in
   *  real use; a pure function in tests). */
  step: (args: {
    track: string
    proposer: string
    tip: LineageNode
  }) => Promise<RunLineageStepResult>
  /** Collapse 2+ parent surfaces into one (GEPA crossover / LLM merge in real use). */
  merge: (args: {
    parents: LineageNode[]
    track: string
  }) => Promise<Omit<RunLineageStepResult, 'gate'>>
  governor: Governor
  budget: {
    /** Maximum controller operations in this invocation. */
    maxSteps: number
    /** Optional maximum persisted nodes across every resumed invocation. */
    maxNodes?: number
  }
  store?: LineageStore
  log?: (msg: string, fields?: Record<string, unknown>) => void
}

export interface RunLineageResult {
  lineage: Lineage
  best: LineageNode | undefined
  steps: number
}

/** Drive a multi-track improvement DAG under an agent-managed governor. Seeds each
 *  entry as a root, then repeatedly asks the governor for the next operation
 *  (extend / branch / merge / prune / stop) up to `budget.maxSteps`, persisting
 *  every node. Honors `prune`: a pruned track is never extended or branched again. */
export async function runLineage(opts: RunLineageOptions): Promise<RunLineageResult> {
  if (!Number.isInteger(opts.budget.maxSteps) || opts.budget.maxSteps < 0) {
    throw new Error('runLineage: budget.maxSteps must be a non-negative integer')
  }
  if (
    opts.budget.maxNodes !== undefined &&
    (!Number.isInteger(opts.budget.maxNodes) || opts.budget.maxNodes < 0)
  ) {
    throw new Error('runLineage: budget.maxNodes must be a non-negative integer')
  }
  const store = opts.store ?? memLineageStore()
  const lineage = await store.load()
  const log = opts.log ?? (() => {})
  const pruned = new Set<string>()

  if (opts.budget.maxNodes !== undefined) {
    const missingSeedIds = new Set(
      opts.seeds
        .map((seed) =>
          lineageNodeId({
            parentIds: [],
            track: seed.track,
            surface: seed.surface,
            proposer: seed.proposer,
          }),
        )
        .filter((id) => !lineage.has(id)),
    )
    const available = Math.max(0, opts.budget.maxNodes - lineage.all().length)
    if (missingSeedIds.size > available) {
      throw new Error(
        `runLineage: seed set requires ${missingSeedIds.size} new nodes but budget.maxNodes has ${available} slots remaining`,
      )
    }
  }

  // The proposer a track extends with — seeded, inherited by branches.
  const trackProposer = new Map<string, string>()

  const persist = async (node: LineageNode) => {
    await store.append(node)
  }

  for (const seed of opts.seeds) {
    const node = lineage.addNode({
      parentIds: [],
      track: seed.track,
      surface: seed.surface,
      score: seed.score,
      proposer: seed.proposer,
      ...(seed.vision !== undefined ? { vision: seed.vision } : {}),
      ...(seed.scoreVector !== undefined ? { scoreVector: seed.scoreVector } : {}),
    })
    trackProposer.set(seed.track, seed.proposer)
    await persist(node)
  }

  let steps = 0
  while (steps < opts.budget.maxSteps) {
    if (opts.budget.maxNodes !== undefined && lineage.all().length >= opts.budget.maxNodes) {
      log('lineage: persisted node limit reached', {
        maxNodes: opts.budget.maxNodes,
        nodes: lineage.all().length,
      })
      break
    }
    const nodeBudgetRemaining =
      opts.budget.maxNodes === undefined
        ? Number.POSITIVE_INFINITY
        : opts.budget.maxNodes - lineage.all().length
    const op = await opts.governor.decide({
      lineage,
      step: steps,
      budgetRemaining: Math.min(opts.budget.maxSteps - steps, nodeBudgetRemaining),
      prunedTracks: [...pruned],
    })

    if (op.op === 'stop') {
      log('lineage: governor stop', { steps })
      break
    }

    if (op.op === 'prune') {
      pruned.add(op.track)
      log('lineage: prune', { track: op.track })
      steps += 1
      continue
    }

    if (op.op === 'merge') {
      const parents = op.parentIds
        .map((id) => lineage.get(id))
        .filter((n): n is LineageNode => n !== undefined)
      if (parents.length < 2) {
        log('lineage: merge skipped (fewer than 2 known parents)', { op })
        steps += 1
        continue
      }
      const result = await opts.merge({ parents, track: op.track })
      const node = lineage.merge({
        parentIds: parents.map((p) => p.id),
        track: op.track,
        surface: result.surface,
        score: result.score,
        ...(parents[0]!.vision !== undefined ? { vision: parents[0]!.vision } : {}),
        ...(result.scoreVector !== undefined ? { scoreVector: result.scoreVector } : {}),
        ...(result.rationale !== undefined ? { rationale: result.rationale } : {}),
      })
      await persist(node)
      steps += 1
      continue
    }

    if (op.op === 'branch') {
      if (pruned.has(op.track)) {
        log('lineage: branch skipped (target track pruned)', { track: op.track })
        steps += 1
        continue
      }
      const from = lineage.get(op.fromNodeId)
      if (!from) {
        log('lineage: branch skipped (unknown fromNodeId)', { op })
        steps += 1
        continue
      }
      trackProposer.set(op.track, op.proposer)
      const result = await opts.step({ track: op.track, proposer: op.proposer, tip: from })
      const node = lineage.addNode({
        parentIds: [from.id],
        track: op.track,
        surface: result.surface,
        score: result.score,
        proposer: op.proposer,
        ...(op.vision !== undefined ? { vision: op.vision } : {}),
        ...(result.scoreVector !== undefined ? { scoreVector: result.scoreVector } : {}),
        ...(result.rationale !== undefined ? { rationale: result.rationale } : {}),
        ...(result.gate !== undefined ? { gate: result.gate } : {}),
      })
      await persist(node)
      steps += 1
      continue
    }

    // op.op === 'extend'
    if (pruned.has(op.track)) {
      log('lineage: extend skipped (track pruned)', { track: op.track })
      steps += 1
      continue
    }
    const tip = lineage.trackTip(op.track)
    if (!tip) {
      log('lineage: extend skipped (no tip for track)', { track: op.track })
      steps += 1
      continue
    }
    const proposer = trackProposer.get(op.track) ?? tip.proposer
    const result = await opts.step({ track: op.track, proposer, tip })
    const node = lineage.addNode({
      parentIds: [tip.id],
      track: op.track,
      surface: result.surface,
      score: result.score,
      proposer,
      ...(tip.vision !== undefined ? { vision: tip.vision } : {}),
      ...(result.scoreVector !== undefined ? { scoreVector: result.scoreVector } : {}),
      ...(result.rationale !== undefined ? { rationale: result.rationale } : {}),
      ...(result.gate !== undefined ? { gate: result.gate } : {}),
    })
    await persist(node)
    steps += 1
  }

  return { lineage, best: lineage.best(), steps }
}
