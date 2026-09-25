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
 * absent; carrying is read from each node's content, so it follows merges and
 * reverts without any bookkeeping in the record.
 *
 * A gene's credit is `estimateNodeFromCells` of the nodes that carry it
 * against the nodes that do not, inside the subtrees of the parents it was
 * born from, paired on the units both groups scored. It is observational: a
 * carrier also carries what it inherited alongside the edit, which is why
 * genes with identical carriers are reported as linked, and why interacting
 * pairs are flagged for a factorial test rather than claimed.
 *
 * The lens reads node artifacts through `readArtifact`, which the caller backs
 * with verified blob bytes. An artifact the caller cannot read, and a code
 * surface whose patch bytes are not in the ledger, leave the node's content
 * unknown: its edges yield no genes and it joins neither group.
 */

import { type AgentProfileResourceRef, defineInlineResource } from '@tangle-network/agent-interface'
import { estimateNodeFromCells, seedFromDigest } from '../../campaign/estimate-node'
import type {
  NodeEstimate,
  SearchArtifactRef,
  SearchEdgeOperator,
  SearchEdgeRecordedEvent,
  SearchEstimateMethod,
  SearchSplit,
} from '../../campaign/search-ledger-types'
import type { SearchNode, SearchScoredCell, SearchStateView } from '../../campaign/search-state'
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
  /** Genes tested for pairwise interaction: those with the most paired units.
   * Default 24, so at most 276 pairs. */
  interactionGenes?: number
}

export type EditGeneVerdict = 'reusable' | 'harmful' | 'unresolved' | 'insufficient'

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
  /** Nodes whose lineage edge introduced the gene, in registration order. */
  births: Array<{
    nodeId: string
    edgeId: string
    operator: SearchEdgeOperator
    parents: string[]
  }>
  /** Edges that introduced it, re-proposals included: more than `births`
   * means a proposer made the same edit again. */
  proposals: number
  /** Nodes of the birth parents' subtrees whose content is known and that are
   * not `invalid`: the credit's sample. */
  population: number
  carriers: number
  lacking: number
  /** `invalid` carriers (judge integrity or admission failures), excluded from
   * the credit; an edit that makes nodes invalid shows here. */
  invalidCarriers: number
  /** Subtree nodes whose content is unknown, excluded from both groups. */
  unknownContent: number
  /** Carriers against non-carriers; `delta` is carriers minus non-carriers in
   * the metric's units. */
  credit: NodeEstimate
  verdict: EditGeneVerdict
  /** Genes with exactly this gene's carriers and sample: their credits are the
   * same number and cannot be separated. Null when there are none. */
  linkage: string | null
}

export interface EditInteraction {
  genes: [string, string]
  /** Nodes in each factorial group, inside both genes' samples. */
  groups: { both: number; firstOnly: number; secondOnly: number; neither: number }
  /** Units all four groups scored. */
  units: number
  method: SearchEstimateMethod
  /** Mean per-unit `(both - firstOnly) - (secondOnly - neither)` in the
   * metric's units; null below 2 units. */
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
  /** The resource to add to `profile.resources.skills`; `improve({ surface:
   * 'skills', skills: { resourceName: resource.name }, method: officialSkillOpt(...) })`
   * in agent-runtime then optimizes it. */
  resource: AgentProfileResourceRef
  /** The linked insert genes the skill holds, in their order in the artifact. */
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
  /** Genes this node carries, among those whose sample it belongs to. */
  carries: string[]
  contentKnown: boolean
}

export interface EditCreditData {
  split: SearchSplit
  direction: 'maximize' | 'minimize'
  edges: {
    /** Lineage edges with at least one parent in this search. */
    lineage: number
    /** Of those, edges whose parent and child content were both known. */
    read: number
    /** Why an edge's content was unknown, with counts. */
    unknown: Record<string, number>
  }
  nodes: { total: number; contentUnknown: number; invalid: number }
  /** Reusable, harmful, unresolved, then insufficient; within each, by credit. */
  genes: EditGene[]
  counts: Record<EditGeneVerdict, number>
  interactions: {
    genesConsidered: number
    /** Pairs whose four factorial groups each held a node. */
    pairsWithAllGroups: number
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
    unit: string
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

type NodeContent =
  | { known: true; paths: Map<string, PathText>; haystacks: Map<string, string> }
  | { known: false; reason: string }

interface GeneRecord {
  geneId: string
  kind: 'insert' | 'delete'
  path: string
  lines: string[]
  needle: string
  text: string
  births: EditGene['births']
  proposals: number
  /** Order of the first birth, then position in the artifact. */
  order: [number, number]
  birthParents: Set<string>
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
  const interactionGenes = options.interactionGenes ?? DEFAULT_INTERACTION_GENES
  if (!Number.isSafeInteger(interactionGenes) || interactionGenes < 0) {
    throw new Error(`editCredit: interactionGenes must be a non-negative integer`)
  }

  const nodes = state.nodes()
  const byId = new Map(nodes.map((node) => [node.nodeId, node]))
  const contents = new Map<string, NodeContent>()
  for (const node of nodes) contents.set(node.nodeId, nodeContent(options, node.artifact))
  const invalid = new Set(nodes.filter((node) => node.status === 'invalid').map((n) => n.nodeId))

  // Genes: every edge whose parents precede the child, in ledger order.
  const genes = new Map<string, GeneRecord>()
  const unknownEdges: Record<string, number> = {}
  let lineageEdges = 0
  let readEdges = 0
  for (const edge of state.edges()) {
    const child = byId.get(edge.childNodeId)!
    const parents = lineageParents(state, edge, child, byId)
    if (parents.length === 0) continue
    lineageEdges += 1
    const childContent = contents.get(child.nodeId)!
    const unknownParent = parents
      .map((parentId) => contents.get(parentId)!)
      .find((content) => !content.known)
    const missing = !childContent.known ? childContent : unknownParent
    if (missing && !missing.known) {
      unknownEdges[missing.reason] = (unknownEdges[missing.reason] ?? 0) + 1
      continue
    }
    if (!childContent.known) continue
    readEdges += 1
    const isBirth = child.edgeIds[0] === edge.edgeId
    const proposed = new Map<string, Omit<GeneRecord, 'births' | 'proposals' | 'birthParents'>>()
    for (const parentId of parents) {
      const parentContent = contents.get(parentId)!
      if (!parentContent.known) continue
      for (const gene of edgeGenes(parentContent, childContent, child.ordinal)) {
        if (!proposed.has(gene.geneId)) proposed.set(gene.geneId, gene)
      }
    }
    for (const gene of proposed.values()) {
      // A merge child that took the edit from another parent inherited it; a
      // deletion of one copy of a repeated block leaves the child without it.
      if (!carries(childContent, gene)) continue
      if (parents.some((parentId) => carries(contents.get(parentId)!, gene))) continue
      let record = genes.get(gene.geneId)
      if (!record) {
        record = { ...gene, births: [], proposals: 0, birthParents: new Set() }
        genes.set(gene.geneId, record)
      }
      record.proposals += 1
      if (isBirth && !record.births.some((birth) => birth.nodeId === child.nodeId)) {
        record.births.push({
          nodeId: child.nodeId,
          edgeId: edge.edgeId,
          operator: edge.operator,
          parents,
        })
        for (const parentId of parents) record.birthParents.add(parentId)
      }
    }
  }
  // A gene seen only on re-proposal edges was never born into the lineage.
  for (const [geneId, record] of genes) if (record.births.length === 0) genes.delete(geneId)

  // Samples and carriers.
  const cellsOf = memo((nodeId: string) => state.scoredCells(nodeId, split))
  const subtreeOf = memo((nodeId: string) => subtree(nodeId, byId))
  const carried = new Map<string, Set<string>>()
  const analyzed: Array<{
    record: GeneRecord
    sample: string[]
    carrierIds: string[]
    lackingIds: string[]
    invalidCarriers: number
    unknownContent: number
    credit: NodeEstimate
  }> = []
  for (const record of genes.values()) {
    const scope = new Set<string>()
    for (const parentId of record.birthParents) for (const id of subtreeOf(parentId)) scope.add(id)
    const sample: string[] = []
    const carrierIds: string[] = []
    const lackingIds: string[] = []
    let invalidCarriers = 0
    let unknownContent = 0
    for (const nodeId of [...scope].sort(byOrdinal(byId))) {
      const content = contents.get(nodeId)!
      if (!content.known) {
        unknownContent += 1
        continue
      }
      const has = carries(content, record)
      if (has) {
        const set = carried.get(nodeId) ?? new Set<string>()
        set.add(record.geneId)
        carried.set(nodeId, set)
      }
      if (invalid.has(nodeId)) {
        if (has) invalidCarriers += 1
        continue
      }
      sample.push(nodeId)
      if (has) carrierIds.push(nodeId)
      else lackingIds.push(nodeId)
    }
    const credit = estimateNodeFromCells({
      nodeId: `${record.geneId}:carriers`,
      against: `${record.geneId}:lacking`,
      split,
      direction,
      nodeCells: carrierIds.flatMap(cellsOf),
      againstCells: lackingIds.flatMap(cellsOf),
    })
    analyzed.push({
      record,
      sample,
      carrierIds,
      lackingIds,
      invalidCarriers,
      unknownContent,
      credit,
    })
  }

  // Linkage: identical carriers inside an identical sample.
  const linkageKey = (entry: (typeof analyzed)[number]) =>
    canonicalString([entry.sample, entry.carrierIds])
  const linkGroups = new Map<string, string[]>()
  for (const entry of analyzed) {
    const key = linkageKey(entry)
    linkGroups.set(key, [...(linkGroups.get(key) ?? []), entry.record.geneId])
  }

  const sign = direction === 'maximize' ? 1 : -1
  const geneList: EditGene[] = analyzed.map((entry) => {
    const group = linkGroups.get(linkageKey(entry))!
    return {
      geneId: entry.record.geneId,
      kind: entry.record.kind,
      path: entry.record.path,
      lines: entry.record.lines,
      text: entry.record.text,
      births: entry.record.births,
      proposals: entry.record.proposals,
      population: entry.sample.length,
      carriers: entry.carrierIds.length,
      lacking: entry.lackingIds.length,
      invalidCarriers: entry.invalidCarriers,
      unknownContent: entry.unknownContent,
      credit: entry.credit,
      verdict: verdictOf(entry.credit, sign),
      linkage: group.length > 1 ? group[0]! : null,
    }
  })
  const recordOf = new Map(analyzed.map((entry) => [entry.record.geneId, entry]))
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
      compareOrder(recordOf.get(a.geneId)!.record.order, recordOf.get(b.geneId)!.record.order),
  )
  const counts: Record<EditGeneVerdict, number> = {
    reusable: 0,
    harmful: 0,
    unresolved: 0,
    insufficient: 0,
  }
  for (const gene of geneList) counts[gene.verdict] += 1

  const interactions = interactionPairs({
    genes: geneList,
    entries: recordOf,
    cellsOf,
    limit: interactionGenes,
    sign,
  })
  const skillCandidates = skills(geneList, recordOf, header.subject, split)
  const lineage = lineageRows(state, nodes, byId, contents, carried)

  const measured = geneList.filter(
    (gene) => gene.credit.method === 'descriptive' || gene.credit.method === 'bootstrap',
  ).length
  const signal =
    measured === 0
      ? {
          name: EDIT_CREDIT_SIGNAL,
          value: null,
          basis: `insufficient: no gene has ${DESCRIPTIVE_FROM} ${split} units scored by both carriers and non-carriers (${geneList.length} genes)`,
        }
      : {
          name: EDIT_CREDIT_SIGNAL,
          value: counts.reusable,
          basis: `genes whose credit interval on the ${split} split lies above zero, of ${measured} with ${DESCRIPTIVE_FROM} or more units`,
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
      nodes: {
        total: nodes.length,
        contentUnknown: [...contents.values()].filter((content) => !content.known).length,
        invalid: invalid.size,
      },
      genes: geneList,
      counts,
      interactions,
      skillCandidates,
      lineage,
      method: {
        unit: "a group's mean on a unit pools the scored cells of its nodes there, so a node with more repeats weighs more; unscored cells are absent, never zero",
        credit: `estimateNodeFromCells of carriers against non-carriers inside the birth parents' subtrees, paired on the units both scored: none below 2 units, insufficient below ${DESCRIPTIVE_FROM}, a descriptive bootstrap interval below ${BOOTSTRAP_GATE_MIN_N}, a decision-grade bootstrap from ${BOOTSTRAP_GATE_MIN_N}; observational, because carriers also share what they inherited`,
        verdict:
          'reusable: the credit interval lies wholly on the better side of zero; harmful: wholly on the worse side; unresolved: an interval that spans zero or an indeterminate sample; insufficient: fewer than 6 units',
        interaction: `per unit all four groups scored, (both - firstOnly) - (secondOnly - neither); ${Math.round(CONFIDENCE * 100)}% percentile bootstrap (${RESAMPLES} resamples) for spread; exact two-sided sign test, Holm-adjusted over the pairs tested, flagged at ${INTERACTION_ALPHA}`,
        multiplicity:
          'credit is not adjusted for the number of genes: it steers which edits to test next, as selection estimates steer spend; interaction flags are Holm-adjusted because pairs grow with the square of the genes',
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
  content: NodeContent,
  gene: { kind: 'insert' | 'delete'; path: string; needle: string },
): boolean {
  if (!content.known) return false
  const present = content.haystacks.get(gene.path)?.includes(gene.needle) ?? false
  return gene.kind === 'insert' ? present : !present
}

// ---------------------------------------------------------------------------
// Genes

function edgeGenes(
  parent: Extract<NodeContent, { known: true }>,
  child: Extract<NodeContent, { known: true }>,
  childOrdinal: number,
): Array<Omit<GeneRecord, 'births' | 'proposals' | 'birthParents'>> {
  const genes: Array<Omit<GeneRecord, 'births' | 'proposals' | 'birthParents'>> = []
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
          const digest = hashCanonical({ kind, path, lines })
          genes.push({
            geneId: `gene_${digest.slice('sha256:'.length, 'sha256:'.length + 24)}`,
            kind,
            path,
            lines,
            needle: `\n${lines.join('\n')}\n`,
            text: side.raw.slice(from, to).join('\n').trim(),
            order: [childOrdinal, position++],
          })
        }
      }
    }
  }
  return genes
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
export function changeRuns(a: readonly string[], b: readonly string[]): ChangeRun[] {
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

function subtree(nodeId: string, byId: ReadonlyMap<string, SearchNode>): string[] {
  const seen = new Set<string>([nodeId])
  const stack = [nodeId]
  while (stack.length > 0) {
    for (const child of byId.get(stack.pop()!)?.children ?? []) {
      if (!seen.has(child)) {
        seen.add(child)
        stack.push(child)
      }
    }
  }
  return [...seen]
}

function lineageRows(
  state: SearchStateView,
  nodes: readonly SearchNode[],
  byId: ReadonlyMap<string, SearchNode>,
  contents: ReadonlyMap<string, NodeContent>,
  carried: ReadonlyMap<string, Set<string>>,
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

function verdictOf(credit: NodeEstimate, sign: number): EditGeneVerdict {
  if (credit.method === 'none' || credit.method === 'insufficient') return 'insufficient'
  if (credit.indeterminate || credit.interval === null) return 'unresolved'
  const [low, high] = credit.interval
  const better = sign > 0 ? low > 0 : high < 0
  const worse = sign > 0 ? high < 0 : low > 0
  return better ? 'reusable' : worse ? 'harmful' : 'unresolved'
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
  entries: ReadonlyMap<
    string,
    { record: GeneRecord; sample: string[]; carrierIds: string[]; lackingIds: string[] }
  >
  cellsOf: (nodeId: string) => SearchScoredCell[]
  limit: number
  sign: number
}): EditCreditData['interactions'] {
  // One member per linkage group: linked genes have the same carriers, so
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
  const unitSums = new Map<string, Map<string, { sum: number; count: number }>>()
  const unitsOf = (nodeId: string) => {
    let units = unitSums.get(nodeId)
    if (!units) {
      units = new Map()
      for (const cell of input.cellsOf(nodeId)) {
        const unit = units.get(cell.unitId) ?? { sum: 0, count: 0 }
        unit.sum += cell.score
        unit.count += 1
        units.set(cell.unitId, unit)
      }
      unitSums.set(nodeId, units)
    }
    return units
  }
  const groupMeans = (nodeIds: readonly string[]) => {
    const pooled = new Map<string, { sum: number; count: number }>()
    for (const nodeId of [...nodeIds].sort(compareCodeUnits)) {
      for (const [unitId, unit] of unitsOf(nodeId)) {
        const entry = pooled.get(unitId) ?? { sum: 0, count: 0 }
        entry.sum += unit.sum
        entry.count += unit.count
        pooled.set(unitId, entry)
      }
    }
    return new Map([...pooled].map(([unitId, entry]) => [unitId, entry.sum / entry.count]))
  }

  const pairs: EditInteraction[] = []
  for (let i = 0; i < considered.length; i++) {
    for (let j = i + 1; j < considered.length; j++) {
      const first = input.entries.get(considered[i]!.geneId)!
      const second = input.entries.get(considered[j]!.geneId)!
      const inSecond = new Set(second.sample)
      const shared = first.sample.filter((nodeId) => inSecond.has(nodeId))
      const firstCarriers = new Set(first.carrierIds)
      const secondCarriers = new Set(second.carrierIds)
      const groups = {
        both: [] as string[],
        firstOnly: [] as string[],
        secondOnly: [] as string[],
        neither: [] as string[],
      }
      for (const nodeId of shared) {
        const a = firstCarriers.has(nodeId)
        const b = secondCarriers.has(nodeId)
        groups[a && b ? 'both' : a ? 'firstOnly' : b ? 'secondOnly' : 'neither'].push(nodeId)
      }
      if (Object.values(groups).some((group) => group.length === 0)) continue
      const means = {
        both: groupMeans(groups.both),
        firstOnly: groupMeans(groups.firstOnly),
        secondOnly: groupMeans(groups.secondOnly),
        neither: groupMeans(groups.neither),
      }
      const before: number[] = []
      const after: number[] = []
      for (const unitId of [...means.both.keys()].sort(compareCodeUnits)) {
        const f = means.firstOnly.get(unitId)
        const s = means.secondOnly.get(unitId)
        const n = means.neither.get(unitId)
        if (f === undefined || s === undefined || n === undefined) continue
        before.push(f + s)
        after.push(means.both.get(unitId)! + n)
      }
      pairs.push(
        interactionEstimate(
          [first.record.geneId, second.record.geneId],
          {
            both: groups.both.length,
            firstOnly: groups.firstOnly.length,
            secondOnly: groups.secondOnly.length,
            neither: groups.neither.length,
          },
          before,
          after,
          input.sign,
        ),
      )
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
    pairsWithAllGroups: pairs.length,
    pairsTested: tested.length,
    alpha: INTERACTION_ALPHA,
    correction: 'holm',
    pairs,
  }
}

function interactionEstimate(
  genes: [string, string],
  groups: EditInteraction['groups'],
  before: number[],
  after: number[],
  sign: number,
): EditInteraction {
  const units = before.length
  const method: SearchEstimateMethod =
    units < 2
      ? 'none'
      : units < DESCRIPTIVE_FROM
        ? 'insufficient'
        : units < BOOTSTRAP_GATE_MIN_N
          ? 'descriptive'
          : 'bootstrap'
  const contrasts = after.map((value, index) => value - before[index]!)
  const base = { genes, groups, units, method, adjustedP: null, interacting: false }
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
  const interaction = plain(contrasts.reduce((sum, value) => sum + value, 0) / units)
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
  const test = pairedDeltaTest(before, after, {
    statistic: DECISION_PAIRED_DELTA_STATISTIC,
    confidence: CONFIDENCE,
    resamples: RESAMPLES,
    seed: seedFromDigest(hashCanonical({ genes, before, after })),
  })
  const indeterminate = test.indeterminate
  const greater = pairedSignTest(contrasts, 'greater').pValue
  const less = pairedSignTest(contrasts, 'less').pValue
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
  entries: ReadonlyMap<string, { record: GeneRecord }>,
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
    members.sort((a, b) =>
      compareOrder(entries.get(a.geneId)!.record.order, entries.get(b.geneId)!.record.order),
    )
    const lead = members[0]!
    const name = `edit-${lead.geneId.slice('gene_'.length, 'gene_'.length + 12)}`
    const content = [
      '---',
      `name: ${name}`,
      `description: ${JSON.stringify(
        `Instructions a ${subject} search kept: the edit to ${lead.path} that its carriers scored better with on the ${split} split.`,
      )}`,
      '---',
      '',
      members.map((gene) => gene.text).join('\n\n'),
      '',
    ].join('\n')
    candidates.push({
      resource: defineInlineResource(name, content),
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
    `edit credit — ${data.genes.length} genes from ${data.edges.read} of ${data.edges.lineage} lineage edges (${data.split} split, ${data.direction})`,
    `  reusable ${data.counts.reusable} · harmful ${data.counts.harmful} · unresolved ${data.counts.unresolved} · insufficient ${data.counts.insufficient}`,
    `  signal ${signal.name} = ${signal.value ?? 'null'} (${signal.basis})`,
  ]
  if (unknown.length > 0) lines.push(`  edges without content: ${unknown}`)
  if (data.nodes.invalid > 0) {
    lines.push(`  ${data.nodes.invalid} invalid node(s) excluded from every credit`)
  }
  lines.push('', 'Genes (carriers vs non-carriers in the birth parents’ subtrees):')
  if (data.genes.length === 0) lines.push('  none')
  for (const gene of data.genes.slice(0, limit)) {
    const reproposed = gene.proposals > gene.births.length ? ` · proposed ${gene.proposals}×` : ''
    const linked =
      gene.linkage && gene.linkage !== gene.geneId ? ` · linked to ${gene.linkage}` : ''
    const invalid = gene.invalidCarriers > 0 ? ` · ${gene.invalidCarriers} invalid carrier(s)` : ''
    lines.push(
      `  ${gene.geneId} ${gene.verdict} ${gene.kind} ${gene.path} "${excerpt(gene.lines)}"`,
      `    ${gene.carriers} carriers / ${gene.lacking} not · ${formatEstimate(gene.credit)}${reproposed}${linked}${invalid}`,
    )
  }
  if (data.genes.length > limit) lines.push(`  … ${data.genes.length - limit} more`)
  const { interactions } = data
  lines.push(
    '',
    `Interactions: ${interactions.pairsTested} pair(s) tested of ${interactions.pairsWithAllGroups} with all four groups, among ${interactions.genesConsidered} genes (Holm, α=${interactions.alpha}):`,
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
      `  ${candidate.resource.name ?? '(unnamed)'}: ${candidate.genes.length} gene(s) at ${candidate.path} · ${formatEstimate(candidate.credit)}`,
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

function byOrdinal(byId: ReadonlyMap<string, SearchNode>) {
  return (left: string, right: string) => byId.get(left)!.ordinal - byId.get(right)!.ordinal
}

function compareOrder(left: [number, number], right: [number, number]): number {
  return left[0] - right[0] || left[1] - right[1]
}

/** Canonical JSON has one zero; never hand it a negative one. */
function plain(value: number): number {
  return value === 0 ? 0 : value
}
