#!/usr/bin/env -S node --experimental-strip-types
/**
 * Seeded synthetic search ledger, kept as a tool (search-tree-design §12's
 * lens packages need real-scale data no committed ledger provides). Every
 * event goes through the real `SearchRecorder`/`FileSearchLedger` — the
 * written file is schema-valid and self-verifying, only its objective is
 * synthetic. Deterministic: the same `--seed` always writes the same bytes.
 *
 * Builds one search over 9 units in 3 families (`a0..a2`, `b0..b2`,
 * `c0..c2`). Each of the four expandable operators proposes a run of
 * children from a deterministic per-operator score-uplift distribution over
 * the root, so `operatorYield` has a known-correct ranking to check against;
 * `merge` draws two parents. Family `a` responds more to `merge`, family `b`
 * more to `improve`, family `c` stays flat — a known specialist pattern
 * `taskMatrix` should recover as separate unit clusters. One operator
 * (`debug`, 4 children by default) is kept under the lens's
 * `MIN_OUTCOMES_FOR_WEIGHT` (6) on purpose, so a run over this ledger always
 * exercises the `insufficient` path alongside `descriptive`/`bootstrap`.
 * One proposal in 7 gets one unknown-cost cell (never every cell of a node:
 * `SearchSpend.unknownCostCells` is per node, so spreading it over every
 * cell would exclude every node from `operatorYield`'s yield sample and
 * `front`'s frontier, defeating the point of a scale fixture), so
 * `operatorYield` and `front` always have real exclusions to report
 * alongside a mostly fully-costed happy path.
 *
 * Usage:
 *   tsx scripts/generate-synthetic-search-ledger.ts --seed 1 --out <path> \
 *     [--per-operator 8] [--debug-count 4]
 */
import { createHash } from 'node:crypto'
import { rmSync } from 'node:fs'
import { dirname } from 'node:path'
import { mulberry32 } from '../src/statistics/random'
import {
  developmentClaim,
  openSearchLedger,
  replaySearchLedgerText,
  SearchRecorder,
  type SearchEdgeOperator,
  type SearchTask,
} from '../src/campaign/index'
import { readFileSync } from 'node:fs'

/** A deterministic stand-in for an immutable revision (the ledger's schema
 * requires a git-shaped or content hash, never a bare label): every source
 * this generator writes is synthetic, so its "revision" is the hash of the
 * seed that produced it, not a real commit. */
function seedRevision(seed: number): string {
  return createHash('sha256').update(`lens-basic-generator-seed-${seed}`).digest('hex')
}

interface Args {
  seed: number
  out: string
  perOperator: number
  debugCount: number
}

function parseArgs(argv: string[]): Args {
  const flags: Record<string, string> = {}
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!
    if (!token.startsWith('--')) continue
    flags[token.slice(2)] = argv[i + 1] ?? ''
    i++
  }
  return {
    seed: Number(flags.seed ?? 1),
    out: flags.out ?? 'synthetic-search-ledger.jsonl',
    perOperator: Number(flags['per-operator'] ?? 8),
    debugCount: Number(flags['debug-count'] ?? 4),
  }
}

const FAMILIES = {
  a: ['a0', 'a1', 'a2'],
  b: ['b0', 'b1', 'b2'],
  c: ['c0', 'c1', 'c2'],
} as const
const UNITS = [...FAMILIES.a, ...FAMILIES.b, ...FAMILIES.c]

/** Mean score uplift over the root by operator and family, before noise.
 * `merge` favors family a, `improve` favors family b, `draft`/`debug` and
 * family c stay close to flat — the pattern this generator's proof checks
 * `operatorYield` and `taskMatrix` recover. */
const UPLIFT: Record<Exclude<SearchEdgeOperator, 'seed' | 'derive'>, Record<keyof typeof FAMILIES, number>> = {
  draft: { a: 0.01, b: 0.0, c: 0.0 },
  improve: { a: 0.03, b: 0.18, c: 0.02 },
  debug: { a: 0.02, b: 0.02, c: 0.01 },
  merge: { a: 0.28, b: 0.05, c: 0.0 },
}
/** Known dollar cost by operator: draft and debug are cheap single-model
 * calls; improve is a heavier rewrite; merge is priced for two parents. */
const COST_USD: Record<Exclude<SearchEdgeOperator, 'seed' | 'derive'>, number> = {
  draft: 0.05,
  improve: 0.12,
  debug: 0.04,
  merge: 0.2,
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value))
}

function familyOf(unitId: string): keyof typeof FAMILIES {
  return unitId[0] as keyof typeof FAMILIES
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const rng = mulberry32(args.seed)
  rmSync(args.out, { force: true })
  rmSync(`${args.out}.head`, { force: true })
  rmSync(`${dirname(args.out)}/blobs`, { recursive: true, force: true })

  const task = (unitId: string, split: 'train' | 'selection'): SearchTask => ({
    taskId: `${unitId}.${split}`,
    unitId,
    source: { uri: `synthetic://${unitId}`, revision: seedRevision(args.seed) },
  })
  const searchId = `synthetic:seed-${args.seed}`
  const ledger = openSearchLedger({ path: args.out, searchId })
  const recorder = await SearchRecorder.open(
    { ledger },
    {
      subject: 'synthetic/lens-proof',
      process: { name: 'generate-synthetic-search-ledger', executionRef: { uri: 'tool://lens-basic', revision: seedRevision(args.seed) } },
      artifactKind: 'prompt',
      objective: {
        metric: 'synthetic-score',
        direction: 'maximize',
        judge: { unknown: 'synthetic generator: no judge' },
        claim: developmentClaim('lens-basic-synthetic-proof'),
      },
      splits: {
        train: UNITS.map((unit) => task(unit, 'train')),
        selection: UNITS.map((unit) => task(unit, 'selection')),
        test: [],
        heldOutUnits: true,
      },
      policy: { expansion: 'synthetic', allocation: 'synthetic', seed: args.seed },
      budget: { maxUsd: null, maxCells: null, maxNodes: null, deadline: null, maxConcurrency: null, reservedClaimUsd: 0 },
      containment: null,
      derivedFrom: null,
      identity: {
        model: { provider: 'synthetic', snapshot: `generator-v1@${args.seed}` },
        agent: { uri: 'tool://lens-basic-generator', revision: seedRevision(args.seed) },
        benchmark: { uri: 'tool://lens-basic-generator', revision: seedRevision(args.seed) },
      },
    },
  )

  let cellSequence = 0
  const identity = {
    model: { provider: 'synthetic', snapshot: `generator-v1@${args.seed}` },
    agent: { uri: 'tool://lens-basic-generator', revision: seedRevision(args.seed) },
    benchmark: { uri: 'tool://lens-basic-generator', revision: seedRevision(args.seed) },
  }

  async function scoreNode(
    nodeId: string,
    opBias: Record<keyof typeof FAMILIES, number>,
    costUsd: number,
    unknownCostNode: boolean,
  ): Promise<void> {
    let unknownCostCellRemaining = unknownCostNode ? 1 : 0
    for (const split of ['train', 'selection'] as const) {
      for (const unitId of UNITS) {
        const family = familyOf(unitId)
        const base = 0.5 + opBias[family]
        const score = clamp01(base + (rng() - 0.5) * 0.06)
        const cellId = await recorder.allocateCell({
          nodeId,
          taskId: `${unitId}.${split}`,
          split,
          rep: 0,
          stage: split === 'train' ? 'train' : 'screen',
          lane: 'synthetic',
        })
        cellSequence += 1
        // One node in 7 (`unknownCostNode`) gets exactly one unknown-cost
        // cell (its first), so `operatorYield`/`front` see real exclusions
        // without excluding every node: `unknownCostCells` is per-node
        // (search-state.ts), so spreading unknown cost across every cell of
        // every node (the per-cell version this replaced) left ~100% of
        // nodes with at least one unknown-cost cell at 18 cells/node,
        // excluding the whole ledger from both lenses' yield/front sample —
        // caught by the real-run proof, not a unit test.
        const unknownCost = unknownCostCellRemaining > 0
        if (unknownCost) unknownCostCellRemaining -= 1
        await recorder.settleCell({
          cellId,
          outcome: { status: 'passed', score, metrics: { score } },
          accounting: {
            tokens: { status: 'unknown', reason: 'synthetic generator records no tokens' },
            cost: unknownCost
              ? { status: 'unknown', knownLowerBoundUsd: 0, reason: 'synthetic: one node in 7 has one cell priced unknown on purpose' }
              : { status: 'known', usd: costUsd, source: 'pricing-table' },
          },
          identity,
          wallMs: 1,
          traceRef: { unknown: 'synthetic generator writes no trace' },
        })
      }
    }
  }

  // Root.
  const rootDigest = `sha256:${'0'.repeat(64)}` as const
  const rootArtifact = recorder.blob('prompt', { seed: args.seed, role: 'root' })
  const root = await recorder.registerNode({
    artifactDigest: rootDigest,
    artifact: rootArtifact,
    surfaces: [{ surfaceId: 'prompt', kind: 'prompt', artifact: rootArtifact }],
  })
  await recorder.recordEdge({
    childNodeId: root.nodeId,
    parents: [],
    operator: 'seed',
    attribution: 'explicit',
    proposer: null,
    proposalKey: 'root',
    rationale: { unknown: 'the root is the search input' },
    diffs: [],
    label: 'synthetic root',
  })
  await scoreNode(root.nodeId, { a: 0, b: 0, c: 0 }, 0, false)

  // Only nodes not (yet) decided `invalid` are eligible parents: the
  // projector refuses an edge from an invalid parent (search-ledger's own
  // rule, matching §6.2's "a node that failed admission never becomes a
  // parent"). At small `--per-operator` counts this never came up by chance;
  // the real-run proof at `--per-operator 20` hit it on the first larger
  // run.
  const validParentIds: string[] = [root.nodeId]
  const counts: Record<Exclude<SearchEdgeOperator, 'seed' | 'derive'>, number> = {
    draft: args.perOperator,
    improve: args.perOperator,
    debug: args.debugCount,
    merge: args.perOperator,
  }

  let proposalIndex = 0
  for (const operator of ['draft', 'improve', 'debug', 'merge'] as const) {
    for (let i = 0; i < counts[operator]; i++) {
      proposalIndex += 1
      const parentIndex = Math.floor(rng() * validParentIds.length)
      const parentId = validParentIds[parentIndex]!
      const secondParentId =
        operator === 'merge' && validParentIds.length > 1
          ? validParentIds[
              (parentIndex + 1 + Math.floor(rng() * (validParentIds.length - 1))) %
                validParentIds.length
            ]!
          : null
      const digest = `sha256:${proposalIndex.toString(16).padStart(4, '0')}${'0'.repeat(60)}` as const
      const artifact = recorder.blob('prompt', { seed: args.seed, proposalIndex, operator, parentId, secondParentId })
      const { nodeId } = await recorder.registerNode({
        artifactDigest: digest,
        artifact,
        surfaces: [{ surfaceId: 'prompt', kind: 'prompt', artifact }],
      })
      const parents = secondParentId ? [parentId, secondParentId] : [parentId]
      const diff = recorder.blob('diff', { operator, proposalIndex })
      await recorder.recordEdge({
        childNodeId: nodeId,
        parents,
        operator,
        attribution: 'explicit',
        proposer: { kind: 'trace', name: 'synthetic-proposer', operationId: null, source: { uri: 'tool://lens-basic-generator', revision: seedRevision(args.seed) } },
        proposalKey: `proposal-${proposalIndex}`,
        rationale: `synthetic ${operator} #${proposalIndex}`,
        diffs: parents.map(() => diff),
        label: `${operator} #${proposalIndex}`,
      })
      await scoreNode(nodeId, UPLIFT[operator], COST_USD[operator], proposalIndex % 7 === 0)

      const state = await recorder.state()
      const node = state.node(nodeId)!
      const rootUnits = new Map(state.unitScores(root.nodeId, 'selection').map((u) => [u.unitId, u.mean]))
      const nodeUnits = state.unitScores(nodeId, 'selection')
      const shared = nodeUnits.filter((u) => rootUnits.has(u.unitId))
      const meanNode = shared.reduce((sum, u) => sum + u.mean, 0) / Math.max(shared.length, 1)
      const meanRoot = shared.reduce((sum, u) => sum + (rootUnits.get(u.unitId) ?? 0), 0) / Math.max(shared.length, 1)
      const invalid = proposalIndex % 17 === 0
      if (invalid) {
        await recorder.decideNode({ nodeId, decision: { status: 'invalid' }, rule: 'synthetic', reason: 'synthetic: every 17th proposal is marked invalid for outcome-count coverage' })
      } else if (meanNode > meanRoot) {
        // `advanced` is not a terminal decision (it stays undecided until a
        // later rung or prune, per `SearchState`'s completion check) and
        // `finalist` seals the search against further nodes and cells — both
        // wrong for this flat, allocator-less generator. `pruned` is the
        // terminal status closest to "beat the root, kept no further budget",
        // and carries no seal.
        await recorder.decideNode({ nodeId, decision: { status: 'pruned' }, rule: 'synthetic', reason: `${meanNode.toFixed(4)} > root ${meanRoot.toFixed(4)}` })
      } else {
        await recorder.decideNode({ nodeId, decision: { status: 'rejected' }, rule: 'synthetic', reason: `${meanNode.toFixed(4)} <= root ${meanRoot.toFixed(4)}` })
      }
      if (!invalid) validParentIds.push(nodeId)
      void node
    }
  }

  await recorder.decideNode({ nodeId: root.nodeId, decision: { status: 'selected' }, rule: 'synthetic', reason: 'synthetic generator keeps the root selected' })
  await recorder.close({ reason: 'max-nodes', claim: null })

  const text = readFileSync(args.out, 'utf8')
  const state = replaySearchLedgerText(text, searchId, args.out)
  console.log(
    `wrote ${args.out}: ${text.split('\n').filter(Boolean).length} entries, ${Buffer.byteLength(text)} bytes, ` +
      `${state.nodes().length} nodes, ${state.edges().length} edges, ${state.cells().length} cells, complete=${state.completion.complete}`,
  )
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
