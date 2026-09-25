/**
 * Import an optimizer's own record into a search ledger.
 *
 * GEPA searches inside its own process. Its candidate population names each
 * candidate's parents by index, and the evaluation callback's observation log
 * holds every candidate it evaluated. The importer turns both into ledger
 * events: one node per distinct candidate, one `correlated` edge per population
 * entry (joined by content digest from GEPA's own parent record), and one cell
 * per evaluation. Nothing is inferred from timing or order: a candidate GEPA
 * evaluated but kept out of its population has no parent record, so its edge
 * is `unknown` and has no parents.
 */

import type { ExternalTextCandidate } from './external-optimizer-contracts'
import type { ExternalOptimizerObservationArtifact } from './external-optimizer-observations'
import type {
  GepaCandidatePopulationArtifact,
  GepaCandidatePopulationCandidate,
} from './gepa-candidate-population'
import {
  type RegisterSearchNodeInput,
  type SearchRecorder,
  surfaceDiff,
  surfaceNode,
} from './search-ledger-recording'
import type {
  SearchArtifactRef,
  SearchExecutionIdentity,
  SearchProposer,
  SearchSplit,
  SearchTaskOutcome,
  SearchUnknown,
} from './search-ledger-types'
import type { MutableSurface } from './types'

const NO_GEPA_RATIONALE: SearchUnknown = {
  unknown:
    'GEPA records no rationale per candidate; its reflection attaches to the proposer operation',
}

export interface GepaPopulationImport {
  /** Population index to node id. */
  nodeIds: ReadonlyMap<number, string>
  /** Distinct nodes the population maps to. */
  nodes: number
  edges: number
  /** Population entries whose content equals an earlier entry's: one node, a second edge. */
  collapsedDuplicates: number
  /** Proposals whose content equals their own parent, which no edge can express. */
  unchangedProposals: number
}

/**
 * Register GEPA's population as nodes and its parent indices as `correlated`
 * edges. A parentless entry (GEPA's seed) gets a seed edge unless its node is
 * already in the tree, for example the root the caller seeded.
 */
export async function importGepaPopulation(input: {
  recorder: SearchRecorder
  population: GepaCandidatePopulationArtifact
  proposer: SearchProposer
  /** How a candidate becomes a node. Default: its text or component surface. */
  node?: (candidate: GepaCandidatePopulationCandidate) => RegisterSearchNodeInput
  /** How a parent-to-child diff is stored. Default: the surface diff. */
  diff?: (
    parent: GepaCandidatePopulationCandidate,
    child: GepaCandidatePopulationCandidate,
  ) => SearchArtifactRef | SearchUnknown
}): Promise<GepaPopulationImport> {
  const { recorder, population } = input
  const node =
    input.node ?? ((candidate) => surfaceNode(recorder, externalSurface(candidate.candidate)))
  const diff =
    input.diff ??
    ((parent, child) =>
      surfaceDiff(recorder, externalSurface(parent.candidate), externalSurface(child.candidate)))
  const nodeIds = new Map<number, string>()
  const byIndex = new Map(population.candidates.map((candidate) => [candidate.index, candidate]))
  const seenNodes = new Set<string>()
  let edges = 0
  let collapsedDuplicates = 0
  let unchangedProposals = 0
  for (const candidate of population.candidates) {
    const { nodeId } = await recorder.registerNode(node(candidate))
    if (seenNodes.has(nodeId)) collapsedDuplicates += 1
    seenNodes.add(nodeId)
    nodeIds.set(candidate.index, nodeId)

    const parentIndices = [
      ...new Set(candidate.parentIndices.filter((index): index is number => index !== null)),
    ]
    const parents: Array<{ nodeId: string; candidate: GepaCandidatePopulationCandidate }> = []
    for (const index of parentIndices) {
      const parentNodeId = nodeIds.get(index)
      const parent = byIndex.get(index)
      if (parentNodeId === undefined || parent === undefined) {
        throw new Error(
          `GEPA candidate ${candidate.index} names parent ${index}, which precedes no population entry`,
        )
      }
      if (parentNodeId === nodeId) continue
      if (!parents.some((known) => known.nodeId === parentNodeId)) {
        parents.push({ nodeId: parentNodeId, candidate: parent })
      }
    }
    if (parentIndices.length > 0 && parents.length === 0) {
      unchangedProposals += 1
      continue
    }
    if (parents.length === 0) {
      const state = await recorder.state()
      if ((state.node(nodeId)?.edgeIds.length ?? 0) > 0) continue
      await recorder.recordEdge({
        childNodeId: nodeId,
        parents: [],
        operator: 'seed',
        attribution: 'correlated',
        proposer: null,
        proposalKey: `gepa:${population.runId}:${candidate.index}`,
        rationale: NO_GEPA_RATIONALE,
        diffs: [],
        label: `GEPA seed candidate ${candidate.index}`,
      })
      edges += 1
      continue
    }
    await recorder.recordEdge({
      childNodeId: nodeId,
      parents: parents.map((parent) => parent.nodeId),
      operator: parents.length > 1 ? 'merge' : 'improve',
      attribution: 'correlated',
      proposer: input.proposer,
      proposalKey: `gepa:${population.runId}:${candidate.index}`,
      rationale: NO_GEPA_RATIONALE,
      diffs: parents.map((parent) => diff(parent.candidate, candidate)),
      label: `GEPA candidate ${candidate.index}`,
    })
    edges += 1
  }
  return { nodeIds, nodes: seenNodes.size, edges, collapsedDuplicates, unchangedProposals }
}

export interface GepaEvaluationImport {
  cells: number
  /** Nodes of candidates GEPA evaluated but kept out of its population. */
  unrecordedParentNodeIds: string[]
}

/**
 * Record every evaluation in the callback's observation log as an `external`
 * cell attempt. A candidate that is not yet a node (GEPA evaluated it on a
 * minibatch and discarded it) is registered with an `unknown` edge.
 */
export async function importExternalEvaluations(input: {
  recorder: SearchRecorder
  observations: ExternalOptimizerObservationArtifact
  proposer: SearchProposer
  identity: SearchExecutionIdentity
  /** The split each evaluated example belongs to. */
  splitOf: (exampleId: string) => SearchSplit
}): Promise<GepaEvaluationImport> {
  const { recorder } = input
  const reps = new Map<string, number>()
  const unrecorded: string[] = []
  let cells = 0
  for (const observation of input.observations.observations) {
    if (observation.kind !== 'evaluation') continue
    const surface = externalSurface(observation.candidate)
    const registered = await recorder.registerNode(surfaceNode(recorder, surface))
    const state = await recorder.state()
    if ((state.node(registered.nodeId)?.edgeIds.length ?? 0) === 0) {
      await recorder.recordEdge({
        childNodeId: registered.nodeId,
        parents: [],
        operator: 'improve',
        attribution: 'unknown',
        proposer: input.proposer,
        proposalKey: `gepa-evaluated:${observation.candidateHash}`,
        rationale: NO_GEPA_RATIONALE,
        diffs: [],
        label: 'GEPA proposal outside its population',
      })
      unrecorded.push(registered.nodeId)
    }
    const split = input.splitOf(observation.exampleId)
    const repKey = `${registered.nodeId}\u0000${observation.exampleId}`
    const rep = reps.get(repKey) ?? 0
    reps.set(repKey, rep + 1)
    const cellId = await recorder.allocateCell({
      nodeId: registered.nodeId,
      taskId: observation.exampleId,
      split,
      rep,
      stage: 'external',
    })
    await recorder.settleCell({
      cellId,
      attempt: 1,
      outcome: evaluationOutcome(observation.response),
      accounting: {
        tokens: { status: 'unknown', reason: 'the evaluation callback meters tokens per run' },
        cost: {
          status: 'unknown',
          knownLowerBoundUsd: 0,
          reason: 'the evaluation callback meters cost per run, not per evaluation',
        },
      },
      identity: input.identity,
    })
    cells += 1
  }
  return { cells, unrecordedParentNodeIds: unrecorded }
}

/** GEPA's callback response. A `failed` evaluation carries a penalty score for
 * the optimizer that is not a measurement, so the cell is unscored. */
function evaluationOutcome(response: unknown): SearchTaskOutcome {
  const record = (response ?? {}) as {
    score?: unknown
    info?: { status?: unknown; notes?: unknown }
  }
  if (
    record.info?.status === 'scored' &&
    typeof record.score === 'number' &&
    Number.isFinite(record.score)
  ) {
    return { status: 'passed', score: record.score, metrics: { score: record.score } }
  }
  return {
    status: 'errored',
    metrics: {},
    error: {
      code: 'evaluation-failed',
      message:
        typeof record.info?.notes === 'string' && record.info.notes.trim().length > 0
          ? record.info.notes.trim()
          : 'the evaluation produced no score',
      retryable: false,
    },
  }
}

/** An optimizer candidate as the mutable surface it represents. */
export function externalSurface(candidate: ExternalTextCandidate): MutableSurface {
  return typeof candidate === 'string' ? candidate : { kind: 'components', components: candidate }
}
