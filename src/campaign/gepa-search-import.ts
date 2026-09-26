/**
 * Import an external optimizer's own record into a search ledger.
 *
 * GEPA and SkillOpt search inside their own processes. The evaluation
 * callback's observation log holds every candidate either one evaluated, and
 * GEPA's candidate population also names each candidate's parents by index.
 * The importer turns both into ledger events: one node per distinct candidate,
 * one `correlated` edge per population entry (joined by content digest from
 * GEPA's own parent record), and one cell per evaluation. Nothing is inferred
 * from timing or order: a candidate with no parent record (every SkillOpt
 * candidate, and a candidate GEPA kept out of its population) has an `unknown`
 * edge and no parents.
 */

import { hashCanonical } from '../ledger-core/canonical'
import type { ExternalTextCandidate } from './external-optimizer-contracts'
import type { ExternalOptimizerObservationArtifact } from './external-optimizer-observations'
import type {
  GepaCandidatePopulationArtifact,
  GepaCandidatePopulationCandidate,
} from './gepa-candidate-population'
import type { SearchHistoryReceipt } from './search-history-receipt'
import { openSearchLedger } from './search-ledger'
import {
  developmentClaim,
  type RegisterSearchNodeInput,
  SearchRecorder,
  type SearchRunIdentity,
  surfaceDiff,
  surfaceNode,
} from './search-ledger-recording'
import type {
  SearchArtifactRef,
  SearchAttemptAccounting,
  SearchExecutionIdentity,
  SearchProposer,
  SearchSplit,
  SearchTask,
  SearchTaskOutcome,
  SearchUnknown,
} from './search-ledger-types'
import type { CampaignStorage } from './storage'
import type { MutableSurface, Scenario } from './types'

/** The external optimizers whose searches this module records. */
export type ExternalSearchOptimizer = 'GEPA' | 'SkillOpt'

function noRationale(optimizer: ExternalSearchOptimizer): SearchUnknown {
  return {
    unknown: `${optimizer} records no rationale per candidate; its reflection attaches to the proposer operation`,
  }
}

const NO_GEPA_RATIONALE = noRationale('GEPA')

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
 * minibatch and discarded it, or SkillOpt, which reports no parents, proposed
 * it) is registered with an `unknown` edge.
 */
export async function importExternalEvaluations(input: {
  recorder: SearchRecorder
  observations: ExternalOptimizerObservationArtifact
  proposer: SearchProposer
  identity: SearchExecutionIdentity
  /** The split each evaluated example belongs to. */
  splitOf: (exampleId: string) => SearchSplit
  /** The optimizer that proposed the candidates. Default GEPA. */
  optimizer?: ExternalSearchOptimizer
}): Promise<GepaEvaluationImport> {
  const { recorder } = input
  const optimizer = input.optimizer ?? 'GEPA'
  const reps = new Map<string, number>()
  const unrecorded: string[] = []
  let cells = 0
  for (const observation of input.observations.observations) {
    // A failed evaluation is logged as a refusal, but it ran and consumed an
    // evaluation, so it is an unscored cell. Other refusals never ran.
    const ran =
      observation.kind === 'evaluation' ||
      (observation.kind === 'refusal' && observation.reason === 'evaluation-failed')
    if (!ran || observation.candidate === undefined || observation.exampleId === undefined) continue
    const candidateHash = observation.candidateHash!
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
        proposalKey: `${optimizer.toLowerCase()}-evaluated:${candidateHash}`,
        rationale: noRationale(optimizer),
        diffs: [],
        label:
          optimizer === 'GEPA'
            ? 'GEPA proposal outside its population'
            : `${optimizer} proposal without a parent record`,
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
      outcome:
        observation.kind === 'evaluation'
          ? evaluationOutcome(observation.response)
          : {
              status: 'errored',
              metrics: {},
              error: {
                code: 'evaluation-failed',
                message: 'the evaluation callback failed before a score',
                retryable: false,
              },
            },
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

/** What `recordGepaSearch` and `recordSkillOptSearch` share. */
interface ExternalSearchRecordInput {
  name: string
  path: string
  searchId: string
  identity: SearchRunIdentity
  storage: CampaignStorage
  seed: number
  baselineSurface: MutableSurface
  trainScenarios: readonly Scenario[]
  selectionScenarios: readonly Scenario[]
  evaluationLimit: number
  observations: ExternalOptimizerObservationArtifact
  generationAccounting: SearchAttemptAccounting
}

/**
 * Write GEPA's finished search into its ledger: the baseline as the seeded
 * root, the population as nodes with `correlated` edges, every callback
 * evaluation as an `external` cell, GEPA's proposer spend as one operation,
 * GEPA's choice as the selected node, and the close. GEPA's own selection is a
 * budget decision, so the ledger carries no claim; the final comparison runs
 * outside this search.
 */
export async function recordGepaSearch(
  input: ExternalSearchRecordInput & { population: GepaCandidatePopulationArtifact },
): Promise<SearchHistoryReceipt> {
  const best = input.population.candidates.find(
    (candidate) => candidate.index === input.population.bestIndex,
  )
  if (!best) {
    throw new Error(
      `GEPA candidate population has no bestIndex entry ${input.population.bestIndex}`,
    )
  }
  return recordExternalSearch({
    ...input,
    optimizer: 'GEPA',
    selected: externalSurface(best.candidate),
  })
}

/**
 * Write SkillOpt's finished search into its ledger: the baseline as the seeded
 * root, every candidate SkillOpt evaluated as a node with an `unknown` edge
 * (SkillOpt reports no parents), every callback evaluation as an `external`
 * cell, SkillOpt's optimizer spend as one operation, SkillOpt's choice as the
 * selected node, and the close. Like GEPA's, the ledger carries no claim.
 */
export async function recordSkillOptSearch(
  input: ExternalSearchRecordInput & { selected: MutableSurface },
): Promise<SearchHistoryReceipt> {
  return recordExternalSearch({ ...input, optimizer: 'SkillOpt', population: null })
}

async function recordExternalSearch(
  input: ExternalSearchRecordInput & {
    optimizer: ExternalSearchOptimizer
    population: GepaCandidatePopulationArtifact | null
    /** The surface the optimizer chose. */
    selected: MutableSurface
  },
): Promise<SearchHistoryReceipt> {
  const { identity, population, optimizer } = input
  const policyName = optimizer.toLowerCase()
  const tasks = (scenarios: readonly Scenario[]): SearchTask[] =>
    scenarios.map((scenario) => ({
      taskId: scenario.id,
      unitId: scenario.id,
      source: { uri: `scenario://${scenario.id}`, revision: hashCanonical(scenario) },
    }))
  const train = tasks(input.trainScenarios)
  const selection = tasks(input.selectionScenarios)
  const taskSet = hashCanonical({ train, selection })
  const recorder = await SearchRecorder.open(
    {
      ledger: openSearchLedger({ path: input.path, searchId: input.searchId }),
      storage: input.storage,
    },
    {
      subject: identity.subject ?? input.name,
      process: { name: input.name, executionRef: identity.search },
      artifactKind: 'prompt',
      objective: {
        metric: 'score',
        direction: 'maximize',
        judge: identity.judge ?? {
          unknown:
            'the evaluation callback judges through caller functions without a pinned source',
        },
        claim: identity.claim ?? developmentClaim(taskSet),
      },
      splits: { train, selection, test: [], heldOutUnits: true },
      policy: { expansion: policyName, allocation: policyName, seed: input.seed },
      budget: {
        maxUsd: null,
        maxCells: input.evaluationLimit,
        maxNodes: null,
        deadline: null,
        maxConcurrency: null,
        reservedClaimUsd: 0,
      },
      containment: null,
      derivedFrom: null,
      identity: {
        model: identity.model,
        agent: identity.agent,
        benchmark: { uri: `optimizer://${input.name}`, revision: taskSet },
      },
    },
  )
  const root = await recorder.registerNode(surfaceNode(recorder, input.baselineSurface))
  await recorder.recordEdge({
    childNodeId: root.nodeId,
    parents: [],
    operator: 'seed',
    attribution: 'explicit',
    proposer: null,
    proposalKey: 'baseline',
    rationale: { unknown: 'the baseline is the caller-supplied starting surface' },
    diffs: [],
    label: 'baseline',
  })
  const operationId = `${policyName}-proposals`
  await recorder.startOperation({ operationId, operationKind: 'candidate-generation' })
  const proposer = {
    kind: 'optimizer' as const,
    name: input.name,
    operationId,
    source: identity.proposer.source,
  }
  if (population) await importGepaPopulation({ recorder, population, proposer })
  const trainIds = new Set(train.map((task) => task.taskId))
  const evaluations = await importExternalEvaluations({
    recorder,
    observations: input.observations,
    proposer,
    identity: {
      model: identity.model,
      agent: identity.agent,
      benchmark: { uri: `optimizer://${input.name}`, revision: taskSet },
    },
    splitOf: (exampleId) => (trainIds.has(exampleId) ? 'train' : 'selection'),
    optimizer,
  })
  // The optimizer's choice is a node unless no evaluation ever reached it.
  const chosen = await recorder.registerNode(surfaceNode(recorder, input.selected))
  if (((await recorder.state()).node(chosen.nodeId)?.edgeIds.length ?? 0) === 0) {
    await recorder.recordEdge({
      childNodeId: chosen.nodeId,
      parents: [],
      operator: 'improve',
      attribution: 'unknown',
      proposer,
      proposalKey: `${policyName}-selected`,
      rationale: noRationale(optimizer),
      diffs: [],
      label: `${optimizer} choice without an evaluation`,
    })
  }
  await recorder.recordOperation({
    operationId,
    operationKind: 'candidate-generation',
    execution: identity.proposer,
    outcome: { status: 'completed' },
    accounting: input.generationAccounting,
  })
  // Read everything the decisions need before the first decision moves the ledger.
  const state = await recorder.state()
  const nodes = state.nodes()
  const best = chosen.nodeId
  const bestScored = state.cells({ nodeId: best }).some((cell) => cell.score !== null)
  // GEPA chooses by its aggregate selection score; SkillOpt by its own validation.
  const rule = population ? 'gepa-best-aggregate' : `${policyName}-choice`
  const basis = population ? 'its aggregate selection score' : 'its own validation'
  for (const node of nodes) {
    if (node.nodeId === best && bestScored) {
      await recorder.decideNode({
        nodeId: node.nodeId,
        decision: { status: 'selected' },
        rule,
        reason: `${optimizer} chose this candidate by ${basis}`,
      })
    } else if (population && evaluations.unrecordedParentNodeIds.includes(node.nodeId)) {
      await recorder.decideNode({
        nodeId: node.nodeId,
        decision: { status: 'pruned' },
        rule: 'gepa-population',
        reason: 'GEPA evaluated the candidate and kept it out of its population',
      })
    } else {
      await recorder.decideNode({
        nodeId: node.nodeId,
        decision: node.nodeId === best ? { status: 'invalid' } : { status: 'rejected' },
        rule,
        reason:
          node.nodeId === best
            ? `${optimizer} chose this candidate, but no evaluation of it was scored`
            : `${optimizer} chose another candidate`,
      })
    }
  }
  await recorder.close({ reason: 'budget', claim: null })
  return recorder.receipt({ producerId: input.name, runId: input.searchId })
}
