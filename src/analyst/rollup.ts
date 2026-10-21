/**
 * rollup — run findings aggregated up the ladder, with bootstrap intervals and
 * denominators, lifted only where `promote` allows.
 *
 * Run-layer findings that share a `claim_id` and a measure are pooled per play
 * into one play-layer finding. Its interval is a cluster bootstrap where each
 * cluster is a lineage root, so runs that built on each other move together
 * and four runs of one lineage yield one cluster and no interval. Those play
 * findings then go through `promote`; each finding it lifts to a problem,
 * domain node or the lab gets the pooled bootstrap over every run underneath
 * it, with its observation and cluster counts.
 */

import { clusterBootstrapMean } from '../meta-eval/cluster-bootstrap'
import {
  type DomainTaxonomy,
  domainPathOf,
  lowestCommonAncestor,
  taxonomyLayerOf,
  taxonomyParentOf,
} from './domain-taxonomy'
import {
  lineageRoots,
  mergeEvidenceUnits,
  mostSevere,
  spanningWindow,
  UNKNOWN_LINEAGE,
} from './finding-scope'
import { type PromotionHold, promote } from './promote'
import { type AnalystFinding, makeFinding } from './types'

const ROLLUP_ANALYST_ID = 'rollup'
const ROLLUP_VERSION = '1'

export interface RollupOptions {
  /** Independent agreeing children `promote` requires. Default 2. */
  k?: number
  /** Bootstrap seed; absent, the seed derives from the values, so reruns match. */
  seed?: number
  resamples?: number
  /** Interval confidence. Default 0.95. */
  confidence?: number
  produced_at?: string
}

export interface RollupResult {
  /** Play aggregates followed by every finding promote lifted from them. */
  findings: AnalystFinding[]
  untestedAbove: PromotionHold[]
  /** Input findings rollup could not use, and why. */
  skipped: PromotionHold[]
}

interface Observation {
  finding: AnalystFinding
  claimId: string
  run: string
  value: number
  cluster: string
}

export function rollupFindings(
  findings: readonly AnalystFinding[],
  taxonomy: DomainTaxonomy,
  options: RollupOptions = {},
): RollupResult {
  const confidence = options.confidence ?? 0.95
  const skipped: PromotionHold[] = []
  const skip = (finding: AnalystFinding, reason: string): void => {
    skipped.push({
      finding_id: finding.finding_id,
      claim_id: finding.claim_id ?? null,
      node: null,
      reason,
    })
  }
  const roots = lineageRoots(findings.flatMap((finding) => finding.evidence_units ?? []))
  const observations: Observation[] = []
  for (const finding of findings) {
    if (finding.layer !== 'run' || !finding.scope) continue
    if (!finding.claim_id) {
      skip(finding, 'no claim_id')
      continue
    }
    if (!finding.measure) {
      skip(finding, 'no measure to aggregate')
      continue
    }
    const run = lowestCommonAncestor(taxonomy, finding.scope.population)
    if (run === undefined || taxonomyLayerOf(taxonomy, run) !== 'run') {
      skip(finding, 'population is not one run in the taxonomy')
      continue
    }
    const units = finding.evidence_units
    const runRoots = new Set(
      units ? units.map((unit) => roots.get(unit.id) ?? UNKNOWN_LINEAGE) : [UNKNOWN_LINEAGE],
    )
    observations.push({
      finding,
      claimId: finding.claim_id,
      run,
      value: finding.measure.value,
      // A run whose units reach several roots is clustered on the first; one
      // run is one observation either way.
      cluster: [...runRoots].sort()[0]!,
    })
  }

  const groups = new Map<string, { play: string; members: Observation[] }>()
  for (const observation of observations) {
    const play = taxonomyParentOf(taxonomy, observation.run)!
    const key = JSON.stringify([observation.claimId, play])
    const group = groups.get(key) ?? { play, members: [] }
    group.members.push(observation)
    groups.set(key, group)
  }
  const aggregates: AnalystFinding[] = []
  for (const { play, members } of groups.values()) {
    const measure = members[0]!.finding.measure!
    if (
      members.some(
        ({ finding }) =>
          finding.measure!.name !== measure.name || finding.measure!.unit !== measure.unit,
      )
    ) {
      for (const member of members)
        skip(member.finding, `runs of play '${play}' measure different quantities`)
      continue
    }
    const pooled = pool(members, options, confidence)
    const findingsInGroup = members.map((member) => member.finding)
    const population = [...new Set(members.map((member) => member.run))].sort()
    const units = findingsInGroup.every((finding) => finding.evidence_units !== undefined)
      ? mergeEvidenceUnits(findingsInGroup.flatMap((finding) => finding.evidence_units!))
      : undefined
    const domainPath = domainPathOf(taxonomy, play)
    const first = findingsInGroup[0]!
    aggregates.push(
      makeFinding({
        analyst_id: ROLLUP_ANALYST_ID,
        area: first.area,
        claim: first.claim,
        claim_id: first.claim_id!,
        id_basis: `${first.claim_id}@${play}`,
        subject: play,
        severity: mostSevere(findingsInGroup),
        confidence: Math.min(...findingsInGroup.map((finding) => finding.confidence)),
        evidence_refs: findingsInGroup.map((finding) => ({
          kind: 'finding' as const,
          uri: `finding://${finding.finding_id}`,
        })),
        layer: 'play',
        scope: {
          population,
          n: population.length,
          window: spanningWindow(findingsInGroup),
          ...(domainPath.length > 0 ? { domain_path: domainPath } : {}),
        },
        method: { kind: 'computed', name: ROLLUP_ANALYST_ID, version: ROLLUP_VERSION },
        measure: { name: measure.name, unit: measure.unit, ...pooled.measure },
        ...(units ? { evidence_units: units } : {}),
        metadata: { denominators: pooled.denominators },
        ...(options.produced_at === undefined ? {} : { produced_at: options.produced_at }),
      }),
    )
  }

  const promotion = promote(aggregates, taxonomy, {
    ...(options.k === undefined ? {} : { k: options.k }),
    ...(options.produced_at === undefined ? {} : { produced_at: options.produced_at }),
  })
  const promoted = promotion.promoted.map((finding) => {
    const covered = new Set(finding.scope!.population)
    const members = observations.filter(
      (observation) => observation.claimId === finding.claim_id && covered.has(observation.run),
    )
    const pooled = pool(members, options, confidence)
    return {
      ...finding,
      measure: { name: finding.measure!.name, unit: finding.measure!.unit, ...pooled.measure },
      metadata: { ...finding.metadata, denominators: pooled.denominators },
    }
  })
  return {
    findings: [...aggregates, ...promoted],
    untestedAbove: promotion.untestedAbove,
    skipped: [...skipped, ...promotion.unplaced],
  }
}

/**
 * Cluster bootstrap of the run values. With one cluster there is no spread
 * between independent sources, so the measure carries no interval and cannot
 * vote in `promote`.
 */
function pool(members: readonly Observation[], options: RollupOptions, confidence: number) {
  const result = clusterBootstrapMean(
    members.map((member) => ({ cluster: member.cluster, value: member.value })),
    {
      confidence,
      ...(options.seed === undefined ? {} : { seed: options.seed }),
      ...(options.resamples === undefined ? {} : { resamples: options.resamples }),
    },
  )
  return {
    measure:
      result.clusters >= 2
        ? {
            value: result.mean,
            interval: [result.low, result.high] as [number, number],
            level: confidence,
          }
        : { value: result.mean },
    denominators: { observations: result.n, independent_clusters: result.clusters },
  }
}

export interface RollupInput {
  findings: readonly AnalystFinding[]
  taxonomy: DomainTaxonomy
  options?: RollupOptions
}


