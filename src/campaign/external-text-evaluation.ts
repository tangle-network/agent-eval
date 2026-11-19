import type { CostLedgerHandle } from '../cost-ledger'
import {
  assertJsonValue,
  type ExternalEvaluationMeasurement,
  type ExternalTextCandidate,
  type ExternalTextEvaluationRequest,
  isCandidateText,
  safePathComponent,
} from './external-optimizer-process'
import type { OptimizationMethodInput } from './optimization-method'
import { runCampaign } from './run-campaign'
import {
  campaignBreakdown,
  cellArtifactEvidence,
  type DescribeArtifact,
  evidenceCellByScenario,
} from './score-utils'
import { type CampaignCellMeasurement, campaignCellMeasurement } from './search-campaign-cell'
import { surfaceContentHash } from './surface-identity'
import type { MutableSurface, Scenario } from './types'

export interface ExternalOptimizationExample {
  id: string
  data: unknown
}

export interface ExternalTextEvaluationResponse {
  score: number
  info: {
    scenarioId: string
    dimensions: Record<string, number>
    /** Higher-is-better objectives consumed by GEPA hybrid/Pareto selection. */
    scores?: Record<string, number>
    notes?: string
    artifact?: unknown
    /** The optimizer score is a finite protocol value; Eval remains the
     * authority for whether the underlying cell actually produced a score. */
    status?: 'scored' | 'failed'
    error?: {
      stage: 'dispatch' | 'judge' | 'unknown'
      message: string
    }
  }
}

export function createExternalTextEvaluator<TScenario extends Scenario, TArtifact>(args: {
  input: OptimizationMethodInput<TScenario, TArtifact>
  label: string
  runDir: string
  /** Identity of the exact execution and scoring behavior used by this evaluator. */
  compatibleRunId: string
  costPhase: string
  costTags?: Readonly<Record<string, string>>
  costLedger: CostLedgerHandle
  scenarioById: ReadonlyMap<string, TScenario>
  maxCandidateChars: number
  maxEvidenceChars: number
  describeArtifact?: (artifact: TArtifact, scenario: TScenario) => unknown
}): (
  request: ExternalTextEvaluationRequest,
  signal?: AbortSignal,
  measured?: (measurement: ExternalEvaluationMeasurement) => void,
) => Promise<ExternalTextEvaluationResponse> {
  // One entry per candidate and case: a repeated request is answered from the
  // cells the first request measured, and reports them as reused.
  const cached = new Map<string, Promise<ScoredScenario>>()
  return async ({ candidate, exampleId }, signal, measured) => {
    if (!args.scenarioById.has(exampleId)) {
      throw new Error(`${args.label} requested unknown train or selection case '${exampleId}'`)
    }
    const detachedCandidate = cloneExternalTextCandidate(candidate)
    const surface =
      typeof detachedCandidate === 'string'
        ? detachedCandidate
        : ({ kind: 'components', components: detachedCandidate } as const)
    const candidateLength =
      typeof detachedCandidate === 'string'
        ? detachedCandidate.length
        : JSON.stringify(detachedCandidate).length
    if (
      (typeof detachedCandidate === 'string' &&
        !isCandidateText(detachedCandidate, args.maxCandidateChars)) ||
      candidateLength > args.maxCandidateChars
    ) {
      throw new Error(`${args.label} submitted an invalid candidate`)
    }
    const scenario = args.scenarioById.get(exampleId)!
    const cacheKey = `${args.compatibleRunId}:${surfaceContentHash(surface)}:${exampleId}`
    const existing = cached.get(cacheKey)
    if (existing) {
      const reused = await existing
      measured?.({ source: 'reused', cells: reused.cells })
      return reused.response
    }

    const result = scoreOneScenario({
      input: args.input,
      label: args.label,
      candidate: surface,
      scenario,
      runDir: args.runDir,
      compatibleRunId: args.compatibleRunId,
      costPhase: args.costPhase,
      costTags: args.costTags,
      costLedger: args.costLedger,
      maxEvidenceChars: args.maxEvidenceChars,
      describeArtifact: args.describeArtifact,
      signal,
    })
    cached.set(cacheKey, result)
    void result.then(
      ({ response }) => {
        // Failed cells are durable diagnostics, not reusable scores. Leave
        // the successful path cached, but let a later GEPA request retry the
        // failed or missing cell on resume.
        if (response.info.status === 'failed' && cached.get(cacheKey) === result) {
          cached.delete(cacheKey)
        }
      },
      () => {
        if (cached.get(cacheKey) === result) cached.delete(cacheKey)
      },
    )
    const scored = await result
    measured?.({ source: 'measured', cells: scored.cells })
    return scored.response
  }
}

/** One evaluation's optimizer response and the campaign cells it came from. */
interface ScoredScenario {
  response: ExternalTextEvaluationResponse
  cells: CampaignCellMeasurement[]
}

export function mapExternalScenarios<TScenario extends Scenario>(
  train: readonly TScenario[],
  selection: readonly TScenario[],
  label: string,
): Map<string, TScenario> {
  const out = new Map<string, TScenario>()
  for (const scenario of [...train, ...selection]) {
    if (out.has(scenario.id)) {
      throw new Error(
        `${label} requires unique train and selection ids; duplicate '${scenario.id}'`,
      )
    }
    out.set(scenario.id, scenario)
  }
  return out
}

export function describeExternalScenario<TScenario extends Scenario>(
  scenario: TScenario,
  label: string,
  maxChars: number,
  describe?: (scenario: TScenario) => unknown,
): ExternalOptimizationExample {
  const data = structuredClone(describe ? describe(scenario) : { id: scenario.id })
  assertJsonValue(data, `${label} scenario '${scenario.id}'`)
  const serializedChars = JSON.stringify(data).length
  if (serializedChars > maxChars) {
    throw new Error(
      `${label} scenario '${scenario.id}' exceeds maxEvidenceChars (${serializedChars} > ${maxChars})`,
    )
  }
  return deepFreeze({ id: scenario.id, data })
}

export function encodeExternalTextCandidate(surface: MutableSurface): ExternalTextCandidate {
  if (typeof surface === 'string') return surface
  if (surface.kind === 'components') return { ...surface.components }
  throw new Error('external text optimizers cannot encode a code surface')
}

export function decodeExternalTextCandidate(candidate: ExternalTextCandidate): MutableSurface {
  return typeof candidate === 'string'
    ? candidate
    : { kind: 'components', components: { ...candidate } }
}

async function scoreOneScenario<TScenario extends Scenario, TArtifact>(args: {
  input: OptimizationMethodInput<TScenario, TArtifact>
  label: string
  candidate:
    | string
    | { readonly kind: 'components'; readonly components: Readonly<Record<string, string>> }
  scenario: TScenario
  runDir: string
  compatibleRunId: string
  costPhase: string
  costTags?: Readonly<Record<string, string>>
  costLedger: CostLedgerHandle
  maxEvidenceChars: number
  describeArtifact?: DescribeArtifact<TArtifact, TScenario>
  signal?: AbortSignal
}): Promise<ScoredScenario> {
  const campaign = await runCampaign<TScenario, TArtifact>({
    ...args.input.runOptions,
    scenarios: [structuredClone(args.scenario)],
    dispatch: (scenario, context) =>
      args.input.dispatchWithSurface(args.candidate, scenario, context),
    dispatchRef: `external-text:${args.compatibleRunId}:${surfaceContentHash(args.candidate)}`,
    judges: [...args.input.judges],
    runDir: `${args.runDir}/evaluations/${safePathComponent(args.compatibleRunId)}/${safePathComponent(surfaceContentHash(args.candidate))}/${safePathComponent(args.scenario.id)}`,
    seed: args.input.seed,
    costLedger: args.costLedger,
    costPhase: args.costPhase,
    ...(args.costTags ? { costTags: args.costTags } : {}),
    maxConcurrency: 1,
    ...(args.signal ? { signal: args.signal } : {}),
  })
  const cells = [...campaign.cells]
    .sort((left, right) => left.rep - right.rep)
    .map(campaignCellMeasurement)
  const failedCell = campaign.cells.find((cell) => cell.error !== undefined)
  if (failedCell) {
    const stage = failedCell.errorStage ?? 'unknown'
    const message = failedCell.error?.slice(0, 2_000) ?? 'cell failed without an error message'
    const response: ExternalTextEvaluationResponse = {
      // GEPA requires a finite score for every callback response. This zero is
      // an optimizer penalty only; the campaign cell remains unscored below.
      score: 0,
      info: {
        scenarioId: failedCell.scenarioId,
        dimensions: {},
        status: 'failed',
        notes: `Evaluation failed at ${stage}; optimizer penalty score 0 is not a measured zero. ${message}`,
        error: { stage, message },
      },
    }
    if (JSON.stringify(response).length > args.maxEvidenceChars) {
      throw new Error(
        `${args.label} failed evaluation evidence for '${args.scenario.id}' exceeds maxEvidenceChars`,
      )
    }
    return { response, cells }
  }
  const breakdown = campaignBreakdown(campaign)
  const row = breakdown.scenarios[0]
  if (!row) throw new Error(`${args.label} evaluation produced no score for '${args.scenario.id}'`)
  // The same cell and the same evidence the native reflective path shows,
  // kept as a JSON value so a described artifact may carry inline images.
  const evidenceCell = evidenceCellByScenario(campaign.cells).get(args.scenario.id)
  const artifact = evidenceCell
    ? cellArtifactEvidence(evidenceCell.artifact, args.scenario, args.describeArtifact)
    : undefined
  const response: ExternalTextEvaluationResponse = {
    score: row.composite,
    info: {
      scenarioId: row.scenarioId,
      dimensions: breakdown.dimensions,
      scores: { ...breakdown.dimensions },
      status: 'scored',
      ...(row.notes ? { notes: row.notes } : {}),
      ...(artifact !== undefined ? { artifact } : {}),
    },
  }
  if (JSON.stringify(response).length > args.maxEvidenceChars) {
    throw new Error(
      `${args.label} evaluation evidence for '${args.scenario.id}' exceeds maxEvidenceChars`,
    )
  }
  return { response, cells }
}

function cloneExternalTextCandidate(candidate: ExternalTextCandidate): ExternalTextCandidate {
  return typeof candidate === 'string' ? candidate : { ...candidate }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}
