import type { CostLedgerHandle } from '../cost-ledger'
import {
  assertJsonValue,
  type ExternalTextEvaluationRequest,
  isCandidateText,
  safePathComponent,
} from './external-optimizer-process'
import type { OptimizationMethodInput } from './presets/compare-optimization-methods'
import { runCampaign } from './run-campaign'
import { campaignBreakdown } from './score-utils'
import { surfaceContentHash } from './surface-identity'
import type { Scenario } from './types'

export interface ExternalOptimizationExample {
  id: string
  data: unknown
}

export interface ExternalTextEvaluationResponse {
  score: number
  info: {
    scenarioId: string
    dimensions: Record<string, number>
    notes?: string
    artifact?: unknown
  }
}

export function createExternalTextEvaluator<TScenario extends Scenario, TArtifact>(args: {
  input: OptimizationMethodInput<TScenario, TArtifact>
  label: string
  runDir: string
  costPhase: string
  costLedger: CostLedgerHandle
  scenarioById: ReadonlyMap<string, TScenario>
  maxCandidateChars: number
  maxEvidenceChars: number
  describeArtifact?: (artifact: TArtifact, scenario: TScenario) => unknown
}): (request: ExternalTextEvaluationRequest) => Promise<ExternalTextEvaluationResponse> {
  const cached = new Map<string, Promise<ExternalTextEvaluationResponse>>()
  return async ({ candidate, exampleId }) => {
    if (!args.scenarioById.has(exampleId)) {
      throw new Error(`${args.label} requested unknown train or selection case '${exampleId}'`)
    }
    const surface =
      typeof candidate === 'string'
        ? candidate
        : ({ kind: 'components', components: candidate } as const)
    const candidateLength =
      typeof candidate === 'string' ? candidate.length : JSON.stringify(candidate).length
    if (
      (typeof candidate === 'string' && !isCandidateText(candidate, args.maxCandidateChars)) ||
      candidateLength > args.maxCandidateChars
    ) {
      throw new Error(`${args.label} submitted an invalid candidate`)
    }
    const scenario = args.scenarioById.get(exampleId)!
    const cacheKey = `${surfaceContentHash(surface)}:${exampleId}`
    const existing = cached.get(cacheKey)
    if (existing) return existing

    const result = scoreOneScenario({
      input: args.input,
      label: args.label,
      candidate: surface,
      scenario,
      runDir: args.runDir,
      costPhase: args.costPhase,
      costLedger: args.costLedger,
      maxEvidenceChars: args.maxEvidenceChars,
      describeArtifact: args.describeArtifact,
    })
    cached.set(cacheKey, result)
    return result
  }
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
  const data = describe ? describe(scenario) : { id: scenario.id }
  assertJsonValue(data, `${label} scenario '${scenario.id}'`)
  const serializedChars = JSON.stringify(data).length
  if (serializedChars > maxChars) {
    throw new Error(
      `${label} scenario '${scenario.id}' exceeds maxEvidenceChars (${serializedChars} > ${maxChars})`,
    )
  }
  return { id: scenario.id, data }
}

async function scoreOneScenario<TScenario extends Scenario, TArtifact>(args: {
  input: OptimizationMethodInput<TScenario, TArtifact>
  label: string
  candidate:
    | string
    | { readonly kind: 'components'; readonly components: Readonly<Record<string, string>> }
  scenario: TScenario
  runDir: string
  costPhase: string
  costLedger: CostLedgerHandle
  maxEvidenceChars: number
  describeArtifact?: (artifact: TArtifact, scenario: TScenario) => unknown
}): Promise<ExternalTextEvaluationResponse> {
  const campaign = await runCampaign<TScenario, TArtifact>({
    ...args.input.runOptions,
    scenarios: [structuredClone(args.scenario)],
    dispatch: (scenario, context) =>
      args.input.dispatchWithSurface(args.candidate, scenario, context),
    judges: [...args.input.judges],
    runDir: `${args.runDir}/evaluations/${safePathComponent(surfaceContentHash(args.candidate))}/${safePathComponent(args.scenario.id)}`,
    seed: args.input.seed,
    costLedger: args.costLedger,
    costPhase: args.costPhase,
    maxConcurrency: 1,
  })
  const breakdown = campaignBreakdown(campaign)
  const row = breakdown.scenarios[0]
  if (!row) throw new Error(`${args.label} evaluation produced no score for '${args.scenario.id}'`)
  const artifact =
    args.describeArtifact && campaign.cells[0]
      ? args.describeArtifact(campaign.cells[0].artifact, args.scenario)
      : undefined
  if (artifact !== undefined) {
    assertJsonValue(artifact, `${args.label} described artifact for '${args.scenario.id}'`)
  }
  const response: ExternalTextEvaluationResponse = {
    score: row.composite,
    info: {
      scenarioId: row.scenarioId,
      dimensions: breakdown.dimensions,
      ...(row.notes ? { notes: row.notes } : {}),
      ...(artifact !== undefined ? { artifact } : {}),
    },
  }
  if (JSON.stringify(response).length > args.maxEvidenceChars) {
    throw new Error(
      `${args.label} evaluation evidence for '${args.scenario.id}' exceeds maxEvidenceChars`,
    )
  }
  return response
}
