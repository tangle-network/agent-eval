import { estimateNode, seedFromDigest } from '../../campaign/estimate-node'
import type { SearchLedgerHash } from '../../campaign/search-ledger-types'
import type { SearchStateView } from '../../campaign/search-state'
import { compareCodeUnits } from '../../ledger-core/canonical'
import type {
  BestPolicyConfiguration,
  MetaSearchConfiguration,
  MetaSearchConfigurationEstimate,
  MetaSearchEntry,
} from './meta-search-contract'
import { rankingSplit, type SampleSummary, summarizeSamples } from './shared'

export function configure(
  entries: readonly MetaSearchEntry[],
  byId: ReadonlyMap<string, SearchStateView>,
): MetaSearchConfiguration[] {
  const groups = new Map<string, MetaSearchEntry[]>()
  for (const item of entries) {
    const key = configurationKey(item.objectiveKey, item.genomeDigest)
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

export function best(
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

export function configurationKey(objective: string, genomeDigest: string): string {
  return `${objective}\u0000${genomeDigest}`
}

function rankValue(value: number | null): number {
  return value === null ? Number.NEGATIVE_INFINITY : value
}
