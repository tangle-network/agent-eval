import type { NodeEstimate } from '../../campaign/search-ledger-types'
import { compareCodeUnits } from '../../ledger-core/canonical'
import { roundDecimal as round } from '../../math/round-decimal'
import { configurationKey } from './meta-search-configuration'
import type {
  BestPolicyConfiguration,
  MetaSearchConfiguration,
  MetaSearchData,
  MetaSearchEntry,
  MetaSearchLiftPerUsd,
  SearchPolicyGenome,
} from './meta-search-contract'
import { INSUFFICIENT_FROM, type LensResult } from './shared'

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
  // One genome can run under several objectives, so a configuration is keyed
  // by both.
  const index = new Map(
    data.configurations.map((item, position) => [
      configurationKey(item.objectiveKey, item.genomeDigest),
      position,
    ]),
  )
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
    `  #${index.get(configurationKey(configuration.objectiveKey, configuration.genomeDigest))! + 1} ${configuration.genomeDigest.slice(0, 19)} ${genomeLine(genome)}`,
    `     ${plural(configuration.searches.length, 'search', 'searches')}: ${decisions}; scored ${configuration.scored}${configuration.bounded > 0 ? `, spend floor only ${configuration.bounded}` : ''}${unscored ? `, unscored: ${unscored}` : ''}; ${value}`,
  ]
  for (const outer of configuration.outerNodes) {
    const against = outer.againstParent
    const parentIndex =
      outer.parentGenomeDigest === null
        ? undefined
        : index.get(configurationKey(configuration.objectiveKey, outer.parentGenomeDigest))
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
  const configuration = index.get(configurationKey(item.objectiveKey, item.genomeDigest))
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
  return `${item.searchId} [${item.status}${item.closeReason ? `: ${item.closeReason}` : ''}; ${claim}; config #${configuration === undefined ? '?' : configuration + 1}; ${item.nodes} nodes, ${item.cells.settled} cells, $${round(item.score.spend.knownUsd, 6)} known${item.score.spend.unknownCost > 0 ? ` + $${round(item.score.spend.floorUsd, 6)} floor over ${item.score.spend.unknownCost} unknown` : ''}]${relation} ${scoreText}`
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
