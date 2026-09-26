/**
 * `editCredit`: the edits of a search as genes, followed down its lineage.
 *
 * Every lineage edge is a parent-to-child change of an artifact. The lens
 * diffs the two artifacts line by line (whitespace-normalized) and cuts each
 * changed run into paragraphs: an added paragraph is an `insert` gene, a
 * removed paragraph a `delete` gene. A gene's id hashes its kind, its location
 * in the artifact and its normalized lines, so the same edit has the same id
 * wherever and whenever a proposer makes it. A node carries an insert gene
 * when the paragraph is present at that location, and a delete gene when it is
 * absent. Carrying is read from each node's content, so it follows merges,
 * re-proposals and reverts without any bookkeeping in the record.
 *
 * A step is one lineage parent and its child. A gene flips on a step when the
 * parent and the child disagree on carrying it. The gene's credit pairs, per
 * step, the side that carries it against the side that lacks it on the units
 * both scored, and averages those contrasts across its steps inside each unit.
 * Only clean steps count: steps on which nothing flips except edits introduced
 * together with the gene. A merge that also brings in the other parent's edits
 * is therefore not evidence for any one of them, and genes that always move
 * together are reported as linked, because their credits are one number.
 *
 * Interactions compare a gene's step contrasts where another gene is present
 * against where it is absent, in both directions, and are flagged after a Holm
 * correction for a factorial test rather than claimed.
 *
 * The lens reads node artifacts through `readArtifact`, which the caller backs
 * with verified blob bytes. An artifact the caller cannot read, and a code
 * surface whose patch bytes are not in the ledger, leave the node's content
 * unknown: its steps yield no genes and no contrasts.
 */

import { type AgentProfileResourceRef, defineInlineResource } from '@tangle-network/agent-interface'
import { seedFromDigest } from '../../campaign/estimate-node'
import type {
  NodeEstimate,
  SearchArtifactRef,
  SearchEdgeOperator,
  SearchEdgeRecordedEvent,
  SearchEstimateMethod,
  SearchSourceRef,
  SearchSplit,
} from '../../campaign/search-ledger-types'
import type { SearchNode, SearchStateView } from '../../campaign/search-state'
import { canonicalString, compareCodeUnits, hashCanonical } from '../../ledger-core/canonical'
import { minimumPairsForPairedDeltaTest, pairedDeltaTest } from '../../paired-delta-test'
import {
  BOOTSTRAP_GATE_MIN_N,
  DECISION_PAIRED_DELTA_STATISTIC,
  holm,
  pairedSignTest,
} from '../../statistics'
import type { SearchLensResult } from './types'

const CONFIDENCE = 0.95
const RESAMPLES = 2000
const DESCRIPTIVE_FROM = minimumPairsForPairedDeltaTest(CONFIDENCE)
const INTERACTION_ALPHA = 0.05
const DEFAULT_INTERACTION_GENES = 24
/** Signal name a policy reads. */
export const EDIT_CREDIT_SIGNAL = 'reusableHunks'

/**
 * Every choice a credit depends on. Its digest is the estimator revision each
 * credit names, so two readers that report the same revision and the same
 * `cellSetDigest` report the same numbers.
 */
const CREDIT_DEFINITION = {
  name: 'tangle.edit-credit.2026-09',
  gene: 'a paragraph of whitespace-normalized lines added (insert) or removed (delete) at one artifact location',
  step: 'one lineage parent and its child, both with known content and neither invalid',
  clean:
    'the gene flips on the step and every gene that flips was introduced on one edge that introduced it',
  unit: 'mean of a node’s scored cells in the unit; per unit, carrier-side and lacking-side means averaged over the clean steps where both sides scored it',
  statistic: DECISION_PAIRED_DELTA_STATISTIC,
  interval: 'percentile paired bootstrap',
  confidence: CONFIDENCE,
  resamples: RESAMPLES,
  rng: 'mulberry32',
  seed: 'the first 32 bits of cellSetDigest',
  signTest: 'exact, one-sided toward improvement in the objective direction',
  methods: {
    none: 'below 2 units',
    insufficient: `below ${DESCRIPTIVE_FROM} units`,
    descriptive: `below ${BOOTSTRAP_GATE_MIN_N} units`,
    bootstrap: `from ${BOOTSTRAP_GATE_MIN_N} units`,
  },
} as const

/** The estimator every gene credit names. */
export const EDIT_CREDIT_ESTIMATOR: SearchSourceRef = {
  uri: 'npm:@tangle-network/agent-eval/search#editCredit',
  revision: hashCanonical(CREDIT_DEFINITION),
}

export interface EditCreditOptions {
  /**
   * The parsed content a node's artifact reference names, or undefined when
   * it is unavailable. The caller must verify the bytes against `ref.sha256`;
   * the lens trusts what it is handed.
   */
  readArtifact(ref: SearchArtifactRef): unknown | undefined
  /** Split credit is measured on. Default: selection when the search declares
   * one, else train. */
  split?: SearchSplit
  /** Genes tested for pairwise interaction: those with the most measured
   * units, one per linkage group. Default 24, so at most 276 pairs. */
  interactionGenes?: number
}

export type EditGeneVerdict = 'reusable' | 'harmful' | 'unresolved' | 'insufficient'

export interface EditIntroduction {
  nodeId: string
  edgeId: string
  operator: SearchEdgeOperator
  parents: string[]
  /** The edge is a re-proposal into a node registered earlier. */
  reproposal: boolean
}

export interface EditGene {
  geneId: string
  kind: 'insert' | 'delete'
  /** Where in the artifact: `prompt`, `component:<name>`, or a JSON path such
   * as `/prompt/systemPrompt`. */
  path: string
  /** Normalized lines: the gene's identity. */
  lines: string[]
  /** The lines as the first proposer wrote them. */
  text: string
  /** Lineage edges whose child carries the gene while none of its parents
   * did, in ledger order. More than one means a proposer made the same edit
   * again. */
  introduced: EditIntroduction[]
  /** Lineage edges whose child lost the gene that a parent carried. */
  dropped: number
  /** Genes introduced on the edge that first introduced this one: the edit
   * it was born in, itself included, in artifact order. */
  edit: string[]
  /** Nodes with known content that carry it and are not invalid. */
  carriers: number
  /** `invalid` carriers (judge integrity or admission failures), excluded from
   * every contrast; an edit that makes nodes invalid shows here. */
  invalidCarriers: number
  steps: {
    /** Steps on which the gene flips. */
    flips: number
    /** Of those, the steps its credit reads. */
    clean: number
    /** Clean steps on which the child gained the gene. */
    gained: number
    /** Clean steps on which the child lost it. */
    lost: number
  }
  /** Carrying side against lacking side on clean steps; `delta` is carrier
   * minus non-carrier in the metric's units. */
  credit: NodeEstimate
  verdict: EditGeneVerdict
  /** The first gene of this gene's linkage group: genes with the same clean
   * steps, oriented the same way, have one credit and cannot be separated.
   * Null when the gene has no partner. */
  linkage: string | null
}

export interface EditInteraction {
  genes: [string, string]
  /** Clean steps of each gene, split by whether both ends carry the other. */
  steps: {
    firstWithSecond: number
    firstWithoutSecond: number
    secondWithFirst: number
    secondWithoutFirst: number
  }
  /** Units with a contrast in at least one direction. */
  units: number
  method: SearchEstimateMethod
  /** Mean per-unit difference of a gene's credit with the other present minus
   * with it absent, both directions averaged, in the metric's units; null
   * below 2 units. */
  interaction: number | null
  /** Percentile bootstrap spread from 6 units; null below 6 or when every
   * per-unit contrast is equal. */
  interval: [number, number] | null
  indeterminate: boolean
  /** Exact two-sided sign test; null below 6 units. */
  signP: number | null
  /** Holm-adjusted over every pair tested; null when this pair was not tested. */
  adjustedP: number | null
  interacting: boolean
  /** The pair does better together than their separate credits add up to, in
   * the objective's direction. Null without an interaction estimate. */
  synergy: boolean | null
}

export interface EditSkillCandidate {
  /** An inline skill resource: add it to `profile.resources.skills` (with
   * `resources.failOnError: true`) and pass `improveOptions` to agent-runtime
   * `improve()` with `method: officialSkillOpt(...)` to optimize it. */
  resource: Extract<AgentProfileResourceRef, { kind: 'inline' }>
  improveOptions: { surface: 'skills'; skills: { resourceName: string } }
  /** The linked insert genes the skill holds, in artifact order. */
  genes: string[]
  path: string
  credit: NodeEstimate
}

export interface EditLineageRow {
  nodeId: string
  ordinal: number
  depth: number | null
  primaryParentId: string | null
  parents: string[]
  operator: SearchEdgeOperator | null
  status: SearchNode['status']
  /** Every gene this node carries. */
  carries: string[]
  contentKnown: boolean
}

export interface EditCreditData {
  split: SearchSplit
  direction: 'maximize' | 'minimize'
  edges: {
    /** Edges with at least one parent registered before the child in this search. */
    lineage: number
    /** Of those, edges whose child and every lineage parent had known content. */
    read: number
    /** Why an edge's content was unknown, with counts. */
    unknown: Record<string, number>
  }
  /** Distinct parent-child pairs with known content; those with an invalid
   * end are excluded from every contrast. */
  steps: { total: number; invalidEnd: number }
  nodes: { total: number; contentUnknown: number; invalid: number }
  /** Reusable, harmful, unresolved, then insufficient; within each, by credit. */
  genes: EditGene[]
  counts: Record<EditGeneVerdict, number>
  /** Linkage groups per verdict: independent edits, not hunks. */
  editCounts: Record<EditGeneVerdict, number>
  interactions: {
    genesConsidered: number
    /** Pairs with a with-and-without split in at least one direction. */
    pairsWithContexts: number
    /** Pairs with 6 or more units and a non-degenerate contrast. */
    pairsTested: number
    alpha: number
    correction: 'holm'
    /** Flagged pairs first, then by adjusted p. */
    pairs: EditInteraction[]
  }
  skillCandidates: EditSkillCandidate[]
  /** Rows in lineage order (depth-first along primary parents): the matrix a
   * genealogy view draws, genes as columns. */
  lineage: EditLineageRow[]
  method: {
    estimator: SearchSourceRef
    credit: string
    verdict: string
    interaction: string
    multiplicity: string
  }
}

export type EditCreditResult = SearchLensResult<EditCreditData>

interface PathText {
  raw: string[]
  norm: string[]
}

type KnownContent = { known: true; paths: Map<string, PathText>; haystacks: Map<string, string> }
type NodeContent = KnownContent | { known: false; reason: string }

interface GeneCut {
  kind: 'insert' | 'delete'
  path: string
  lines: string[]
  needle: string
  text: string
  /** Position in the child's diff: artifact order. */
  position: number
}

interface GeneRecord extends GeneCut {
  geneId: string
  locus: string
  introduced: EditIntroduction[]
  dropped: number
  /** Ledger order of the first introduction, then position in the artifact. */
  order: [number, number]
}

interface Step {
  key: string
  parentId: string
  childId: string
  /** Genes whose carrying differs between parent and child. */
  flips: Set<string>
}

/**
 * The edit-credit lens. Pure: the result depends only on `state` and what
 * `readArtifact` returns for its references.
 */
export function editCredit(state: SearchStateView, options: EditCreditOptions): EditCreditResult {
  const header = state.header
  if (!header) throw new Error(`editCredit: search ${state.searchId} has not been opened`)
  const split = options.split ?? (header.splits.selection.tasks.length > 0 ? 'selection' : 'train')
  const direction = header.objective.direction
  const sign = direction === 'maximize' ? 1 : -1
  const interactionGenes = options.interactionGenes ?? DEFAULT_INTERACTION_GENES
  if (!Number.isSafeInteger(interactionGenes) || interactionGenes < 0) {
    throw new Error(`editCredit: interactionGenes must be a non-negative integer`)
  }

  const nodes = state.nodes()
  const byId = new Map(nodes.map((node) => [node.nodeId, node]))
  const contents = new Map<string, NodeContent>()
  for (const node of nodes) contents.set(node.nodeId, nodeContent(options, node.artifact))
  const known = (nodeId: string) => contents.get(nodeId) as KnownContent
  const invalid = new Set(nodes.filter((node) => node.status === 'invalid').map((n) => n.nodeId))

  // Genes: every lineage edge, in ledger order. A gene is one locus (a
  // location and its lines); an edge that re-adds a paragraph a delete gene
  // removed drops that gene rather than creating a second one.
  const genes = new Map<string, GeneRecord>()
  const byLocus = new Map<string, GeneRecord>()
  const introducedOn = new Map<string, string[]>()
  const unknownEdges: Record<string, number> = {}
  const stepList: Step[] = []
  const stepKeys = new Set<string>()
  let lineageEdges = 0
  let readEdges = 0
  let edgeOrdinal = 0
  for (const edge of state.edges()) {
    edgeOrdinal += 1
    const child = byId.get(edge.childNodeId)!
    const parents = lineageParents(state, edge, child, byId)
    if (parents.length === 0) continue
    lineageEdges += 1
    const missing = [child.nodeId, ...parents]
      .map((nodeId) => contents.get(nodeId)!)
      .find((content) => !content.known)
    if (missing && !missing.known) {
      unknownEdges[missing.reason] = (unknownEdges[missing.reason] ?? 0) + 1
      continue
    }
    readEdges += 1
    const childContent = known(child.nodeId)
    const reproposal = child.edgeIds[0] !== edge.edgeId
    // A parent registered after the child (a re-proposal from a later node) or
    // in another search is not in the lineage, so whether it carried a gene is
    // not known here: the edge's steps still count, its introductions do not.
    const wholeLineage = edge.parents.every(
      (parent) => parent.searchId === state.searchId && parents.includes(parent.nodeId),
    )
    const cuts = new Map<string, GeneCut>()
    for (const parentId of parents) {
      const key = `${parentId}>${child.nodeId}`
      if (!stepKeys.has(key)) {
        stepKeys.add(key)
        stepList.push({ key, parentId, childId: child.nodeId, flips: new Set() })
      }
      for (const cut of edgeCuts(known(parentId), childContent)) {
        const locus = locusOf(cut)
        if (!cuts.has(locus)) cuts.set(locus, cut)
      }
    }
    if (!wholeLineage) continue
    const introducedHere: string[] = []
    for (const [locus, cut] of cuts) {
      const existing = byLocus.get(locus)
      const gene = existing ?? cut
      const childCarries = carries(childContent, gene)
      const parentCarries = parents.filter((parentId) => carries(known(parentId), gene))
      if (existing && !childCarries && parentCarries.length > 0) {
        existing.dropped += 1
        continue
      }
      // A merge child that took the edit from another parent inherited it; a
      // deletion of one copy of a repeated block leaves the child without it.
      if (!childCarries || parentCarries.length > 0) continue
      let record = existing
      if (!record) {
        const geneId = `gene_${hashCanonical({ kind: cut.kind, path: cut.path, lines: cut.lines })
          .slice('sha256:'.length)
          .slice(0, 24)}`
        record = {
          ...cut,
          geneId,
          locus,
          introduced: [],
          dropped: 0,
          order: [edgeOrdinal, cut.position],
        }
        genes.set(geneId, record)
        byLocus.set(locus, record)
      }
      record.introduced.push({
        nodeId: child.nodeId,
        edgeId: edge.edgeId,
        operator: edge.operator,
        parents,
        reproposal,
      })
      introducedHere.push(record.geneId)
    }
    introducedOn.set(edge.edgeId, introducedHere)
  }

  // Carrying: every gene against every node whose content is known.
  const carriersOf = new Map<string, Set<string>>()
  const carried = new Map<string, string[]>()
  for (const record of genes.values()) {
    const set = new Set<string>()
    for (const node of nodes) {
      const content = contents.get(node.nodeId)!
      if (content.known && carries(content, record)) {
        set.add(node.nodeId)
        carried.set(node.nodeId, [...(carried.get(node.nodeId) ?? []), record.geneId])
      }
    }
    carriersOf.set(record.geneId, set)
  }
  for (const step of stepList) {
    for (const [geneId, set] of carriersOf) {
      if (set.has(step.parentId) !== set.has(step.childId)) step.flips.add(geneId)
    }
  }
  const measurable = stepList.filter(
    (step) => !invalid.has(step.parentId) && !invalid.has(step.childId),
  )

  // The edits each gene was introduced in: per introducing edge, the genes
  // that edge introduced. The first is the edit the gene was born in.
  const editsOf = new Map<string, Array<ReadonlySet<string>>>()
  for (const record of genes.values()) {
    editsOf.set(
      record.geneId,
      record.introduced.map((introduction) => new Set(introducedOn.get(introduction.edgeId)!)),
    )
  }

  const unitMeansOf = memo((nodeId: string) => {
    const means = new Map<string, number>()
    for (const unit of state.unitScores(nodeId, split)) means.set(unit.unitId, unit.mean)
    return means
  })
  const cellsDigestOf = memo((nodeId: string) =>
    state
      .scoredCells(nodeId, split)
      .map((cell) => [cell.cellId, cell.unitId, cell.attempt, cell.score] as const)
      .sort((left, right) => compareCodeUnits(left[0], right[0])),
  )

  interface Oriented {
    step: Step
    carrierId: string
    lackingId: string
  }
  const cleanOf = new Map<string, Oriented[]>()
  const flipCount = new Map<string, number>()
  for (const step of measurable) {
    for (const geneId of step.flips) {
      flipCount.set(geneId, (flipCount.get(geneId) ?? 0) + 1)
      // Clean: every change on the step belongs to one edit that introduced
      // the gene, so the contrast is that edit's, not a mixture.
      const inOneEdit = editsOf
        .get(geneId)!
        .some((edit) => [...step.flips].every((other) => edit.has(other)))
      if (!inOneEdit) continue
      const childCarries = carriersOf.get(geneId)!.has(step.childId)
      const oriented = {
        step,
        carrierId: childCarries ? step.childId : step.parentId,
        lackingId: childCarries ? step.parentId : step.childId,
      }
      cleanOf.set(geneId, [...(cleanOf.get(geneId) ?? []), oriented])
    }
  }

  const credits = new Map<string, { credit: NodeEstimate; verdict: EditGeneVerdict }>()
  for (const record of genes.values()) {
    const steps = cleanOf.get(record.geneId) ?? []
    const perUnit = new Map<string, { carrier: number; lacking: number; count: number }>()
    for (const { carrierId, lackingId } of steps) {
      const lacking = unitMeansOf(lackingId)
      for (const [unitId, carrierMean] of unitMeansOf(carrierId)) {
        const lackingMean = lacking.get(unitId)
        if (lackingMean === undefined) continue
        const entry = perUnit.get(unitId) ?? { carrier: 0, lacking: 0, count: 0 }
        entry.carrier += carrierMean
        entry.lacking += lackingMean
        entry.count += 1
        perUnit.set(unitId, entry)
      }
    }
    const unitIds = [...perUnit.keys()].sort(compareCodeUnits)
    const cellSetDigest = hashCanonical({
      gene: record.geneId,
      split,
      steps: steps
        .map(({ carrierId, lackingId }) => [
          carrierId,
          lackingId,
          cellsDigestOf(carrierId),
          cellsDigestOf(lackingId),
        ])
        .sort((left, right) => compareCodeUnits(canonicalString(left), canonicalString(right))),
    })
    const carrierUnits = new Set<string>()
    for (const { carrierId } of steps)
      for (const unitId of unitMeansOf(carrierId).keys()) carrierUnits.add(unitId)
    credits.set(
      record.geneId,
      pairedEstimate({
        against: `${record.geneId}:lacking`,
        split,
        direction,
        units: carrierUnits.size,
        lacking: unitIds.map((unitId) => perUnit.get(unitId)!.lacking / perUnit.get(unitId)!.count),
        carrier: unitIds.map((unitId) => perUnit.get(unitId)!.carrier / perUnit.get(unitId)!.count),
        cellSetDigest,
      }),
    )
  }

  // Linkage: the same clean steps, oriented the same way.
  const linkageKey = (geneId: string) =>
    canonicalString(
      (cleanOf.get(geneId) ?? [])
        .map(({ step, carrierId }) => `${step.key}:${carrierId === step.childId ? '+' : '-'}`)
        .sort(compareCodeUnits),
    )
  const linkGroups = new Map<string, string[]>()
  for (const record of [...genes.values()].sort((a, b) => compareOrder(a.order, b.order))) {
    if (!cleanOf.has(record.geneId)) continue
    const key = linkageKey(record.geneId)
    linkGroups.set(key, [...(linkGroups.get(key) ?? []), record.geneId])
  }

  const geneList: EditGene[] = [...genes.values()].map((record) => {
    const clean = cleanOf.get(record.geneId) ?? []
    const group = clean.length > 0 ? linkGroups.get(linkageKey(record.geneId))! : []
    const carriers = carriersOf.get(record.geneId)!
    const { credit, verdict } = credits.get(record.geneId)!
    return {
      geneId: record.geneId,
      kind: record.kind,
      path: record.path,
      lines: record.lines,
      text: record.text,
      introduced: record.introduced,
      dropped: record.dropped,
      edit: [...editsOf.get(record.geneId)![0]!].sort((a, b) =>
        compareOrder(genes.get(a)!.order, genes.get(b)!.order),
      ),
      carriers: [...carriers].filter((nodeId) => !invalid.has(nodeId)).length,
      invalidCarriers: [...carriers].filter((nodeId) => invalid.has(nodeId)).length,
      steps: {
        flips: flipCount.get(record.geneId) ?? 0,
        clean: clean.length,
        gained: clean.filter(({ step, carrierId }) => carrierId === step.childId).length,
        lost: clean.filter(({ step, carrierId }) => carrierId === step.parentId).length,
      },
      credit,
      verdict,
      linkage: group.length > 1 ? group[0]! : null,
    }
  })
  const verdictRank: Record<EditGeneVerdict, number> = {
    reusable: 0,
    harmful: 1,
    unresolved: 2,
    insufficient: 3,
  }
  geneList.sort(
    (a, b) =>
      verdictRank[a.verdict] - verdictRank[b.verdict] ||
      improvementLow(b.credit, sign) - improvementLow(a.credit, sign) ||
      gain(b.credit, sign) - gain(a.credit, sign) ||
      compareOrder(genes.get(a.geneId)!.order, genes.get(b.geneId)!.order),
  )
  const counts = emptyCounts()
  const editCounts = emptyCounts()
  for (const gene of geneList) {
    counts[gene.verdict] += 1
    if (gene.linkage === null || gene.linkage === gene.geneId) editCounts[gene.verdict] += 1
  }

  const interactions = interactionPairs({
    genes: geneList,
    cleanOf,
    carriersOf,
    unitMeansOf,
    limit: interactionGenes,
    sign,
  })
  const skillCandidates = skills(geneList, genes, header.subject, split)
  const lineage = lineageRows(state, nodes, byId, contents, carried)

  const measured = geneList.filter(
    (gene) => gene.credit.method === 'descriptive' || gene.credit.method === 'bootstrap',
  ).length
  const signal =
    measured === 0
      ? {
          name: EDIT_CREDIT_SIGNAL,
          value: null,
          basis: `insufficient: no gene has ${DESCRIPTIVE_FROM} ${split} units on clean steps (${geneList.length} genes, ${measurable.length} measurable steps)`,
        }
      : {
          name: EDIT_CREDIT_SIGNAL,
          value: counts.reusable,
          basis: `genes whose credit interval on the ${split} split lies wholly on the better side of zero, of ${measured} measured on ${DESCRIPTIVE_FROM} or more units (${editCounts.reusable} independent edits)`,
        }

  return {
    lens: 'editCredit',
    searchId: state.searchId,
    head: state.head,
    signal,
    data: {
      split,
      direction,
      edges: { lineage: lineageEdges, read: readEdges, unknown: unknownEdges },
      steps: { total: stepList.length, invalidEnd: stepList.length - measurable.length },
      nodes: {
        total: nodes.length,
        contentUnknown: [...contents.values()].filter((content) => !content.known).length,
        invalid: invalid.size,
      },
      genes: geneList,
      counts,
      editCounts,
      interactions,
      skillCandidates,
      lineage,
      method: {
        estimator: EDIT_CREDIT_ESTIMATOR,
        credit: `per clean step (a parent and its child on which every change belongs to one edit that introduced the gene), the carrying side against the lacking side on each unit both scored; per unit, both sides averaged over those steps; ${DECISION_PAIRED_DELTA_STATISTIC} paired delta with a ${Math.round(CONFIDENCE * 100)}% percentile bootstrap (${RESAMPLES} resamples, seeded from cellSetDigest): none below 2 units, insufficient below ${DESCRIPTIVE_FROM}, a descriptive interval and exact one-sided sign p below ${BOOTSTRAP_GATE_MIN_N}, a decision-grade interval from ${BOOTSTRAP_GATE_MIN_N}; unscored cells are absent, never zero`,
        verdict: `pairedDeltaTest's own decision in each direction: reusable when it finds an improvement (below ${BOOTSTRAP_GATE_MIN_N} units an exact one-sided sign test at ${(1 - CONFIDENCE) / 2} with the point estimate on the better side; from ${BOOTSTRAP_GATE_MIN_N} the bootstrap interval above zero), harmful when it finds one in the other direction, unresolved otherwise, insufficient below ${DESCRIPTIVE_FROM} units`,
        interaction: `per unit, a gene's clean-step contrast where both ends carry the other gene minus where neither does, averaged over both directions; ${Math.round(CONFIDENCE * 100)}% percentile bootstrap (${RESAMPLES} resamples) for spread; exact two-sided sign test, Holm-adjusted over the pairs tested, flagged at ${INTERACTION_ALPHA}`,
        multiplicity:
          'credit is not adjusted for the number of genes: it steers which edits to reuse and test next, as selection estimates steer spend, and claims nothing; interaction flags are Holm-adjusted because pairs grow with the square of the genes',
      },
    },
  }
}

// ---------------------------------------------------------------------------
// Content

function nodeContent(options: EditCreditOptions, ref: SearchArtifactRef): NodeContent {
  const body = options.readArtifact(ref)
  if (body === undefined) return { known: false, reason: `artifact ${ref.role} unreadable` }
  const paths = new Map<string, PathText>()
  const record = body as { kind?: unknown; surface?: unknown }
  if (record && typeof record === 'object' && record.kind === 'mutable-surface') {
    const surface = record.surface as
      | string
      | { kind: 'components'; components: Record<string, string> }
      | { kind: 'code' }
      | undefined
    if (typeof surface === 'string') addText(paths, 'prompt', surface)
    else if (surface?.kind === 'components') {
      for (const name of Object.keys(surface.components).sort(compareCodeUnits)) {
        addText(paths, `component:${name}`, surface.components[name]!)
      }
    } else {
      return { known: false, reason: 'code surface: its patch bytes are not in the ledger' }
    }
  } else {
    flatten(body, '', paths)
  }
  const haystacks = new Map<string, string>()
  for (const [path, text] of paths) {
    haystacks.set(path, `\n${text.norm.filter((line) => line.length > 0).join('\n')}\n`)
  }
  return { known: true, paths, haystacks }
}

/** JSON as text per location: a string's lines at its path, an array's
 * elements as lines at the array's path, any other value as one canonical
 * line. Array elements share a path, so an insertion does not renumber the
 * rest. */
function flatten(value: unknown, path: string, paths: Map<string, PathText>): void {
  const at = path === '' ? '/' : path
  if (typeof value === 'string') {
    addText(paths, at, value)
  } else if (Array.isArray(value)) {
    for (const element of value) {
      addText(paths, at, typeof element === 'string' ? element : canonicalString(element))
    }
  } else if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value).sort(compareCodeUnits)) {
      const escaped = key.replaceAll('~', '~0').replaceAll('/', '~1')
      flatten((value as Record<string, unknown>)[key], `${path}/${escaped}`, paths)
    }
  } else {
    addText(paths, at, canonicalString(value))
  }
}

function addText(paths: Map<string, PathText>, path: string, text: string): void {
  const entry = paths.get(path) ?? { raw: [], norm: [] }
  for (const line of text.split(/\r?\n/)) {
    entry.raw.push(line)
    entry.norm.push(line.replace(/\s+/g, ' ').trim())
  }
  paths.set(path, entry)
}

function carries(
  content: KnownContent,
  gene: { kind: 'insert' | 'delete'; path: string; needle: string },
): boolean {
  const present = content.haystacks.get(gene.path)?.includes(gene.needle) ?? false
  return gene.kind === 'insert' ? present : !present
}

function locusOf(cut: { path: string; lines: readonly string[] }): string {
  return canonicalString([cut.path, cut.lines])
}

// ---------------------------------------------------------------------------
// Genes

function edgeCuts(parent: KnownContent, child: KnownContent): GeneCut[] {
  const cuts: GeneCut[] = []
  const paths = new Set([...parent.paths.keys(), ...child.paths.keys()])
  let position = 0
  for (const path of [...paths].sort(compareCodeUnits)) {
    const before = parent.paths.get(path) ?? { raw: [], norm: [] }
    const after = child.paths.get(path) ?? { raw: [], norm: [] }
    for (const run of changeRuns(before.norm, after.norm)) {
      for (const [kind, side, start, end] of [
        ['delete', before, run.aStart, run.aEnd],
        ['insert', after, run.bStart, run.bEnd],
      ] as const) {
        for (const [from, to] of paragraphs(side.norm, start, end)) {
          const lines = side.norm.slice(from, to).filter((line) => line.length > 0)
          if (lines.length === 0) continue
          cuts.push({
            kind,
            path,
            lines,
            needle: `\n${lines.join('\n')}\n`,
            text: side.raw.slice(from, to).join('\n').trim(),
            position: position++,
          })
        }
      }
    }
  }
  return cuts
}

/** Paragraph ranges of `lines[start, end)`, split at blank lines. */
function paragraphs(lines: readonly string[], start: number, end: number): Array<[number, number]> {
  const ranges: Array<[number, number]> = []
  let from = -1
  for (let index = start; index < end; index++) {
    if (lines[index]!.length === 0) {
      if (from >= 0) ranges.push([from, index])
      from = -1
    } else if (from < 0) {
      from = index
    }
  }
  if (from >= 0) ranges.push([from, end])
  return ranges
}

interface ChangeRun {
  aStart: number
  aEnd: number
  bStart: number
  bEnd: number
}

/** Maximal runs where `a[aStart, aEnd)` became `b[bStart, bEnd)`, from a
 * shortest edit script (Myers, 1986). */
function changeRuns(a: readonly string[], b: readonly string[]): ChangeRun[] {
  let prefix = 0
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix += 1
  let suffix = 0
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix += 1
  }
  const innerA = a.slice(prefix, a.length - suffix)
  const innerB = b.slice(prefix, b.length - suffix)
  const runs: ChangeRun[] = []
  let i = 0
  let j = 0
  const flush = (toI: number, toJ: number) => {
    if (toI > i || toJ > j) {
      runs.push({ aStart: prefix + i, aEnd: prefix + toI, bStart: prefix + j, bEnd: prefix + toJ })
    }
  }
  for (const [mi, mj] of matches(innerA, innerB)) {
    flush(mi, mj)
    i = mi + 1
    j = mj + 1
  }
  flush(innerA.length, innerB.length)
  return runs
}

/** Matched index pairs of a shortest edit script, in increasing order. */
function matches(a: readonly string[], b: readonly string[]): Array<[number, number]> {
  const n = a.length
  const m = b.length
  if (n === 0 || m === 0) return []
  const offset = n + m
  const v = new Int32Array(2 * offset + 2)
  const trace: Int32Array[] = []
  let done = false
  for (let d = 0; d <= n + m && !done; d++) {
    trace.push(v.slice())
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && v[k - 1 + offset]! < v[k + 1 + offset]!)
          ? v[k + 1 + offset]!
          : v[k - 1 + offset]! + 1
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) {
        x += 1
        y += 1
      }
      v[k + offset] = x
      if (x >= n && y >= m) {
        done = true
        break
      }
    }
  }
  const pairs: Array<[number, number]> = []
  let x = n
  let y = m
  for (let d = trace.length - 1; d >= 0; d--) {
    const before = trace[d]!
    const k = x - y
    const prevK =
      k === -d || (k !== d && before[k - 1 + offset]! < before[k + 1 + offset]!) ? k + 1 : k - 1
    const prevX = before[prevK + offset]!
    const prevY = prevX - prevK
    while (x > prevX && y > prevY) {
      x -= 1
      y -= 1
      pairs.push([x, y])
    }
    if (d > 0) {
      x = prevX
      y = prevY
    }
  }
  return pairs.reverse()
}

// ---------------------------------------------------------------------------
// Lineage

/** Parents of an edge that precede its child in this search: the edge's
 * lineage. A re-proposal from the child itself or a later node adds none. */
function lineageParents(
  state: SearchStateView,
  edge: SearchEdgeRecordedEvent,
  child: SearchNode,
  byId: ReadonlyMap<string, SearchNode>,
): string[] {
  const parents: string[] = []
  for (const parent of edge.parents) {
    if (parent.searchId !== state.searchId) continue
    const node = byId.get(parent.nodeId)
    if (node && node.ordinal < child.ordinal && !parents.includes(node.nodeId)) {
      parents.push(node.nodeId)
    }
  }
  return parents
}

function lineageRows(
  state: SearchStateView,
  nodes: readonly SearchNode[],
  byId: ReadonlyMap<string, SearchNode>,
  contents: ReadonlyMap<string, NodeContent>,
  carried: ReadonlyMap<string, string[]>,
): EditLineageRow[] {
  const rows: EditLineageRow[] = []
  const placed = new Set<string>()
  const visit = (root: SearchNode) => {
    const stack = [root]
    while (stack.length > 0) {
      const node = stack.pop()!
      if (placed.has(node.nodeId)) continue
      placed.add(node.nodeId)
      const firstEdge = node.edgeIds[0] ? state.edge(node.edgeIds[0]) : undefined
      rows.push({
        nodeId: node.nodeId,
        ordinal: node.ordinal,
        depth: node.depth,
        primaryParentId: node.primaryParentId,
        parents: node.parents
          .filter((parent) => parent.searchId === state.searchId)
          .map((parent) => parent.nodeId),
        operator: firstEdge?.operator ?? null,
        status: node.status,
        carries: [...(carried.get(node.nodeId) ?? [])].sort(compareCodeUnits),
        contentKnown: contents.get(node.nodeId)!.known,
      })
      const children = node.children
        .map((id) => byId.get(id)!)
        .filter((child) => child.primaryParentId === node.nodeId)
        .sort((a, b) => b.ordinal - a.ordinal)
      stack.push(...children)
    }
  }
  for (const node of nodes) if (node.primaryParentId === null) visit(node)
  for (const node of nodes) visit(node)
  return rows
}

// ---------------------------------------------------------------------------
// Statistics

/**
 * The paired contrast of per-unit carrier means against per-unit lacking
 * means, staged and oriented exactly as `estimateNodeFromCells` stages and
 * orients a node against another, with the verdict `pairedDeltaTest` itself
 * would reach in each direction: below 20 units the exact one-sided sign test
 * at α = 0.025 and a point estimate on the same side, from 20 the bootstrap
 * interval clear of zero.
 */
function pairedEstimate(input: {
  against: string
  split: SearchSplit
  direction: 'maximize' | 'minimize'
  units: number
  carrier: number[]
  lacking: number[]
  cellSetDigest: NodeEstimate['cellSetDigest']
}): { credit: NodeEstimate; verdict: EditGeneVerdict } {
  const pairs = input.carrier.length
  const method = methodFor(pairs)
  const base = {
    against: input.against,
    split: input.split,
    units: input.units,
    pairs,
    method,
    cellSetDigest: input.cellSetDigest,
    estimator: EDIT_CREDIT_ESTIMATOR,
  }
  if (method === 'none') {
    return {
      credit: { ...base, delta: null, interval: null, exactSignP: null, indeterminate: false },
      verdict: 'insufficient',
    }
  }
  // The test's `after - before` is the improvement: carrier minus lacking
  // when larger is better, lacking minus carrier when smaller is.
  const maximize = input.direction === 'maximize'
  const before = maximize ? input.lacking : input.carrier
  const after = maximize ? input.carrier : input.lacking
  const options = {
    statistic: DECISION_PAIRED_DELTA_STATISTIC,
    confidence: CONFIDENCE,
    resamples: RESAMPLES,
    seed: seedFromDigest(input.cellSetDigest),
  }
  const better = pairedDeltaTest(before, after, options)
  const worse = pairedDeltaTest(after, before, options)
  const { mean, low, high } = better.bootstrap
  const indeterminate = better.indeterminate
  const spread = (method === 'descriptive' || method === 'bootstrap') && !indeterminate
  const credit: NodeEstimate = {
    ...base,
    delta: plain(maximize ? mean : -mean),
    interval: spread ? (maximize ? [plain(low), plain(high)] : [plain(-high), plain(-low)]) : null,
    exactSignP: method === 'descriptive' && !indeterminate ? better.pValue : null,
    indeterminate,
  }
  const verdict: EditGeneVerdict =
    method === 'insufficient'
      ? 'insufficient'
      : better.significant
        ? 'reusable'
        : worse.significant
          ? 'harmful'
          : 'unresolved'
  return { credit, verdict }
}

function methodFor(units: number): SearchEstimateMethod {
  if (units < 2) return 'none'
  if (units < DESCRIPTIVE_FROM) return 'insufficient'
  if (units < BOOTSTRAP_GATE_MIN_N) return 'descriptive'
  return 'bootstrap'
}

/** The worse end of the interval, as an improvement; -Infinity without one. */
function improvementLow(credit: NodeEstimate, sign: number): number {
  if (credit.interval === null) return Number.NEGATIVE_INFINITY
  return sign > 0 ? credit.interval[0] : -credit.interval[1]
}

function gain(credit: NodeEstimate, sign: number): number {
  return credit.delta === null ? Number.NEGATIVE_INFINITY : sign * credit.delta
}

function interactionPairs(input: {
  genes: readonly EditGene[]
  cleanOf: ReadonlyMap<string, ReadonlyArray<{ step: Step; carrierId: string; lackingId: string }>>
  carriersOf: ReadonlyMap<string, ReadonlySet<string>>
  unitMeansOf: (nodeId: string) => ReadonlyMap<string, number>
  limit: number
  sign: number
}): EditCreditData['interactions'] {
  // One member per linkage group: linked genes have the same clean steps, so
  // every pair across two groups repeats one contrast.
  const seenGroups = new Set<string>()
  const considered = [...input.genes]
    .filter((gene) => {
      const group = gene.linkage ?? gene.geneId
      if (seenGroups.has(group)) return false
      seenGroups.add(group)
      return gene.credit.pairs >= DESCRIPTIVE_FROM
    })
    .sort((a, b) => b.credit.pairs - a.credit.pairs || compareCodeUnits(a.geneId, b.geneId))
    .slice(0, input.limit)

  /** Per unit, the mean clean-step contrast of `geneId` over `steps`. */
  const contrasts = (
    steps: ReadonlyArray<{ carrierId: string; lackingId: string }>,
  ): Map<string, number> => {
    const sums = new Map<string, { sum: number; count: number }>()
    for (const { carrierId, lackingId } of steps) {
      const lacking = input.unitMeansOf(lackingId)
      for (const [unitId, carrierMean] of input.unitMeansOf(carrierId)) {
        const lackingMean = lacking.get(unitId)
        if (lackingMean === undefined) continue
        const entry = sums.get(unitId) ?? { sum: 0, count: 0 }
        entry.sum += carrierMean - lackingMean
        entry.count += 1
        sums.set(unitId, entry)
      }
    }
    return new Map([...sums].map(([unitId, entry]) => [unitId, entry.sum / entry.count]))
  }
  /** `geneId`'s clean steps split by whether both ends carry `other`. */
  const split = (geneId: string, other: string) => {
    const carriers = input.carriersOf.get(other)!
    const steps = input.cleanOf.get(geneId) ?? []
    const withOther = steps.filter(
      ({ step }) => carriers.has(step.parentId) && carriers.has(step.childId),
    )
    const withoutOther = steps.filter(
      ({ step }) => !carriers.has(step.parentId) && !carriers.has(step.childId),
    )
    return { withOther, withoutOther }
  }

  const pairs: EditInteraction[] = []
  for (let i = 0; i < considered.length; i++) {
    for (let j = i + 1; j < considered.length; j++) {
      const first = considered[i]!
      const second = considered[j]!
      if (first.edit.includes(second.geneId) || second.edit.includes(first.geneId)) continue
      const firstSplit = split(first.geneId, second.geneId)
      const secondSplit = split(second.geneId, first.geneId)
      const steps = {
        firstWithSecond: firstSplit.withOther.length,
        firstWithoutSecond: firstSplit.withoutOther.length,
        secondWithFirst: secondSplit.withOther.length,
        secondWithoutFirst: secondSplit.withoutOther.length,
      }
      const directions = [firstSplit, secondSplit].filter(
        (direction) => direction.withOther.length > 0 && direction.withoutOther.length > 0,
      )
      if (directions.length === 0) continue
      const perUnit = new Map<string, { sum: number; count: number }>()
      for (const direction of directions) {
        const withMeans = contrasts(direction.withOther)
        const withoutMeans = contrasts(direction.withoutOther)
        for (const [unitId, withMean] of withMeans) {
          const withoutMean = withoutMeans.get(unitId)
          if (withoutMean === undefined) continue
          const entry = perUnit.get(unitId) ?? { sum: 0, count: 0 }
          entry.sum += withMean - withoutMean
          entry.count += 1
          perUnit.set(unitId, entry)
        }
      }
      const values = [...perUnit.keys()]
        .sort(compareCodeUnits)
        .map((unitId) => perUnit.get(unitId)!.sum / perUnit.get(unitId)!.count)
      pairs.push(interactionEstimate([first.geneId, second.geneId], steps, values, input.sign))
    }
  }
  const tested = pairs.filter((pair) => pair.signP !== null)
  const adjusted = holm(
    tested.map((pair) => pair.signP!),
    INTERACTION_ALPHA,
  )
  tested.forEach((pair, index) => {
    pair.adjustedP = adjusted.adjusted[index]!
    pair.interacting = adjusted.significant[index]!
  })
  pairs.sort(
    (a, b) =>
      Number(b.interacting) - Number(a.interacting) ||
      (a.adjustedP ?? 2) - (b.adjustedP ?? 2) ||
      b.units - a.units ||
      compareCodeUnits(a.genes.join(), b.genes.join()),
  )
  return {
    genesConsidered: considered.length,
    pairsWithContexts: pairs.length,
    pairsTested: tested.length,
    alpha: INTERACTION_ALPHA,
    correction: 'holm',
    pairs,
  }
}

function interactionEstimate(
  genes: [string, string],
  steps: EditInteraction['steps'],
  values: number[],
  sign: number,
): EditInteraction {
  const units = values.length
  const method = methodFor(units)
  const base = { genes, steps, units, method, adjustedP: null, interacting: false }
  if (method === 'none') {
    return {
      ...base,
      interaction: null,
      interval: null,
      indeterminate: false,
      signP: null,
      synergy: null,
    }
  }
  const interaction = plain(values.reduce((sum, value) => sum + value, 0) / units)
  if (method === 'insufficient') {
    return {
      ...base,
      interaction,
      interval: null,
      indeterminate: false,
      signP: null,
      synergy: sign * interaction > 0,
    }
  }
  const zeros = values.map(() => 0)
  const test = pairedDeltaTest(zeros, values, {
    statistic: DECISION_PAIRED_DELTA_STATISTIC,
    confidence: CONFIDENCE,
    resamples: RESAMPLES,
    seed: seedFromDigest(hashCanonical({ genes, values })),
  })
  const indeterminate = test.indeterminate
  const greater = pairedSignTest(values, 'greater').pValue
  const less = pairedSignTest(values, 'less').pValue
  return {
    ...base,
    interaction,
    interval: indeterminate ? null : [plain(test.bootstrap.low), plain(test.bootstrap.high)],
    indeterminate,
    signP: indeterminate ? null : Math.min(1, 2 * Math.min(greater, less)),
    synergy: sign * interaction > 0,
  }
}

// ---------------------------------------------------------------------------
// Skills

function skills(
  genes: readonly EditGene[],
  records: ReadonlyMap<string, GeneRecord>,
  subject: string,
  split: SearchSplit,
): EditSkillCandidate[] {
  const byGroup = new Map<string, EditGene[]>()
  for (const gene of genes) {
    if (gene.verdict !== 'reusable' || gene.kind !== 'insert') continue
    const group = gene.linkage ?? gene.geneId
    byGroup.set(group, [...(byGroup.get(group) ?? []), gene])
  }
  const candidates: EditSkillCandidate[] = []
  for (const members of byGroup.values()) {
    members.sort((a, b) => compareOrder(records.get(a.geneId)!.order, records.get(b.geneId)!.order))
    const lead = members[0]!
    const name = `edit-${lead.geneId.slice('gene_'.length, 'gene_'.length + 12)}`
    const content = [
      '---',
      `name: ${name}`,
      `description: ${JSON.stringify(
        `Instructions a ${subject} search kept: the edit to ${lead.path} whose carriers scored better than the nodes without it on the ${split} split.`,
      )}`,
      '---',
      '',
      members.map((gene) => gene.text).join('\n\n'),
      '',
    ].join('\n')
    candidates.push({
      resource: defineInlineResource(name, content) as Extract<
        AgentProfileResourceRef,
        { kind: 'inline' }
      >,
      improveOptions: { surface: 'skills', skills: { resourceName: name } },
      genes: members.map((gene) => gene.geneId),
      path: lead.path,
      credit: lead.credit,
    })
  }
  return candidates
}

// ---------------------------------------------------------------------------
// Text

/** The lens as compact text: what `agent-eval search show --edit-credit`
 * prints and a proposer can read. */
export function editCreditText(result: EditCreditResult, options: { limit?: number } = {}): string {
  const limit = options.limit ?? 10
  const { data, signal } = result
  const unknown = Object.entries(data.edges.unknown)
    .map(([reason, count]) => `${count} ${reason}`)
    .join(', ')
  const lines = [
    `edit credit — ${data.genes.length} genes from ${data.edges.read} of ${data.edges.lineage} lineage edges, ${data.steps.total - data.steps.invalidEnd} measurable steps (${data.split} split, ${data.direction})`,
    `  genes: reusable ${data.counts.reusable} · harmful ${data.counts.harmful} · unresolved ${data.counts.unresolved} · insufficient ${data.counts.insufficient}`,
    `  edits: reusable ${data.editCounts.reusable} · harmful ${data.editCounts.harmful} · unresolved ${data.editCounts.unresolved} · insufficient ${data.editCounts.insufficient}`,
    `  signal ${signal.name} = ${signal.value ?? 'null'} (${signal.basis})`,
  ]
  if (unknown.length > 0) lines.push(`  edges without content: ${unknown}`)
  if (data.nodes.invalid > 0) {
    lines.push(
      `  ${data.nodes.invalid} invalid node(s): ${data.steps.invalidEnd} step(s) excluded from every contrast`,
    )
  }
  lines.push('', 'Genes (carrying vs lacking side of each clean lineage step):')
  if (data.genes.length === 0) lines.push('  none')
  for (const gene of data.genes.slice(0, limit)) {
    const reproposed = gene.introduced.length > 1 ? ` · introduced ${gene.introduced.length}×` : ''
    const dropped = gene.dropped > 0 ? ` · dropped ${gene.dropped}×` : ''
    const linked =
      gene.linkage && gene.linkage !== gene.geneId ? ` · linked to ${gene.linkage}` : ''
    const invalid = gene.invalidCarriers > 0 ? ` · ${gene.invalidCarriers} invalid carrier(s)` : ''
    lines.push(
      `  ${gene.geneId} ${gene.verdict} ${gene.kind} ${gene.path} "${excerpt(gene.lines)}"`,
      `    ${gene.steps.clean} clean of ${gene.steps.flips} step(s) (+${gene.steps.gained}/−${gene.steps.lost}) · ${formatEstimate(gene.credit)}${reproposed}${dropped}${linked}${invalid}`,
    )
  }
  if (data.genes.length > limit) lines.push(`  … ${data.genes.length - limit} more`)
  const { interactions } = data
  lines.push(
    '',
    `Interactions: ${interactions.pairsTested} pair(s) tested of ${interactions.pairsWithContexts} with both contexts, among ${interactions.genesConsidered} genes (Holm, α=${interactions.alpha}):`,
  )
  const shown = interactions.pairs.filter((pair) => pair.signP !== null).slice(0, limit)
  if (shown.length === 0) lines.push('  none testable')
  for (const pair of shown) {
    const interval = pair.interval
      ? ` [${pair.interval[0].toFixed(4)}, ${pair.interval[1].toFixed(4)}]`
      : ''
    lines.push(
      `  ${pair.genes[0]} × ${pair.genes[1]}: ${pair.interacting ? 'INTERACTING' : 'no flag'} ${signed(pair.interaction)}${interval} on ${pair.units} units, sign p=${pair.signP!.toPrecision(3)}, Holm p=${pair.adjustedP!.toPrecision(3)}`,
    )
  }
  lines.push('', `Skill candidates (agent-runtime improve surface 'skills'):`)
  if (data.skillCandidates.length === 0) lines.push('  none')
  for (const candidate of data.skillCandidates.slice(0, limit)) {
    lines.push(
      `  ${candidate.resource.name}: ${candidate.genes.length} gene(s) at ${candidate.path} · ${formatEstimate(candidate.credit)}`,
    )
  }
  return lines.join('\n')
}

function excerpt(lines: readonly string[]): string {
  const text = lines.join(' ⏎ ')
  return text.length <= 72 ? text : `${text.slice(0, 71)}…`
}

function signed(value: number | null): string {
  if (value === null) return 'null'
  return `${value >= 0 ? '+' : ''}${value.toFixed(4)}`
}

function formatEstimate(estimate: NodeEstimate): string {
  const units = `${estimate.pairs} unit${estimate.pairs === 1 ? '' : 's'}`
  if (estimate.method === 'none') return `unknown (${units})`
  if (estimate.indeterminate) return `no measurable difference (indeterminate, ${units})`
  const delta = `Δ=${signed(estimate.delta)}`
  if (estimate.method === 'insufficient') {
    return `${delta} (${estimate.pairs} of ${DESCRIPTIVE_FROM} units, insufficient)`
  }
  const interval = estimate.interval
    ? ` [${estimate.interval[0].toFixed(4)}, ${estimate.interval[1].toFixed(4)}]`
    : ''
  if (estimate.method === 'descriptive') {
    const p = estimate.exactSignP === null ? 'null' : estimate.exactSignP.toPrecision(3)
    return `${delta}${interval} descriptive, sign p=${p} (${units})`
  }
  return `${delta}${interval} bootstrap (${units})`
}

// ---------------------------------------------------------------------------

function emptyCounts(): Record<EditGeneVerdict, number> {
  return { reusable: 0, harmful: 0, unresolved: 0, insufficient: 0 }
}

function memo<T>(compute: (key: string) => T): (key: string) => T {
  const cache = new Map<string, T>()
  return (key) => {
    let value = cache.get(key)
    if (value === undefined) {
      value = compute(key)
      cache.set(key, value)
    }
    return value
  }
}

function compareOrder(left: [number, number], right: [number, number]): number {
  return left[0] - right[0] || left[1] - right[1]
}

/** Canonical JSON has one zero; never hand it a negative one. */
function plain(value: number): number {
  return value === 0 ? 0 : value
}
