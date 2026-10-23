import {
  assertConsistentFindingConditions,
  findingCompositionKey,
  mergeFindingComposition,
} from './finding-composition'
/**
 * Promotion — the only way a claim moves above the layer it was measured at.
 *
 * A claim is restated at a parent node only when at least `k` independent
 * children carry the same `claim_id` with intervals that agree. Otherwise it
 * stays where it is, reported as untested above. The rule is the same on every
 * rung of the ladder: run → play → problem → each domain node up the path →
 * lab.
 *
 * The rule, exactly:
 *   - A finding sits at the node that is the lowest common ancestor of its
 *     `scope.population` in the taxonomy, and that node's layer must equal the
 *     finding's `layer`. Four runs of one play place a claim at that play; the
 *     same claim stored at `domain` or `lab` is refused as exceeding its
 *     evidence.
 *   - Only children with `measure.interval` vote. Voters must name the same
 *     measure and unit, and their intervals must share a common point.
 *   - Children are counted by lineage, not by node: two children whose evidence
 *     units share a lineage root (run 2 built on run 1's code) count once, and
 *     a child with no recorded lineage shares one root with every other such
 *     child.
 *   - Promoted findings cite every voting child by `finding://<finding_id>`.
 *
 * Event, turn, agent, team and meta findings sit outside the ladder and never
 * promote.
 */

import {
  type DomainTaxonomy,
  domainPathOf,
  LAB_NODE_ID,
  lowestCommonAncestor,
  taxonomyAncestry,
  taxonomyLayerOf,
  taxonomyParentOf,
} from './domain-taxonomy'
import {
  type FindingLayer,
  type FindingMeasure,
  lineageRoots,
  mergeEvidenceUnits,
  mostSevere,
  spanningWindow,
  UNKNOWN_LINEAGE,
} from './finding-scope'
import { type AnalystFinding, makeFinding } from './types'

/** Bump when the promotion rule changes, so promoted findings name the rule that lifted them. */
const PROMOTE_VERSION = '1'

/** The analyst id a promoted finding carries when its children came from different analysts. */
const PROMOTE_ANALYST_ID = 'promote'

export interface PromoteOptions {
  /** Independent agreeing children required to lift a claim. Default 2, minimum 2. */
  k?: number
  /** Timestamp stamped on promoted findings; defaults to now. */
  produced_at?: string
}

/** A finding promote did not lift, with the reason in words. */
export interface PromotionHold {
  finding_id: string
  claim_id: string | null
  /** The node the finding sits at, or null when it could not be placed. */
  node: string | null
  reason: string
}

export interface PromotionResult {
  /** The input findings followed by every promoted finding. */
  findings: AnalystFinding[]
  promoted: AnalystFinding[]
  /** Placed findings whose claim was not lifted; they stay true at their own node. */
  untestedAbove: PromotionHold[]
  /** Findings promote cannot place on the ladder, and why. */
  unplaced: PromotionHold[]
}

interface Placement {
  finding: AnalystFinding
  claimId: string
  node: string
}

const LADDER: readonly FindingLayer[] = ['run', 'play', 'problem', 'domain', 'lab']

export function promote(
  findings: readonly AnalystFinding[],
  taxonomy: DomainTaxonomy,
  options: PromoteOptions = {},
): PromotionResult {
  assertConsistentFindingConditions(findings)
  const k = options.k ?? 2
  if (!Number.isInteger(k) || k < 2) {
    throw new RangeError(`promote: k must be an integer of at least 2, got ${k}`)
  }
  const unplaced: PromotionHold[] = []
  const buckets = new Map<number, Placement[]>()
  const addPlacement = (placement: Placement): void => {
    const depth = taxonomyAncestry(taxonomy, placement.node).length
    const bucket = buckets.get(depth) ?? []
    bucket.push(placement)
    buckets.set(depth, bucket)
  }
  for (const finding of findings) {
    const placed = place(finding, taxonomy)
    if ('reason' in placed) unplaced.push(placed)
    else addPlacement(placed)
  }

  const roots = lineageRoots(
    mergeEvidenceUnits(findings.flatMap((finding) => finding.evidence_units ?? [])),
  )
  const promoted: AnalystFinding[] = []
  const untestedAbove: PromotionHold[] = []
  const hold = (placement: Placement, reason: string): void => {
    untestedAbove.push({
      finding_id: placement.finding.finding_id,
      claim_id: placement.claimId,
      node: placement.node,
      reason,
    })
  }

  // Deepest nodes first: a parent's bucket is complete, native findings and
  // lifted ones alike, before it is itself grouped for the next rung.
  for (let depth = Math.max(0, ...buckets.keys()); depth > 1; depth -= 1) {
    const groups = new Map<string, { parent: string; members: Placement[] }>()
    for (const placement of buckets.get(depth) ?? []) {
      const parent = taxonomyParentOf(taxonomy, placement.node)
      if (parent === null || parent === undefined) continue
      const key = JSON.stringify([
        placement.claimId,
        parent,
        findingCompositionKey(placement.finding),
      ])
      const group = groups.get(key) ?? { parent, members: [] }
      group.members.push(placement)
      groups.set(key, group)
    }
    for (const { parent, members } of groups.values()) {
      const verdict = judgeGroup(members, k, roots)
      if (!verdict.lift) {
        for (const member of members) hold(member, verdict.reason)
        continue
      }
      const lifted = liftedFinding(verdict.voters, parent, taxonomy, options.produced_at)
      promoted.push(lifted)
      addPlacement({ finding: lifted, claimId: members[0]!.claimId, node: parent })
      for (const member of members) {
        if (!verdict.voters.includes(member)) {
          hold(member, 'no interval, so it could not vote; the claim was lifted by its siblings')
        }
      }
    }
  }
  return { findings: [...findings, ...promoted], promoted, untestedAbove, unplaced }
}

function place(finding: AnalystFinding, taxonomy: DomainTaxonomy): Placement | PromotionHold {
  const unplaced = (reason: string, node: string | null = null): PromotionHold => ({
    finding_id: finding.finding_id,
    claim_id: finding.claim_id ?? null,
    node,
    reason,
  })
  if (finding.schema_version !== '1.1.0' || !finding.layer || !finding.scope) {
    return unplaced('no layer or scope (schema 1.0.0)')
  }
  if (finding.layer === 'meta')
    return unplaced('meta findings describe the instrument and never promote')
  if (!LADDER.includes(finding.layer)) {
    return unplaced(`${finding.layer} findings sit below the run → lab ladder`)
  }
  if (!finding.claim_id) return unplaced('no claim_id to match siblings by')
  const population = finding.scope.population
  if (population.length === 0) return unplaced('population names no units')
  const node = lowestCommonAncestor(taxonomy, population)
  if (node === undefined) return unplaced('population names ids outside the taxonomy')
  const nodeLayer = taxonomyLayerOf(taxonomy, node)
  if (nodeLayer !== finding.layer) {
    return unplaced(
      LADDER.indexOf(finding.layer) > LADDER.indexOf(nodeLayer as FindingLayer)
        ? `stated at ${finding.layer} but its population sits within ${nodeLayer} '${node}'`
        : `stated at ${finding.layer} but its population spans ${nodeLayer} '${node}'`,
      node,
    )
  }
  const path = finding.scope.domain_path
  if (path) {
    const expected = domainPathOf(taxonomy, node)
    if (path.length !== expected.length || path.some((id, index) => id !== expected[index])) {
      return unplaced(`domain_path ${JSON.stringify(path)} disagrees with the taxonomy`, node)
    }
  }
  return { finding, claimId: finding.claim_id, node }
}

type GroupVerdict = { lift: true; voters: Placement[] } | { lift: false; reason: string }

function judgeGroup(
  members: readonly Placement[],
  k: number,
  roots: ReadonlyMap<string, string>,
): GroupVerdict {
  const voters = members.filter((member) => member.finding.measure?.interval !== undefined)
  if (voters.length === 0) return { lift: false, reason: 'no child carries an interval' }
  const first = voters[0]!.finding.measure!
  if (
    voters.some(
      ({ finding }) => finding.measure!.name !== first.name || finding.measure!.unit !== first.unit,
    )
  ) {
    return { lift: false, reason: 'children measure different quantities' }
  }
  const lo = Math.max(...voters.map(({ finding }) => finding.measure!.interval![0]))
  const hi = Math.min(...voters.map(({ finding }) => finding.measure!.interval![1]))
  if (lo > hi) return { lift: false, reason: 'child intervals do not agree' }

  const independent = independentChildren(voters, roots)
  if (independent < k) {
    const children = new Set(voters.map((voter) => voter.node)).size
    return {
      lift: false,
      reason:
        children > independent
          ? `${children} children agree but share lineage, leaving ${independent} independent of ${k} required`
          : `${independent} independent agreeing child${independent === 1 ? '' : 'ren'} of ${k} required`,
    }
  }
  return { lift: true, voters }
}

/**
 * Children joined when they share a lineage root, counted as components. A
 * child's roots are those of all its voters' evidence units; a voter with no
 * units has unknown lineage.
 */
function independentChildren(
  voters: readonly Placement[],
  roots: ReadonlyMap<string, string>,
): number {
  const rootsByNode = new Map<string, Set<string>>()
  for (const voter of voters) {
    const set = rootsByNode.get(voter.node) ?? new Set<string>()
    const units = voter.finding.evidence_units
    if (!units) set.add(UNKNOWN_LINEAGE)
    else for (const unit of units) set.add(roots.get(unit.id) ?? UNKNOWN_LINEAGE)
    rootsByNode.set(voter.node, set)
  }
  const parent = new Map<string, string>()
  const find = (id: string): string => {
    let current = id
    while (parent.get(current) !== current) current = parent.get(current)!
    return current
  }
  const owner = new Map<string, string>()
  for (const [node, nodeRoots] of rootsByNode) {
    parent.set(node, node)
    for (const root of nodeRoots) {
      const other = owner.get(root)
      if (other === undefined) owner.set(root, node)
      else parent.set(find(node), find(other))
    }
  }
  return new Set([...rootsByNode.keys()].map(find)).size
}

function liftedFinding(
  voters: readonly Placement[],
  parent: string,
  taxonomy: DomainTaxonomy,
  producedAt: string | undefined,
): AnalystFinding {
  const findings = voters.map((voter) => voter.finding)
  const first = findings[0]!
  const measures = findings.map((finding) => finding.measure!) as FindingMeasure[]
  const levels = new Set(measures.map((measure) => measure.level))
  const level = levels.size === 1 ? measures[0]!.level : undefined
  const population = [...new Set(findings.flatMap((finding) => finding.scope!.population))].sort()
  const allUnits = findings.every((finding) => finding.evidence_units !== undefined)
    ? mergeEvidenceUnits(findings.flatMap((finding) => finding.evidence_units!))
    : undefined
  const confounders = [...new Set(findings.flatMap((finding) => finding.confounders ?? []))].sort()
  const analysts = new Set(findings.map((finding) => finding.analyst_id))
  const domainPath = domainPathOf(taxonomy, parent)
  const parentLayer = taxonomyLayerOf(taxonomy, parent) as FindingLayer
  return makeFinding({
    analyst_id: analysts.size === 1 ? first.analyst_id : PROMOTE_ANALYST_ID,
    area: first.area,
    claim: first.claim,
    claim_id: first.claim_id!,
    id_basis: `${first.claim_id}@${parent}`,
    ...mergeFindingComposition(findings),
    subject: parent,
    severity: mostSevere(findings),
    confidence: Math.min(...findings.map((finding) => finding.confidence)),
    evidence_refs: findings.map((finding) => ({
      kind: 'finding' as const,
      uri: `finding://${finding.finding_id}`,
    })),
    layer: parentLayer,
    scope: {
      population,
      n: population.length,
      window: spanningWindow(findings),
      ...(domainPath.length > 0 && parent !== LAB_NODE_ID ? { domain_path: domainPath } : {}),
    },
    method: { kind: 'computed', name: 'promote', version: PROMOTE_VERSION },
    measure: {
      name: measures[0]!.name,
      unit: measures[0]!.unit,
      value: measures.reduce((sum, measure) => sum + measure.value, 0) / measures.length,
      interval: [
        Math.max(...measures.map((measure) => measure.interval![0])),
        Math.min(...measures.map((measure) => measure.interval![1])),
      ],
      ...(level === undefined ? {} : { level }),
    },
    ...(confounders.length > 0 ? { confounders } : {}),
    ...(allUnits ? { evidence_units: allUnits } : {}),
    rationale: `Lifted to ${parentLayer} '${parent}': ${new Set(voters.map((voter) => voter.node)).size} children carry claim '${first.claim_id}' with intervals that share [${Math.max(...measures.map((m) => m.interval![0]))}, ${Math.min(...measures.map((m) => m.interval![1]))}].`,
    metadata: {
      taxonomy_version: taxonomy.version,
      promoted_from: [...new Set(voters.map((voter) => voter.node))].sort(),
    },
    ...(producedAt === undefined ? {} : { produced_at: producedAt }),
  })
}
