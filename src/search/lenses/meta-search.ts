/**
 * `metaSearch(searches)`: a search of searches (search-tree-design §12).
 *
 * Every search is one node. Its genome is the configuration that ran it: the
 * expansion policy and allocator its header declares (their names carry
 * their parameters, such as patience, operator weights and rung sizes), its
 * budget, and the proposer its edges and candidate-generation operations
 * name, with the proposer's model. Its score is the held-out lift its claim
 * measured, per known dollar of the whole search.
 *
 * The held-out lift is `estimateNode` of one node against the root on the
 * sealed test split, from the test cells themselves: the shipped node on
 * `ship`; on `hold`, the first finalist not decided invalid, in the claim's
 * order, which the claim fixed from selection data before any test cell ran.
 * A hold's measured lift counts rather than being dropped: keeping only the
 * searches whose test was significant would inflate a configuration's mean.
 * A search whose claim is open, missing, `test-cannot-resolve`, contradicted
 * by its own ledger (`verifySearchClaim`), held with no finalist tested, or
 * whose lift pairs fewer than 2 test units is unscored with its reason, never
 * 0, and every configuration reports how many of its searches were scored.
 *
 * Dollars are the search's committed spend: every cell and operation, the
 * claim's test cells included. An unknown-cost cell or operation leaves only a
 * floor, so that search's lift per dollar is a bound, not a value, and stays
 * out of every estimate. A search that recorded no spend has none either.
 *
 * Searches arrange into a forest by derivation (`derivedFrom`: a search that
 * started from a node of another) and containment (`containment`: a search
 * that ran inside a cell of another). A search contained in an outer search's
 * cell belongs to that cell's node: the outer node is its configuration, and
 * the outer node's lineage is the configuration's lineage.
 *
 * Configurations group searches with one genome and one objective (subject,
 * metric, direction). A configuration's lift per dollar summarizes its scored
 * searches as independent units with `summarizeSamples` (a percentile
 * bootstrap of the mean); a configuration with one scored search carries that
 * search's own paired interval, whose units are its test units. The signal
 * names the configuration with the largest estimate within one objective.
 */

import { estimateNode, seedFromDigest } from '../../campaign/estimate-node'
import { type SearchClaimVerification, verifySearchClaim } from '../../campaign/search-claim'
import type {
  NodeEstimate,
  SearchClaim,
  SearchCloseReason,
  SearchEstimateMethod,
  SearchLedgerHash,
  SearchModelIdentity,
  SearchProposerKind,
  SearchSourceRef,
} from '../../campaign/search-ledger-types'
import type { SearchStateView } from '../../campaign/search-state'
import { compareCodeUnits, hashCanonical } from '../../ledger-core/canonical'
import {
  INSUFFICIENT_FROM,
  type LensResult,
  rankingSplit,
  type SampleSummary,
  summarizeSamples,
} from './shared'

/** The configuration that ran a search, as its ledger records it. */
export interface SearchPolicyGenome {
  /** `policy.expansion`: the policy's name with its parameters. A parameter
   * equal to the search's own seed (`seed=<n>`) reads `seed=<search>`: the
   * seed varies per search and is not a configuration choice. */
  expansion: string
  /** `policy.allocation`: the allocator's name with its rung sizes. */
  allocation: string
  budget: {
    maxUsd: number | null
    maxCells: number | null
    maxNodes: number | null
    maxConcurrency: number | null
    reservedClaimUsd: number
  }
  /** Every proposer a non-seed edge names, in canonical order. Unknown when
   * the search recorded no proposal, so its proposer cannot be read. */
  proposers:
    | Array<{ kind: SearchProposerKind; name: string; source: SearchSourceRef }>
    | {
        unknown: string
      }
  /** What ran the candidate-generation operations (a proposer's model, or
   * deterministic code), in canonical order; unknown with no such operation. */
  proposerExecution:
    | Array<
        | { kind: 'model'; model: SearchModelIdentity }
        | { kind: 'deterministic'; source: SearchSourceRef }
      >
    | { unknown: string }
}

/** Why a search has no lift to score. */
export type MetaSearchUnscoredReason =
  | 'open'
  | 'no-claim'
  | 'claim-mismatch'
  | 'test-cannot-resolve'
  | 'no-valid-finalist'
  | 'insufficient'

export interface MetaSearchSpend {
  knownUsd: number
  /** Proven lower bounds of unknown costs. */
  floorUsd: number
  /** Cells and operations whose cost is unknown. */
  unknownCost: number
}

/** A search's lift per dollar: a value, a bound when some cost is only a
 * floor, or unknown. */
export type MetaSearchLiftPerUsd =
  | {
      status: 'known'
      value: number
      /** The lift's interval divided by the known spend, which is exact. */
      interval: [number, number] | null
    }
  | {
      status: 'bound'
      /** The lift divided by the committed spend, a lower bound on the true
       * spend: the true value lies at or below it for a gain and at or above
       * it for a loss. */
      value: number
      bound: 'at-most' | 'at-least'
      reason: string
    }
  | { status: 'unknown'; reason: string }

export type MetaSearchScore =
  | {
      status: 'scored'
      decision: 'ship' | 'hold'
      /** The node whose held-out lift this is. */
      nodeId: string
      /** The node against the root on the test split. */
      estimate: NodeEstimate
      /** `estimate.delta` oriented so a gain is positive, in the metric's units. */
      lift: number
      /** `estimate.interval`, oriented the same way; null below 6 units. */
      liftInterval: [number, number] | null
      spend: MetaSearchSpend
      liftPerUsd: MetaSearchLiftPerUsd
    }
  | {
      status: 'unscored'
      decision: SearchClaim['decision'] | null
      reason: MetaSearchUnscoredReason
      detail: string
      spend: MetaSearchSpend
    }

/** How a search relates to its parent in the forest. */
export type MetaSearchParent =
  | {
      relation: 'derived'
      searchId: string
      /** The parent's node this search started from. */
      nodeId: string
      /** The parent is among the searches the lens read. */
      present: boolean
    }
  | {
      relation: 'contained'
      searchId: string
      cellId: string
      attempt: number
      /** The outer node whose cell ran this search; null when the outer
       * search was not read. */
      nodeId: string | null
      present: boolean
    }

export interface MetaSearchEntry {
  searchId: string
  subject: string
  objective: { metric: string; direction: 'maximize' | 'minimize' }
  /** `subject · metric (direction)`: searches are compared only within one. */
  objectiveKey: string
  status: 'open' | 'closed'
  closeReason: SearchCloseReason | null
  genome: SearchPolicyGenome
  genomeDigest: SearchLedgerHash
  seed: number
  rootArtifactDigest: string | null
  nodes: number
  cells: { settled: number; test: number }
  claim: {
    decision: SearchClaim['decision']
    selected: string | null
    verification: 'verified' | 'mismatch' | 'unknown'
    reason: string
  } | null
  score: MetaSearchScore
  parent: MetaSearchParent | null
  children: string[]
  /** Edges from the forest's root; 0 for a root. */
  depth: number
  /** The search's own tree, for a glyph: `[nodeId, primaryParentId, status]`
   * in registration order, the first `glyphNodes`. */
  glyph: { nodes: Array<[string, string | null, string | null]>; omitted: number }
}

/** A configuration's lift per known dollar across its scored searches. */
export interface MetaSearchConfigurationEstimate {
  /** `searches`: the scored searches are the units. `test-units`: one scored
   * search, so its own test units are. */
  basis: 'searches' | 'test-units'
  n: number
  value: number | null
  method: SearchEstimateMethod
  interval: [number, number] | null
  /** How the interval was computed; null without one. */
  intervalMethod: 'percentile-bootstrap-of-mean' | 'paired-delta-test-over-usd' | null
}

export interface MetaSearchConfiguration {
  genomeDigest: SearchLedgerHash
  objectiveKey: string
  genome: SearchPolicyGenome
  searches: string[]
  decisions: { ship: number; hold: number; 'test-cannot-resolve': number; none: number }
  /** Searches with a known lift per dollar. */
  scored: number
  /** Searches whose lift per dollar is a bound. */
  bounded: number
  unscored: Partial<Record<MetaSearchUnscoredReason, number>>
  estimate: MetaSearchConfigurationEstimate
  /** Outer-search nodes whose cells ran this configuration's searches, with
   * the outer node's parent configuration and its paired estimate against it
   * on the outer search's ranking split. */
  outerNodes: Array<{
    searchId: string
    nodeId: string
    parentNodeId: string | null
    parentGenomeDigest: SearchLedgerHash | null
    againstParent: NodeEstimate | null
  }>
}

export interface MetaSearchData {
  searches: MetaSearchEntry[]
  roots: string[]
  /** Best first: by estimate, then configurations without one. */
  configurations: MetaSearchConfiguration[]
  objectives: string[]
  /** The objective the signal ranks within; null when none could be chosen. */
  signalObjective: string | null
}

/** The signal: the configuration with the largest estimated lift per known
 * dollar within one objective, with its interval, its method and its n. */
export interface BestPolicyConfiguration {
  /** Lift per known dollar of the best configuration; null when none has one. */
  liftPerUsd: number | null
  objectiveKey: string | null
  genomeDigest: SearchLedgerHash | null
  genome: SearchPolicyGenome | null
  interval: [number, number] | null
  method: SearchEstimateMethod | null
  intervalMethod: MetaSearchConfigurationEstimate['intervalMethod']
  basis: MetaSearchConfigurationEstimate['basis'] | null
  n: number
  /** The configuration's searches, and how many of them have a known lift
   * per dollar: the rest are unscored or bounded, never counted as 0. */
  searches: number
  scored: number
  /** An outer-search node whose artifact runs this configuration, when an
   * outer search ran it: the runnable configuration a caller derives the next
   * search from. Null for a configuration only free-standing searches ran. */
  outerNode: { searchId: string; nodeId: string } | null
  /** Why the value is what it is, including why it is null. */
  reason: string
}

export interface MetaSearchOptions {
  /** Nodes of each search's own tree carried for its glyph. Default 64. */
  glyphNodes?: number
  /** The objective key the signal ranks within. Default: the one objective
   * whose searches have a known lift per dollar; with several, the signal is
   * null until one is named. */
  objective?: string
}

/** The signal's name, as a policy or a view reads it. */
export const META_SEARCH_SIGNAL = 'metaSearch.bestPolicyConfiguration'

const DEFAULT_GLYPH_NODES = 64

/**
 * Every rule the per-search score depends on. Its digest is the score's
 * revision, which an outer search pins as its judge, so an outer climb's
 * cells and the lens report one number.
 */
const META_SEARCH_SCORE_DEFINITION = {
  name: 'tangle.meta-search-score.2026-09',
  node: 'the claim selection on ship; on hold, the first finalist in claim order not decided invalid',
  lift: 'estimateNode(node, against root, split test), oriented so a gain is positive',
  unscored: [
    'open',
    'no claim',
    'claim the ledger contradicts (verifySearchClaim mismatch)',
    'test-cannot-resolve',
    'hold with no finalist tested',
    'fewer than 2 shared test units',
  ],
  dollars: 'committed spend of every cell and operation, claim cells included',
  unknownCost: 'a floor only: the lift per dollar is a bound and enters no estimate',
} as const

/** The per-search score `metaSearchScore` computes. An outer search names it
 * as its objective's judge. */
export const META_SEARCH_SCORE_SOURCE: SearchSourceRef = {
  uri: 'npm:@tangle-network/agent-eval#metaSearchScore',
  revision: hashCanonical(META_SEARCH_SCORE_DEFINITION),
}

/**
 * The genome of a search: the configuration its ledger records. Declared
 * parts come from the header; the proposer comes from what the edges and
 * candidate-generation operations name, because the header declares none.
 */
export function searchPolicyGenome(state: SearchStateView): SearchPolicyGenome {
  const header = state.header
  if (!header) throw new Error(`search ${state.searchId} has not been opened`)
  const { maxUsd, maxCells, maxNodes, maxConcurrency, reservedClaimUsd } = header.budget
  const proposers = new Map<
    string,
    { kind: SearchProposerKind; name: string; source: SearchSourceRef }
  >()
  const operations = new Set<string>()
  for (const edge of state.edges()) {
    if (!edge.proposer) continue
    const { kind, name, source, operationId } = edge.proposer
    const proposer = { kind, name, source }
    proposers.set(hashCanonical(proposer), proposer)
    if (operationId !== null) operations.add(operationId)
  }
  const executions = new Map<
    string,
    | { kind: 'model'; model: SearchModelIdentity }
    | { kind: 'deterministic'; source: SearchSourceRef }
  >()
  for (const operationId of operations) {
    const execution = state.operation(operationId)?.execution
    if (!execution) continue
    const entry =
      execution.kind === 'model'
        ? { kind: 'model' as const, model: execution.model }
        : { kind: 'deterministic' as const, source: execution.source }
    executions.set(hashCanonical(entry), entry)
  }
  return {
    expansion: withoutSearchSeed(header.policy.expansion, header.policy.seed),
    allocation: withoutSearchSeed(header.policy.allocation, header.policy.seed),
    budget: { maxUsd, maxCells, maxNodes, maxConcurrency, reservedClaimUsd },
    proposers:
      proposers.size > 0
        ? sortedValues(proposers)
        : { unknown: 'the search recorded no proposal, so its proposer is not in the ledger' },
    proposerExecution:
      executions.size > 0
        ? sortedValues(executions)
        : { unknown: 'no recorded candidate-generation operation names what ran the proposer' },
  }
}

/**
 * A search's held-out lift per known dollar, from its claim and its test
 * cells. Pure; it reads the test split, so a policy view (which holds no test
 * cells) cannot call it; an outer search reads it from a closed inner search.
 */
export function metaSearchScore(state: SearchStateView): MetaSearchScore {
  return scoreSearch(state, state.closed?.claim ? verifySearchClaim(state) : null)
}

function scoreSearch(
  state: SearchStateView,
  verification: SearchClaimVerification | null,
): MetaSearchScore {
  const header = state.header
  if (!header) throw new Error(`search ${state.searchId} has not been opened`)
  const { spend: audit } = state.audit
  const spend: MetaSearchSpend = {
    knownUsd: audit.knownUsd,
    floorUsd: audit.floorUsd,
    unknownCost: audit.unknownCostCells + audit.unknownCostOperations,
  }
  const unscored = (
    reason: MetaSearchUnscoredReason,
    detail: string,
    decision: SearchClaim['decision'] | null = null,
  ): MetaSearchScore => ({ status: 'unscored', decision, reason, detail, spend })

  const closed = state.closed
  if (!closed) return unscored('open', 'the search is open; its claim is made when it closes')
  const claim = closed.claim
  if (!claim) {
    return unscored(
      'no-claim',
      `the search closed (${closed.reason}) without a claim on a test split`,
    )
  }
  if (verification?.status === 'mismatch') {
    return unscored(
      'claim-mismatch',
      `the claim differs from what its ledger supports: ${verification.differences.join('; ')}`,
      claim.decision,
    )
  }
  if (claim.decision === 'test-cannot-resolve') {
    return unscored('test-cannot-resolve', claim.reason, claim.decision)
  }
  const root = state.rootNodeId!
  const nodeId =
    claim.decision === 'ship'
      ? claim.selected
      : (claim.finalists.find((finalist) => state.node(finalist.nodeId)?.status !== 'invalid')
          ?.nodeId ?? null)
  if (nodeId === null || nodeId === root) {
    return unscored(
      'no-valid-finalist',
      claim.finalists.length === 0
        ? `hold: no finalist went to test (${claim.reason})`
        : `hold: every finalist was decided invalid (${claim.finalists.length})`,
      claim.decision,
    )
  }
  const estimate = estimateNode(state, nodeId, { against: root, split: 'test' })
  if (estimate.delta === null) {
    return unscored(
      'insufficient',
      `${nodeId} and the root share ${estimate.pairs} scored test unit${estimate.pairs === 1 ? '' : 's'}; a lift needs 2`,
      claim.decision,
    )
  }
  const maximize = header.objective.direction === 'maximize'
  const lift = orient(estimate.delta, maximize)
  const liftInterval = estimate.interval ? orientInterval(estimate.interval, maximize) : null
  return {
    status: 'scored',
    decision: claim.decision,
    nodeId,
    estimate,
    lift,
    liftInterval,
    spend,
    liftPerUsd: liftPerUsd(lift, liftInterval, spend),
  }
}

/** The lens: every search as a node of a search of searches. */
export function metaSearch(
  searches: readonly SearchStateView[],
  options: MetaSearchOptions = {},
): LensResult<MetaSearchData, BestPolicyConfiguration> {
  const glyphNodes = options.glyphNodes ?? DEFAULT_GLYPH_NODES
  if (!Number.isSafeInteger(glyphNodes) || glyphNodes < 0) {
    throw new TypeError(`metaSearch: glyphNodes must be a non-negative integer, got ${glyphNodes}`)
  }
  const byId = new Map<string, SearchStateView>()
  for (const state of searches) {
    if (!state.header) throw new Error(`metaSearch: search ${state.searchId} has not been opened`)
    if (byId.has(state.searchId)) {
      throw new Error(`metaSearch: search ${state.searchId} was given twice`)
    }
    byId.set(state.searchId, state)
  }

  const entries = searches.map((state) => entry(state, byId, glyphNodes))
  const entryById = new Map(entries.map((item) => [item.searchId, item]))
  for (const item of entries) {
    if (item.parent?.present) entryById.get(item.parent.searchId)!.children.push(item.searchId)
  }
  const roots = entries.filter((item) => !item.parent?.present).map((item) => item.searchId)
  const assignDepth = (searchId: string, depth: number, seen: Set<string>): void => {
    if (seen.has(searchId)) return
    seen.add(searchId)
    const item = entryById.get(searchId)!
    item.depth = depth
    for (const child of item.children) assignDepth(child, depth + 1, seen)
  }
  const seen = new Set<string>()
  for (const root of roots) assignDepth(root, 0, seen)

  const configurations = configure(entries, byId)
  const objectives = [...new Set(entries.map((item) => item.objectiveKey))].sort(compareCodeUnits)
  const { objective, value } = best(configurations, objectives, options.objective)
  return {
    data: { searches: entries, roots, configurations, objectives, signalObjective: objective },
    signal: { name: META_SEARCH_SIGNAL, value },
  }
}

function entry(
  state: SearchStateView,
  byId: ReadonlyMap<string, SearchStateView>,
  glyphNodes: number,
): MetaSearchEntry {
  const header = state.header!
  const genome = searchPolicyGenome(state)
  const closed = state.closed
  let claim: MetaSearchEntry['claim'] = null
  const verification = closed?.claim ? verifySearchClaim(state) : null
  if (closed?.claim) {
    claim = {
      decision: closed.claim.decision,
      selected: closed.claim.selected,
      verification: verification?.status ?? 'unknown',
      reason: closed.claim.reason,
    }
  }
  const nodes = state.nodes()
  const cells = state.cells()
  return {
    searchId: state.searchId,
    subject: header.subject,
    objective: { metric: header.objective.metric, direction: header.objective.direction },
    objectiveKey: objectiveKey(header),
    status: closed ? 'closed' : 'open',
    closeReason: closed?.reason ?? null,
    genome,
    genomeDigest: hashCanonical(genome),
    seed: header.policy.seed,
    rootArtifactDigest: nodes[0]?.artifactDigest ?? null,
    nodes: nodes.length,
    cells: {
      settled: state.audit.cells.settled,
      test: cells.filter((cell) => cell.split === 'test').length,
    },
    claim,
    score: scoreSearch(state, verification),
    parent: parentOf(state, byId),
    children: [],
    depth: 0,
    glyph: {
      nodes: nodes
        .slice(0, glyphNodes)
        .map((node): [string, string | null, string | null] => [
          node.nodeId,
          node.primaryParentId,
          node.status,
        ]),
      omitted: Math.max(0, nodes.length - glyphNodes),
    },
  }
}

/** `subject · metric (direction)`: the key searches are compared within. */
export function objectiveKey(header: NonNullable<SearchStateView['header']>): string {
  return `${header.subject} · ${header.objective.metric} (${header.objective.direction})`
}

function parentOf(
  state: SearchStateView,
  byId: ReadonlyMap<string, SearchStateView>,
): MetaSearchParent | null {
  const header = state.header!
  if (header.containment) {
    const { searchId, cellId, attempt } = header.containment
    const outer = byId.get(searchId)
    return {
      relation: 'contained',
      searchId,
      cellId,
      attempt,
      nodeId: outer?.cell(cellId)?.nodeId ?? null,
      present: outer !== undefined,
    }
  }
  if (header.derivedFrom) {
    const { searchId, nodeId } = header.derivedFrom
    return { relation: 'derived', searchId, nodeId, present: byId.has(searchId) }
  }
  return null
}

function configure(
  entries: readonly MetaSearchEntry[],
  byId: ReadonlyMap<string, SearchStateView>,
): MetaSearchConfiguration[] {
  const groups = new Map<string, MetaSearchEntry[]>()
  for (const item of entries) {
    const key = `${item.objectiveKey}\u0000${item.genomeDigest}`
    const group = groups.get(key)
    if (group) group.push(item)
    else groups.set(key, [item])
  }
  // The configuration each outer node ran: the genome of the searches its
  // cells contain.
  const genomeOfOuterNode = new Map<string, SearchLedgerHash>()
  for (const item of entries) {
    if (item.parent?.relation === 'contained' && item.parent.nodeId !== null) {
      genomeOfOuterNode.set(`${item.parent.searchId}\u0000${item.parent.nodeId}`, item.genomeDigest)
    }
  }
  const configurations = [...groups.values()].map((group): MetaSearchConfiguration => {
    const first = group[0]!
    const decisions = { ship: 0, hold: 0, 'test-cannot-resolve': 0, none: 0 }
    const unscored: MetaSearchConfiguration['unscored'] = {}
    const values: number[] = []
    let single: MetaSearchConfigurationEstimate | null = null
    let bounded = 0
    for (const item of group) {
      decisions[item.claim?.decision ?? 'none'] += 1
      const score = item.score
      if (score.status === 'unscored') {
        unscored[score.reason] = (unscored[score.reason] ?? 0) + 1
        continue
      }
      if (score.liftPerUsd.status === 'bound') bounded += 1
      if (score.liftPerUsd.status !== 'known') continue
      values.push(score.liftPerUsd.value)
      single = {
        basis: 'test-units',
        n: score.estimate.pairs,
        value: score.liftPerUsd.value,
        method: score.estimate.method,
        interval: score.liftPerUsd.interval,
        intervalMethod: score.liftPerUsd.interval ? 'paired-delta-test-over-usd' : null,
      }
    }
    const estimate: MetaSearchConfigurationEstimate =
      values.length === 1 && single
        ? single
        : fromSummary(summarizeSamples(values, seedFromDigest(first.genomeDigest)))
    const outerNodes = new Map<string, MetaSearchConfiguration['outerNodes'][number]>()
    for (const item of group) {
      const parent = item.parent
      if (parent?.relation !== 'contained' || parent.nodeId === null) continue
      const key = `${parent.searchId}\u0000${parent.nodeId}`
      if (outerNodes.has(key)) continue
      const outer = byId.get(parent.searchId)!
      const node = outer.node(parent.nodeId)!
      const parentNodeId = node.primaryParentId
      outerNodes.set(key, {
        searchId: parent.searchId,
        nodeId: parent.nodeId,
        parentNodeId,
        parentGenomeDigest:
          parentNodeId === null
            ? null
            : (genomeOfOuterNode.get(`${parent.searchId}\u0000${parentNodeId}`) ?? null),
        againstParent:
          parentNodeId === null
            ? null
            : estimateNode(outer, parent.nodeId, {
                against: parentNodeId,
                split: rankingSplit(outer),
              }),
      })
    }
    return {
      genomeDigest: first.genomeDigest,
      objectiveKey: first.objectiveKey,
      genome: first.genome,
      searches: group.map((item) => item.searchId),
      decisions,
      scored: values.length,
      bounded,
      unscored,
      estimate,
      outerNodes: [...outerNodes.values()],
    }
  })
  return configurations.sort(
    (left, right) =>
      rankValue(right.estimate.value) - rankValue(left.estimate.value) ||
      right.scored - left.scored ||
      compareCodeUnits(left.objectiveKey, right.objectiveKey) ||
      compareCodeUnits(left.genomeDigest, right.genomeDigest),
  )
}

function best(
  configurations: readonly MetaSearchConfiguration[],
  objectives: readonly string[],
  requested: string | undefined,
): { objective: string | null; value: BestPolicyConfiguration } {
  const empty = (
    objective: string | null,
    reason: string,
  ): { objective: string | null; value: BestPolicyConfiguration } => ({
    objective,
    value: {
      liftPerUsd: null,
      objectiveKey: objective,
      genomeDigest: null,
      genome: null,
      interval: null,
      method: null,
      intervalMethod: null,
      basis: null,
      n: 0,
      searches: 0,
      scored: 0,
      outerNode: null,
      reason,
    },
  })
  if (configurations.length === 0) return empty(null, 'no search was given')
  const measured = [
    ...new Set(
      configurations
        .filter((item) => item.estimate.value !== null)
        .map((item) => item.objectiveKey),
    ),
  ].sort(compareCodeUnits)
  let objective: string
  if (requested !== undefined) {
    if (!objectives.includes(requested)) {
      return empty(
        requested,
        `no search given has objective ${requested}; the searches have ${objectives.join('; ')}`,
      )
    }
    objective = requested
  } else if (measured.length > 1) {
    return empty(
      null,
      `searches with a known lift per dollar span ${measured.length} objectives (${measured.join('; ')}); a lift in one metric does not compare with another, so name one`,
    )
  } else {
    objective = measured[0] ?? (objectives.length === 1 ? objectives[0]! : '')
    if (objective === '') {
      return empty(
        null,
        `no configuration has a known lift per dollar, across ${objectives.length} objectives`,
      )
    }
  }
  const within = configurations.filter((item) => item.objectiveKey === objective)
  const withValue = within.filter((item) => item.estimate.value !== null)
  const top = withValue[0]
  if (!top) {
    const unscored = within.reduce(
      (total, item) =>
        total + Object.values(item.unscored).reduce((sum, count) => sum + (count ?? 0), 0),
      0,
    )
    const bounded = within.reduce((total, item) => total + item.bounded, 0)
    return empty(
      objective,
      `no configuration of ${objective} has a known lift per dollar: ${unscored} unscored search${unscored === 1 ? '' : 'es'} and ${bounded} with only a spend floor`,
    )
  }
  const { estimate } = top
  const runnerUp = withValue[1]
  const coverage = `${top.scored} of ${top.searches.length} of its searches scored`
  return {
    objective,
    value: {
      liftPerUsd: estimate.value,
      objectiveKey: objective,
      genomeDigest: top.genomeDigest,
      genome: top.genome,
      interval: estimate.interval,
      method: estimate.method,
      intervalMethod: estimate.intervalMethod,
      basis: estimate.basis,
      n: estimate.n,
      searches: top.searches.length,
      scored: top.scored,
      outerNode: top.outerNodes[0]
        ? { searchId: top.outerNodes[0].searchId, nodeId: top.outerNodes[0].nodeId }
        : null,
      reason:
        runnerUp === undefined
          ? `the only configuration with a known lift per dollar (${estimate.method}, ${estimate.basis} n=${estimate.n}; ${coverage})`
          : `the largest of ${withValue.length} configurations by estimated lift per dollar (${estimate.method}, ${estimate.basis} n=${estimate.n}; ${coverage}); a point ranking, not a test`,
    },
  }
}

function liftPerUsd(
  lift: number,
  interval: [number, number] | null,
  spend: MetaSearchSpend,
): MetaSearchLiftPerUsd {
  const committed = spend.knownUsd + spend.floorUsd
  if (spend.unknownCost > 0) {
    if (committed <= 0) {
      return {
        status: 'unknown',
        reason: `${spend.unknownCost} cost${spend.unknownCost === 1 ? ' is' : 's are'} unknown with no proven floor`,
      }
    }
    return {
      status: 'bound',
      value: lift / committed,
      bound: lift >= 0 ? 'at-most' : 'at-least',
      reason: `${spend.unknownCost} cost${spend.unknownCost === 1 ? ' is' : 's are'} known only as a floor; $${round(committed)} is the least the search spent`,
    }
  }
  if (spend.knownUsd <= 0) {
    return {
      status: 'unknown',
      reason: 'the search recorded no spend, so a lift per dollar is undefined',
    }
  }
  return {
    status: 'known',
    value: lift / spend.knownUsd,
    interval: interval ? [interval[0] / spend.knownUsd, interval[1] / spend.knownUsd] : null,
  }
}

function fromSummary(summary: SampleSummary): MetaSearchConfigurationEstimate {
  return {
    basis: 'searches',
    n: summary.n,
    value: summary.mean,
    method: summary.n < 2 ? 'none' : summary.method,
    interval: summary.interval,
    intervalMethod: summary.interval ? 'percentile-bootstrap-of-mean' : null,
  }
}

// ── text form ────────────────────────────────────────────────────────

export interface MetaSearchTextOptions {
  /** Searches listed under each outer node or parent before the rest are
   * counted. Default 5. */
  searchesPerGroup?: number
}

/**
 * The lens as text, for an agent: the signal, every configuration best first
 * with its coverage and interval, and the forest of searches with contained
 * searches grouped under the outer node that ran them. `agent-eval search show
 * --meta` prints it.
 */
export function renderMetaSearchText(
  result: LensResult<MetaSearchData, BestPolicyConfiguration>,
  options: MetaSearchTextOptions = {},
): string {
  const perGroup = options.searchesPerGroup ?? 5
  const { data, signal } = result
  const lines: string[] = []
  const contained = data.searches.filter((item) => item.parent?.relation === 'contained').length
  const derived = data.searches.filter((item) => item.parent?.relation === 'derived').length
  lines.push(
    `meta-search: ${plural(data.searches.length, 'search', 'searches')} (${contained} contained, ${derived} derived) in ${plural(data.objectives.length, 'objective')}, ${plural(data.configurations.length, 'configuration')}`,
  )
  const value = signal.value
  lines.push(
    value.liftPerUsd === null
      ? `${signal.name}: unknown — ${value.reason}`
      : `${signal.name}: ${value.genomeDigest!.slice(0, 19)} lift per known $ ${formatNumber(value.liftPerUsd)} ${formatInterval(value.interval, value.intervalMethod)} (${value.method}, ${value.basis} n=${value.n}); ${value.reason}`,
  )
  const index = new Map(data.configurations.map((item, position) => [item.genomeDigest, position]))
  for (const objective of data.objectives) {
    lines.push('', `configurations of ${objective}, best first:`)
    for (const configuration of data.configurations) {
      if (configuration.objectiveKey !== objective) continue
      lines.push(...configurationLines(configuration, index))
    }
  }
  lines.push('', 'searches, by derivation and containment:')
  const byId = new Map(data.searches.map((item) => [item.searchId, item]))
  const walk = (searchId: string, depth: number): void => {
    const item = byId.get(searchId)!
    const pad = '  '.repeat(depth + 1)
    lines.push(`${pad}${searchLine(item, index)}`)
    const derivedChildren = item.children.filter(
      (child) => byId.get(child)!.parent?.relation === 'derived',
    )
    for (const child of derivedChildren) walk(child, depth + 1)
    const groups = new Map<string, MetaSearchEntry[]>()
    for (const child of item.children) {
      const childItem = byId.get(child)!
      if (childItem.parent?.relation !== 'contained') continue
      const key = childItem.parent.nodeId ?? '(unknown node)'
      const group = groups.get(key)
      if (group) group.push(childItem)
      else groups.set(key, [childItem])
    }
    for (const [nodeId, group] of groups) {
      const shown = group.slice(0, perGroup)
      const tally = decisionTally(group)
      lines.push(
        `${pad}  node ${nodeId}: ${plural(group.length, 'contained search', 'contained searches')} (${tally})`,
      )
      for (const child of shown) walk(child.searchId, depth + 2)
      if (group.length > shown.length) {
        lines.push(`${'  '.repeat(depth + 3)}… ${group.length - shown.length} more`)
      }
    }
  }
  for (const root of data.roots) walk(root, 0)
  return lines.join('\n')
}

function configurationLines(
  configuration: MetaSearchConfiguration,
  index: ReadonlyMap<string, number>,
): string[] {
  const { estimate, genome } = configuration
  const decisions = Object.entries(configuration.decisions)
    .filter(([, count]) => count > 0)
    .map(([decision, count]) => `${decision} ${count}`)
    .join(', ')
  const unscored = Object.entries(configuration.unscored)
    .map(([reason, count]) => `${reason} ${count}`)
    .join(', ')
  const value =
    estimate.value === null
      ? 'lift per known $: unknown'
      : `lift per known $ ${formatNumber(estimate.value)} ${formatInterval(estimate.interval, estimate.intervalMethod)} (${estimate.method}, ${estimate.basis} n=${estimate.n})`
  const lines = [
    `  #${index.get(configuration.genomeDigest)! + 1} ${configuration.genomeDigest.slice(0, 19)} ${genomeLine(genome)}`,
    `     ${plural(configuration.searches.length, 'search', 'searches')}: ${decisions}; scored ${configuration.scored}${configuration.bounded > 0 ? `, spend floor only ${configuration.bounded}` : ''}${unscored ? `, unscored: ${unscored}` : ''}; ${value}`,
  ]
  for (const outer of configuration.outerNodes) {
    const against = outer.againstParent
    const parentIndex =
      outer.parentGenomeDigest === null ? undefined : index.get(outer.parentGenomeDigest)
    lines.push(
      against === null
        ? `     outer node ${outer.nodeId} in ${outer.searchId}: the outer root`
        : `     outer node ${outer.nodeId} in ${outer.searchId}, from ${parentIndex === undefined ? outer.parentNodeId : `#${parentIndex + 1}`}: ${estimateText(against)}`,
    )
  }
  return lines
}

function searchLine(item: MetaSearchEntry, index: ReadonlyMap<string, number>): string {
  const claim = item.claim
    ? `claim ${item.claim.decision} (${item.claim.verification})`
    : 'no claim'
  const configuration = index.get(item.genomeDigest)
  const score = item.score
  const scoreText =
    score.status === 'unscored'
      ? `unscored: ${score.reason} — ${score.detail}`
      : `lift ${formatNumber(score.lift)} ${formatInterval(score.liftInterval, score.liftInterval ? 'paired-delta-test' : null)} on ${score.estimate.pairs} test units (${score.estimate.method}); ${liftPerUsdText(score.liftPerUsd)}`
  const relation =
    item.parent === null
      ? ''
      : item.parent.relation === 'derived'
        ? ` derived from ${item.parent.searchId}/${item.parent.nodeId}${item.parent.present ? '' : ' (not given)'};`
        : item.parent.present
          ? ''
          : ` contained in ${item.parent.searchId} cell ${item.parent.cellId} (not given);`
  return `${item.searchId} [${item.status}${item.closeReason ? `: ${item.closeReason}` : ''}; ${claim}; config #${configuration === undefined ? '?' : configuration + 1}; ${item.nodes} nodes, ${item.cells.settled} cells, $${round(item.score.spend.knownUsd)} known${item.score.spend.unknownCost > 0 ? ` + $${round(item.score.spend.floorUsd)} floor over ${item.score.spend.unknownCost} unknown` : ''}]${relation} ${scoreText}`
}

function genomeLine(genome: SearchPolicyGenome): string {
  const budget = Object.entries(genome.budget)
    .filter(([, value]) => value !== null && value !== 0)
    .map(([key, value]) => `${key}=${value}`)
    .join(' ')
  const proposers = Array.isArray(genome.proposers)
    ? genome.proposers.map((proposer) => `${proposer.kind}:${proposer.name}`).join(', ')
    : 'unknown'
  const execution = Array.isArray(genome.proposerExecution)
    ? genome.proposerExecution
        .map((item) =>
          item.kind === 'model'
            ? `model ${item.model.provider}/${'snapshot' in item.model ? item.model.snapshot : `${item.model.alias} (snapshot unknown)`}`
            : 'deterministic',
        )
        .join(', ')
    : 'unknown'
  return `expansion=${genome.expansion} allocation=${genome.allocation}${budget ? ` ${budget}` : ''} proposer=${proposers} (${execution})`
}

function decisionTally(group: readonly MetaSearchEntry[]): string {
  const counts = new Map<string, number>()
  for (const item of group) {
    const key =
      item.score.status === 'scored'
        ? `${item.score.decision} scored`
        : `${item.claim?.decision ?? 'no claim'} unscored`
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return [...counts.entries()]
    .sort(([left], [right]) => compareCodeUnits(left, right))
    .map(([key, count]) => `${key} ${count}`)
    .join(', ')
}

function estimateText(estimate: NodeEstimate): string {
  if (estimate.delta === null) return `unknown (${plural(estimate.pairs, 'shared unit')})`
  if (estimate.method === 'insufficient') {
    return `${formatSigned(estimate.delta)} (insufficient: ${estimate.pairs} of ${INSUFFICIENT_FROM} units)`
  }
  return `${formatSigned(estimate.delta)} ${formatInterval(estimate.interval, estimate.interval ? 'paired-delta-test' : null)} (${estimate.method}, ${estimate.pairs} ${estimate.split} units)`
}

function liftPerUsdText(value: MetaSearchLiftPerUsd): string {
  if (value.status === 'unknown') return `per $: unknown (${value.reason})`
  if (value.status === 'bound') {
    return `per $: ${value.bound} ${formatNumber(value.value)} (${value.reason})`
  }
  return `per $: ${formatNumber(value.value)}`
}

function formatInterval(interval: [number, number] | null, method: string | null): string {
  if (interval === null) return '[no interval]'
  return `[${formatNumber(interval[0])}, ${formatNumber(interval[1])}]${method ? ` ${method}` : ''}`
}

function formatNumber(value: number): string {
  if (value === 0) return '0'
  const magnitude = Math.abs(value)
  return magnitude >= 0.01 ? value.toFixed(4) : value.toPrecision(3)
}

function formatSigned(value: number): string {
  return value > 0 ? `+${formatNumber(value)}` : formatNumber(value)
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`
}

// ── helpers ──────────────────────────────────────────────────────────

/** A policy or allocator name carries `seed=<n>` when it is seeded from the
 * search's own seed; the genome names it `seed=<search>` so searches of one
 * configuration on different seeds share a genome. */
function withoutSearchSeed(name: string, seed: number): string {
  return name.replace(new RegExp(`\\bseed=${seed}(?![\\d.])`, 'g'), 'seed=<search>')
}

function orient(delta: number, maximize: boolean): number {
  return maximize ? delta : delta === 0 ? 0 : -delta
}

function orientInterval(interval: [number, number], maximize: boolean): [number, number] {
  return maximize ? interval : [orient(interval[1], false), orient(interval[0], false)]
}

function sortedValues<T>(map: ReadonlyMap<string, T>): T[] {
  return [...map.entries()]
    .sort(([left], [right]) => compareCodeUnits(left, right))
    .map(([, value]) => value)
}

function rankValue(value: number | null): number {
  return value === null ? Number.NEGATIVE_INFINITY : value
}

function round(usd: number): number {
  return Math.round(usd * 1e6) / 1e6
}
