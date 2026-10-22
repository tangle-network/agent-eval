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

import type { NodeEstimate } from '../../campaign/search-ledger-types'
import type { SearchStateView } from '../../campaign/search-state'
import { canonicalString, compareCodeUnits, hashCanonical } from '../../ledger-core/canonical'
import { BOOTSTRAP_GATE_MIN_N, DECISION_PAIRED_DELTA_STATISTIC } from '../../statistics'
import { normalizeSignedZero as plain } from '../../statistics/normalize-signed-zero'
import { carries, edgeCuts, locusOf, nodeContent } from './edit-credit-content'
import type {
  EditCreditOptions,
  EditCreditResult,
  EditCreditSignal,
  EditGene,
  EditGeneVerdict,
  GeneCut,
  GeneRecord,
  KnownContent,
  NodeContent,
  Step,
} from './edit-credit-contract'
import {
  CONFIDENCE,
  DEFAULT_INTERACTION_GENES,
  DESCRIPTIVE_FROM,
  EDIT_CREDIT_ESTIMATOR,
  EDIT_CREDIT_SIGNAL,
  INTERACTION_ALPHA,
  RESAMPLES,
} from './edit-credit-contract'
import { appendTo, compareOrder, lineageParents, lineageRows } from './edit-credit-lineage'
import { skills } from './edit-credit-skills'
import {
  chanceReusable,
  gain,
  improvementLow,
  interactionPairs,
  pairedEstimate,
} from './edit-credit-statistics'
import { rankingSplit } from './shared'

export type {
  EditCreditData,
  EditCreditOptions,
  EditCreditResult,
  EditCreditSignal,
  EditGene,
  EditGeneVerdict,
  EditInteraction,
  EditIntroduction,
  EditLineageRow,
  EditSkillCandidate,
} from './edit-credit-contract'
export { EDIT_CREDIT_ESTIMATOR, EDIT_CREDIT_SIGNAL } from './edit-credit-contract'
export { editCreditText } from './edit-credit-text'

/** A clean step turned so the carrying side is named. */
interface Oriented {
  step: Step
  carrierId: string
  lackingId: string
}

/**
 * The edit-credit lens. Pure: the result depends only on `state` and what
 * `readArtifact` returns for its references.
 */
export function editCredit(state: SearchStateView, options: EditCreditOptions): EditCreditResult {
  const s0 = editCreditContext({ state, options })
  const s1 = findGenes(s0)
  const s2 = trackCarriers(s1)
  const s3 = cleanSteps(s2)
  const s4 = geneCredits(s3)
  const s5 = rankGenes(s4)
  const s6 = tallyAndLink(s5)
  const s7 = chanceSignal(s6)
  return editCreditResult(s7)
}

/** The search header, split, direction and the content of every node. */
function editCreditContext(prev: { state: SearchStateView; options: EditCreditOptions }) {
  const { state, options } = prev
  const header = state.header
  if (!header) throw new Error(`editCredit: search ${state.searchId} has not been opened`)
  const split = options.split ?? rankingSplit(state)
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

  return {
    ...prev,
    header,
    split,
    direction,
    sign,
    interactionGenes,
    nodes,
    byId,
    contents,
    known,
    invalid,
  }
}

/** Genes: every lineage edge in ledger order, with the steps between a node and its parents. */
function findGenes(prev: ReturnType<typeof editCreditContext>) {
  const { state, byId, contents, known } = prev
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

  return {
    ...prev,
    genes,
    byLocus,
    introducedOn,
    unknownEdges,
    stepList,
    stepKeys,
    lineageEdges,
    readEdges,
    edgeOrdinal,
  }
}

/** Carrying: every gene against every node whose content is known, and the steps each gene flips. */
function trackCarriers(prev: ReturnType<typeof findGenes>) {
  const { nodes, contents, invalid, genes, stepList } = prev
  // Carrying: every gene against every node whose content is known.
  const carriersOf = new Map<string, Set<string>>()
  const carried = new Map<string, string[]>()
  for (const record of genes.values()) {
    const set = new Set<string>()
    for (const node of nodes) {
      const content = contents.get(node.nodeId)!
      if (content.known && carries(content, record)) {
        set.add(node.nodeId)
        appendTo(carried, node.nodeId, record.geneId)
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

  return { ...prev, carriersOf, carried, measurable }
}

/** The edits each gene was introduced in, and the clean steps that isolate each gene. */
function cleanSteps(prev: ReturnType<typeof trackCarriers>) {
  const { state, split, genes, introducedOn, carriersOf, measurable } = prev
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
      appendTo(cleanOf, geneId, oriented)
    }
  }

  return { ...prev, editsOf, unitMeansOf, cellsDigestOf, cleanOf, flipCount }
}

/** Per-gene paired credit over the clean steps. */
function geneCredits(prev: ReturnType<typeof cleanSteps>) {
  const { split, direction, genes, unitMeansOf, cellsDigestOf, cleanOf } = prev
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
    // The contrast is the oriented steps, not the gene: linked genes read the
    // same cells and so report the same numbers.
    const cellSetDigest = hashCanonical({
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

  return { ...prev, credits }
}

/** Linkage groups, then the genes in verdict order. */
function rankGenes(prev: ReturnType<typeof geneCredits>) {
  const { sign, invalid, genes, carriersOf, editsOf, cleanOf, flipCount, credits } = prev
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
    appendTo(linkGroups, key, record.geneId)
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
  return { ...prev, linkageKey, linkGroups, geneList, verdictRank }
}

/** Verdict counts, interactions, skill candidates and lineage rows. */
function tallyAndLink(prev: ReturnType<typeof rankGenes>) {
  const {
    state,
    header,
    split,
    sign,
    interactionGenes,
    nodes,
    byId,
    contents,
    genes,
    carriersOf,
    carried,
    unitMeansOf,
    cleanOf,
    geneList,
  } = prev
  const counts = emptyCounts()
  const editCounts = emptyCounts()
  for (const gene of geneList) {
    counts[gene.verdict] += 1
    // An edit is a linkage group; a gene with no clean step belongs to the
    // edit it was born in.
    const lead = gene.linkage ?? (gene.steps.clean === 0 ? gene.edit[0]! : gene.geneId)
    if (lead === gene.geneId) editCounts[gene.verdict] += 1
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

  return { ...prev, counts, editCounts, interactions, skillCandidates, lineage }
}

/** How many measured edits the lens calls reusable, and how many it would call so by chance. */
function chanceSignal(prev: ReturnType<typeof tallyAndLink>) {
  const { split, measurable, geneList, counts, editCounts } = prev
  const isMeasured = (gene: EditGene) =>
    gene.credit.method === 'descriptive' || gene.credit.method === 'bootstrap'
  const measured = geneList.filter(isMeasured).length
  const measuredLeads = geneList.filter(
    (gene) => isMeasured(gene) && (gene.linkage ?? gene.geneId) === gene.geneId,
  )
  const expectedReusable = plain(
    Math.round(
      measuredLeads.reduce((sum, gene) => sum + chanceReusable(gene.credit.pairs), 0) * 1e6,
    ) / 1e6,
  )
  const top = geneList
    .filter((gene) => gene.verdict === 'reusable' && (gene.linkage ?? gene.geneId) === gene.geneId)
    .map((gene) => gene.geneId)
  const signal: EditCreditSignal =
    measured === 0
      ? {
          name: EDIT_CREDIT_SIGNAL,
          value: null,
          basis: `insufficient: no gene has ${DESCRIPTIVE_FROM} ${split} units on clean steps (${geneList.length} genes, ${measurable.length} measurable steps)`,
          top: [],
        }
      : {
          name: EDIT_CREDIT_SIGNAL,
          value: editCounts.reusable,
          basis: `independent edits pairedDeltaTest finds improve the objective on the ${split} split (${counts.reusable} genes), of ${measuredLeads.length} edits (${measured} genes) measured on ${DESCRIPTIVE_FROM} or more units; about ${expectedReusable.toFixed(2)} would be called reusable by chance with no true effect (unadjusted)`,
          top,
        }

  return { ...prev, isMeasured, measured, measuredLeads, expectedReusable, top, signal }
}

/** The lens result: the signal and its data. */
function editCreditResult(prev: ReturnType<typeof chanceSignal>) {
  const {
    split,
    direction,
    nodes,
    contents,
    invalid,
    unknownEdges,
    stepList,
    lineageEdges,
    readEdges,
    measurable,
    geneList,
    counts,
    editCounts,
    interactions,
    skillCandidates,
    lineage,
    measuredLeads,
    expectedReusable,
    signal,
  } = prev
  return {
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
      chance: {
        measuredEdits: measuredLeads.length,
        expectedReusable,
        method: `per measured edit, the chance with no true effect that its verdict is reusable: the exact one-sided sign test's attained size at its unit count below ${BOOTSTRAP_GATE_MIN_N} units (at most ${(1 - CONFIDENCE) / 2}; the point-estimate condition only lowers it), the nominal ${(1 - CONFIDENCE) / 2} of the percentile bootstrap from ${BOOTSTRAP_GATE_MIN_N}; summed, so it is the expected number of false reusable edits if every edit had no effect`,
      },
      lineage,
      method: {
        estimator: EDIT_CREDIT_ESTIMATOR,
        credit: `per clean step (a parent and its child on which every change belongs to one edit that introduced the gene), the carrying side against the lacking side on each unit both scored; per unit, both sides averaged over those steps; ${DECISION_PAIRED_DELTA_STATISTIC} paired delta with a ${Math.round(CONFIDENCE * 100)}% percentile bootstrap (${RESAMPLES} resamples, seeded from cellSetDigest): none below 2 units, insufficient below ${DESCRIPTIVE_FROM}, a descriptive interval and exact one-sided sign p below ${BOOTSTRAP_GATE_MIN_N}, a decision-grade interval from ${BOOTSTRAP_GATE_MIN_N}; unscored cells are absent, never zero`,
        verdict: `pairedDeltaTest's own decision in each direction: reusable when it finds an improvement (below ${BOOTSTRAP_GATE_MIN_N} units an exact one-sided sign test at ${(1 - CONFIDENCE) / 2} with the point estimate on the better side; from ${BOOTSTRAP_GATE_MIN_N} the bootstrap interval above zero), harmful when it finds one in the other direction, unresolved otherwise, insufficient below ${DESCRIPTIVE_FROM} units`,
        interaction: `per unit, a gene's clean-step contrast where both ends carry the other gene minus where neither does, averaged over both directions; ${Math.round(CONFIDENCE * 100)}% percentile bootstrap (${RESAMPLES} resamples) for spread; exact two-sided sign test, Holm-adjusted over the pairs tested, flagged at ${INTERACTION_ALPHA}`,
        multiplicity:
          'credit is not adjusted for the number of genes: it steers which edits to reuse and test next, as selection estimates steer spend, and claims nothing; interaction flags are Holm-adjusted because pairs grow with the square of the genes',
        selectionBias:
          'a policy chooses a parent for its scores, so a parent is high by chance on the units it was chosen on: on a step where the child gained a gene the lacking side is that parent, and credit is biased toward harmful; where the child lost it, toward reusable. Only the sealed test split is free of this, so a reusable edit still needs a held-out test before it ships',
      },
    },
  }
}

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
