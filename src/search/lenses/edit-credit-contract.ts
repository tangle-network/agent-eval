/** Edit lineage, gene-credit contracts, and the versioned estimator definition. */
import type { AgentProfileResourceRef } from '@tangle-network/agent-interface'
import type {
  NodeEstimate,
  SearchArtifactRef,
  SearchEdgeOperator,
  SearchEstimateMethod,
  SearchSourceRef,
  SearchSplit,
} from '../../campaign/search-ledger-types'
import type { SearchNode } from '../../campaign/search-state'
import { hashCanonical } from '../../ledger-core/canonical'
import { minimumPairsForPairedDeltaTest } from '../../paired-delta-test'
import { BOOTSTRAP_GATE_MIN_N, DECISION_PAIRED_DELTA_STATISTIC } from '../../statistics'
import type { LensResult, LensSignal } from './shared'

export const CONFIDENCE = 0.95
export const RESAMPLES = 2000
export const DESCRIPTIVE_FROM = minimumPairsForPairedDeltaTest(CONFIDENCE)
export const INTERACTION_ALPHA = 0.05
export const DEFAULT_INTERACTION_GENES = 24
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
  /** Independent edits per verdict: linkage groups, and for genes without a
   * clean step the edit they were born in. */
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
  /** What the reusable count would be with no true effect anywhere: credit is
   * not adjusted for the number of edits, so read `reusable` against this. */
  chance: {
    /** Independent edits measured on 6 or more units. */
    measuredEdits: number
    /** Sum over measured edits of the chance the verdict calls one reusable
     * when it has no effect. */
    expectedReusable: number
    method: string
  }
  /** Rows in lineage order (depth-first along primary parents): the matrix a
   * genealogy view draws, genes as columns. */
  lineage: EditLineageRow[]
  method: {
    estimator: SearchSourceRef
    credit: string
    verdict: string
    interaction: string
    multiplicity: string
    /** The known bias of a lineage contrast in a search. */
    selectionBias: string
  }
}

/** The signal: independent edits `pairedDeltaTest` finds improve the
 * objective, null below 6 units on every gene. */
export interface EditCreditSignal extends LensSignal<number | null> {
  /** How the value was computed, or why it is null. */
  basis: string
  /** The first gene of each reusable edit, best first: the hunks a proposer
   * reuses or a skill extraction starts from. */
  top: string[]
}

export type EditCreditResult = LensResult<EditCreditData, number | null> & {
  signal: EditCreditSignal
}

export interface PathText {
  raw: string[]
  norm: string[]
}

export type KnownContent = {
  known: true
  paths: Map<string, PathText>
  haystacks: Map<string, string>
}
export type NodeContent = KnownContent | { known: false; reason: string }

export interface GeneCut {
  kind: 'insert' | 'delete'
  path: string
  lines: string[]
  needle: string
  text: string
  /** Position in the child's diff: artifact order. */
  position: number
}

export interface GeneRecord extends GeneCut {
  geneId: string
  locus: string
  introduced: EditIntroduction[]
  dropped: number
  /** Ledger order of the first introduction, then position in the artifact. */
  order: [number, number]
}

export interface Step {
  key: string
  parentId: string
  childId: string
  /** Genes whose carrying differs between parent and child. */
  flips: Set<string>
}
