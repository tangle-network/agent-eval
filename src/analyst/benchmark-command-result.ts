import type { AnalystBenchmarkObservation } from './benchmark'
import {
  AGENT_RX_UPSTREAM_REVISION,
  summarizeAgentRxCalibration,
} from './benchmark-agentrx-calibration'
import {
  type AnalystBenchmarkArtifact,
  type AnalystBenchmarkRunManifest,
  canonicalJson,
  observationKey,
  parseJson,
} from './benchmark-command-artifact'
import { readRegularFile } from './benchmark-command-persistence'
import { assertAnalystBenchmarkArtifact } from './benchmark-command-validation'
import { compareAnalystRunners } from './benchmark-comparison'
import { summarizeCodeTraceCalibration } from './benchmark-public-calibration'
import type { PreparedPublicAnalystBenchmark } from './benchmark-real-model'
import { summarizeAnalystBenchmarkRunner } from './benchmark-summary'

export async function readAnalystBenchmarkArtifact(
  path: string,
): Promise<AnalystBenchmarkArtifact> {
  const value = parseJson(await readRegularFile(path, 'analyst benchmark result'), path)
  assertAnalystBenchmarkArtifact(value, 'analyst benchmark result')
  return value
}

export function assertCompletedArtifactMatchesRun(
  artifact: AnalystBenchmarkArtifact,
  manifest: AnalystBenchmarkRunManifest,
  observations: readonly AnalystBenchmarkObservation[],
  prepared: PreparedPublicAnalystBenchmark,
): void {
  if (artifact.runIdentitySha256 !== manifest.identitySha256) {
    throw new Error('completed benchmark result belongs to another run')
  }
  assertSameObservations(artifact.result.observations, observations)
  const expectedCount =
    manifest.identity.inputs.selectedCaseIds.length *
    manifest.identity.config.runnerIds.length *
    manifest.identity.config.repetitions
  if (observations.length !== expectedCount) {
    throw new Error(
      `completed benchmark result has ${observations.length} observations; expected ${expectedCount}`,
    )
  }

  const { config, inputs } = manifest.identity
  const verificationAvailability = {
    cases: prepared.verificationArtifacts.length,
    resultFilesPresent: prepared.verificationArtifacts.filter(
      (artifact) => artifact.status === 'present',
    ).length,
    resultFilesMissing: prepared.verificationArtifacts.filter(
      (artifact) => artifact.status === 'missing',
    ).length,
    outcomes: {
      passed: prepared.verificationArtifacts.filter(
        (artifact) => artifact.outcome.status === 'passed',
      ).length,
      failed: prepared.verificationArtifacts.filter(
        (artifact) => artifact.outcome.status === 'failed',
      ).length,
      unavailable: prepared.verificationArtifacts.filter(
        (artifact) => artifact.outcome.status === 'unavailable',
      ).length,
    },
  }
  const expectedInputs: AnalystBenchmarkArtifact['inputs'] = {
    dataset: config.dataset,
    datasetRevision: config.datasetRevision,
    datasetSplit: config.datasetSplit,
    labelsSha256: inputs.labelsSha256,
    sourceRowCount: inputs.sourceRowCount,
    traceFiles: inputs.traceFiles.map((traceFile) => ({ ...traceFile })),
    verificationArtifacts: prepared.verificationArtifacts,
    verificationAvailability,
    selection: {
      limit: config.limit,
      seed: config.seed,
      selectedCaseIds: [...inputs.selectedCaseIds],
      report: prepared.selection,
    },
    execution: {
      repetitions: config.repetitions,
      concurrency: config.concurrency,
      ...(config.rlmSamples === undefined ? {} : { rlmSamples: config.rlmSamples }),
      model: config.model.id,
      maxOutputTokens: config.model.maxOutputTokens,
      timeoutMs: config.model.timeoutMs,
      maxCostUsd: config.maxCostUsd,
      maxArtifactBytes: config.maxArtifactBytes,
      analystProtocolSha256: config.analystProtocolSha256,
      implementationSha256: config.implementationSha256,
      dependencyLockSha256: config.dependencyLockSha256,
    },
  }
  if (canonicalJson(artifact.inputs) !== canonicalJson(expectedInputs)) {
    throw new Error('completed benchmark result inputs do not match the run manifest')
  }

  const provenance = artifact.result.provenance
  const expectedDatasetId =
    config.dataset === 'agentrx' ? 'microsoft/AgentRx' : 'NJU-LINK/CodeTraceBench'
  const expectedOutputAdapter =
    config.dataset === 'agentrx'
      ? 'agentrx-taxonomy-and-root-step'
      : 'codetracebench-incorrect-block'
  if (
    provenance.id !== `${config.dataset}-real-model-analyst` ||
    provenance.startedAt !== manifest.createdAt ||
    !Number.isFinite(Date.parse(provenance.endedAt)) ||
    Date.parse(provenance.endedAt) < Date.parse(provenance.startedAt) ||
    canonicalJson(provenance.dataset) !==
      canonicalJson({
        id: expectedDatasetId,
        revision: config.datasetRevision,
        split: config.datasetSplit,
      }) ||
    provenance.caseCount !== inputs.selectedCaseIds.length ||
    canonicalJson(provenance.runnerIds) !== canonicalJson(config.runnerIds) ||
    provenance.repetitions !== config.repetitions ||
    provenance.maxConcurrency !== Math.min(config.concurrency, expectedCount) ||
    provenance.runnerOrderSeed !== config.seed ||
    provenance.metadata?.model !== config.model.id ||
    provenance.metadata?.rlmSamples !== config.rlmSamples ||
    provenance.metadata?.outputAdapter !== expectedOutputAdapter ||
    provenance.metadata?.caseSelection !== prepared.selection.method ||
    provenance.metadata?.caseSelectionSeed !== config.seed ||
    provenance.metadata?.selectionStratified !== prepared.selection.stratified ||
    provenance.metadata?.protocolSha256 !== config.analystProtocolSha256 ||
    provenance.metadata?.implementationSha256 !== config.implementationSha256 ||
    provenance.metadata?.dependencyLockSha256 !== config.dependencyLockSha256 ||
    provenance.metadata?.populationRepresentativenessProven !== false
  ) {
    throw new Error('completed benchmark result provenance does not match the run manifest')
  }

  const expectedSummaries = config.runnerIds.map((runnerId) =>
    summarizeAnalystBenchmarkRunner(
      runnerId,
      observations.filter((observation) => observation.runnerId === runnerId),
    ),
  )
  if (canonicalJson(artifact.result.summaries) !== canonicalJson(expectedSummaries)) {
    throw new Error('completed benchmark summaries do not match durable observations')
  }

  const expectedComparisons = [
    compareAnalystRunners(artifact.result, {
      baselineRunnerId: 'empty',
      candidateRunnerId: config.runnerIds[1],
      seed: config.seed,
    }),
  ]
  if (canonicalJson(artifact.comparisons) !== canonicalJson(expectedComparisons)) {
    throw new Error('completed benchmark comparisons do not match durable observations')
  }

  if (config.dataset === 'codetracebench') {
    if (
      canonicalJson(artifact.codeTraceCalibration) !==
        canonicalJson(summarizeCodeTraceCalibration(artifact.result)) ||
      artifact.agentRxCalibration !== undefined
    ) {
      throw new Error('completed CodeTraceBench calibration does not match durable observations')
    }
  } else if (
    canonicalJson(artifact.agentRxCalibration) !==
      canonicalJson(summarizeAgentRxCalibration(artifact.result, AGENT_RX_UPSTREAM_REVISION)) ||
    artifact.codeTraceCalibration !== undefined
  ) {
    throw new Error('completed AgentRx calibration does not match durable observations')
  }
}

export function assertSameObservations(
  expected: readonly AnalystBenchmarkObservation[],
  actual: readonly AnalystBenchmarkObservation[],
): void {
  if (expected.length !== actual.length) {
    throw new Error(
      `benchmark result has ${expected.length} observations but the durable log has ${actual.length}`,
    )
  }
  const expectedByKey = new Map(
    expected.map((observation) => [observationKey(observation), canonicalJson(observation)]),
  )
  for (const observation of actual) {
    const key = observationKey(observation)
    if (expectedByKey.get(key) !== canonicalJson(observation)) {
      throw new Error(
        `benchmark result does not match durable observation '${observation.runnerId}/${observation.caseId}/${observation.repetition}'`,
      )
    }
    expectedByKey.delete(key)
  }
  if (expectedByKey.size > 0) {
    throw new Error('benchmark result is missing durable observations')
  }
}
