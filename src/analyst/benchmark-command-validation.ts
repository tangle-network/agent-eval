import { z } from 'zod'
import type { AnalystBenchmarkObservation } from './benchmark'
import type { AnalystBenchmarkArtifact } from './benchmark-command-artifact'

const nonEmptyString = z.string().refine((value) => value.trim().length > 0, {
  message: 'must be a non-empty string',
})
const safeInteger = z.number().refine(Number.isSafeInteger, {
  message: 'must be a safe integer',
})
const nonNegativeInteger = safeInteger.refine((value) => value >= 0, {
  message: 'must be a non-negative safe integer',
})
const positiveInteger = safeInteger.refine((value) => value > 0, {
  message: 'must be a positive safe integer',
})
const nonNegativeNumber = z.number().nonnegative()
const rate = z.number().min(0).max(1)
const nullableRate = rate.nullable()
const finiteNumber = z.number()
const nullableFiniteNumber = finiteNumber.nullable()
const sha256 = z.string().regex(/^[a-f0-9]{64}$/, 'must be a lowercase SHA-256 digest')
const revision = z
  .string()
  .regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/, 'must be a lowercase 40 or 64 character revision')
const timestamp = z.string().refine((value) => Number.isFinite(Date.parse(value)), {
  message: 'must be a valid timestamp',
})
const stringArray = z.array(z.string())
const nonEmptyStringArray = z.array(nonEmptyString)
const metadata = z.record(z.string(), z.unknown())

const errorSchema = z.strictObject({
  class: nonEmptyString,
  message: nonEmptyString,
  code: nonEmptyString.optional(),
  status: z.number().int().min(100).max(599).optional(),
})

const evidenceSchema = z.strictObject({
  kind: z.enum(['span', 'event', 'artifact', 'finding', 'metric']),
  uri: nonEmptyString,
  excerpt: z.string().optional(),
})

const findingSchema = z.strictObject({
  schema_version: z.literal('1.0.0'),
  finding_id: nonEmptyString,
  analyst_id: nonEmptyString,
  produced_at: timestamp,
  severity: z.enum(['critical', 'high', 'medium', 'low', 'info']),
  area: nonEmptyString,
  claim: nonEmptyString,
  rationale: z.string().optional(),
  evidence_refs: z.array(evidenceSchema),
  recommended_action: z.string().optional(),
  validation_plan: z.string().optional(),
  confidence: rate,
  subject: z.string().optional(),
  derived_from_judge: z.boolean().optional(),
  metadata: metadata.optional(),
})

const tokenUsageSchema = z
  .strictObject({
    input: nonNegativeInteger,
    output: nonNegativeInteger,
    reasoning: nonNegativeInteger.optional(),
    cached: nonNegativeInteger.optional(),
    cacheWrite: nonNegativeInteger.optional(),
  })
  .superRefine((usage, context) => {
    if (usage.reasoning !== undefined && usage.reasoning > usage.output) {
      context.addIssue({
        code: 'custom',
        path: ['reasoning'],
        message: 'must not exceed output tokens',
      })
    }
  })

const costSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('observed'),
    usd: nonNegativeNumber,
  }),
  z.strictObject({
    kind: z.literal('estimated'),
    usd: nonNegativeNumber,
  }),
  z.strictObject({
    kind: z.literal('uncaptured'),
    usd: z.null(),
  }),
])

const usageSchema = z.strictObject({
  calls: nonNegativeInteger.nullable(),
  tokens: tokenUsageSchema.nullable(),
  cost: costSchema,
  knownCostUsd: nonNegativeNumber.optional(),
  // A provider that reports one side only: the count is kept here rather than
  // zero-filled into `tokens`, so this gate must accept it or a paid run is
  // rejected at journal-write time, after the model call is spent.
  partialTokens: z
    .strictObject({
      input: nonNegativeInteger.nullable(),
      output: nonNegativeInteger.nullable(),
    })
    .optional(),
  tokensEstimated: z.boolean().optional(),
})

const findingScoreSchema = z.strictObject({
  expectedIssueCount: nonNegativeInteger,
  matchedIssueIds: nonEmptyStringArray,
  missedIssueIds: nonEmptyStringArray,
  supportedFindingIndexes: z.array(nonNegativeInteger),
  unsupportedFindingIndexes: z.array(nonNegativeInteger),
  unlabeledEvidence: z.array(evidenceSchema),
  issueRecall: rate,
  findingPrecision: rate,
  f1: rate,
  criticalStepAccuracy: nullableRate,
  citationCoverage: nullableRate,
  citationExcerptCoverage: nullableRate,
  citationLabelAgreement: nullableRate,
  predictionOnLabelEmptyCase: z.boolean(),
})

const evidenceResolutionSchema = z.strictObject({
  checked: nonNegativeInteger,
  resolved: nonNegativeInteger,
  unresolvedEvidence: z.array(evidenceSchema),
  errors: z.array(
    z.strictObject({
      evidence: evidenceSchema,
      class: nonEmptyString,
      message: nonEmptyString,
    }),
  ),
  validity: nullableRate,
})

const observationSchema: z.ZodType<AnalystBenchmarkObservation> = z
  .strictObject({
    runnerId: nonEmptyString,
    caseId: nonEmptyString,
    clusterId: nonEmptyString,
    labelState: z.enum(['positive', 'trusted-negative', 'unlabeled']),
    repetition: nonNegativeInteger,
    executionIndex: nonNegativeInteger,
    latencyMs: nonNegativeNumber.nullable(),
    latencySource: z.enum(['benchmark-clock', 'runner-reported', 'uncaptured']),
    findings: z.array(findingSchema),
    score: findingScoreSchema,
    evidenceResolution: evidenceResolutionSchema.optional(),
    caseTags: stringArray,
    caseMetadata: metadata.optional(),
    usage: usageSchema.optional(),
    runnerMetadata: metadata.optional(),
    error: errorSchema.optional(),
  })
  .superRefine((observation, context) => {
    const latencyIsMissing = observation.latencyMs === null
    if (
      (observation.latencySource === 'uncaptured' && !latencyIsMissing) ||
      (observation.latencySource !== 'uncaptured' && latencyIsMissing)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['latencyMs'],
        message: `must ${observation.latencySource === 'uncaptured' ? '' : 'not '}be null for '${observation.latencySource}' latency`,
      })
    }
  })

const latencyDistributionSchema = z.strictObject({
  min: nonNegativeNumber,
  mean: nonNegativeNumber,
  p50: nonNegativeNumber,
  p95: nonNegativeNumber,
  max: nonNegativeNumber,
})

const summarySchema = z.strictObject({
  runnerId: nonEmptyString,
  plannedRuns: nonNegativeInteger,
  completedRuns: nonNegativeInteger,
  failedRuns: nonNegativeInteger,
  issueBearingRuns: nonNegativeInteger,
  trustedNegativeRuns: nonNegativeInteger,
  unlabeledRuns: nonNegativeInteger,
  issueRecall: nullableRate,
  findingPrecision: nullableRate,
  f1: nullableRate,
  macroIssueRecall: nullableRate,
  macroFindingPrecision: nullableRate,
  macroF1: nullableRate,
  criticalStepAccuracy: nullableRate,
  citationCoverage: nullableRate,
  citationExcerptCoverage: nullableRate,
  citationLabelAgreement: nullableRate,
  citationResolution: nullableRate,
  citationResolutionUnknownRuns: nonNegativeInteger,
  unresolvedCitations: nonNegativeInteger,
  citationResolutionErrors: nonNegativeInteger,
  trustedNegativeFalsePositiveRate: nullableRate,
  trustedNegativeFailureRate: nullableRate,
  unlabeledPredictionRate: nullableRate,
  unlabeledFailureRate: nullableRate,
  predictionAgreement: nullableRate,
  predictionAgreementCases: nonNegativeInteger,
  matchedLabelAgreement: nullableRate,
  matchedLabelAgreementCases: nonNegativeInteger,
  latencyMs: latencyDistributionSchema.nullable(),
  benchmarkClockLatencyRuns: nonNegativeInteger,
  runnerReportedLatencyRuns: nonNegativeInteger,
  latencyUnknownRuns: nonNegativeInteger,
  calls: nonNegativeInteger,
  callsUnknownRuns: nonNegativeInteger,
  inputTokens: nonNegativeInteger,
  outputTokens: nonNegativeInteger,
  reasoningTokens: nonNegativeInteger,
  cachedTokens: nonNegativeInteger,
  cacheWriteTokens: nonNegativeInteger,
  tokenUsageUnknownRuns: nonNegativeInteger,
  reasoningTokenUsageUnknownRuns: nonNegativeInteger,
  cachedTokenUsageUnknownRuns: nonNegativeInteger,
  cacheWriteTokenUsageUnknownRuns: nonNegativeInteger,
  knownCostUsd: nonNegativeNumber,
  costUnknownRuns: nonNegativeInteger,
})

const provenanceSchema = z
  .strictObject({
    id: nonEmptyString.optional(),
    dataset: z
      .strictObject({
        id: nonEmptyString,
        revision: nonEmptyString,
        split: nonEmptyString.optional(),
      })
      .optional(),
    command: nonEmptyString.optional(),
    environment: z.record(z.string(), z.string()).optional(),
    metadata: metadata.optional(),
    startedAt: timestamp,
    endedAt: timestamp,
    caseCount: positiveInteger,
    runnerIds: nonEmptyStringArray.min(1),
    repetitions: positiveInteger,
    maxConcurrency: positiveInteger,
    runnerOrderSeed: safeInteger,
  })
  .superRefine((provenance, context) => {
    if (Date.parse(provenance.endedAt) < Date.parse(provenance.startedAt)) {
      context.addIssue({
        code: 'custom',
        path: ['endedAt'],
        message: 'must not precede startedAt',
      })
    }
  })

const resultSchema = z.strictObject({
  provenance: provenanceSchema,
  observations: z.array(observationSchema),
  summaries: z.array(summarySchema),
})

const comparisonMetricSchema = z.strictObject({
  metric: z.enum([
    'completion',
    'issueRecall',
    'findingPrecision',
    'f1',
    'criticalStepAccuracy',
    'citationCoverage',
    'citationExcerptCoverage',
    'citationLabelAgreement',
    'citationResolution',
    'trustedNegativeAccuracy',
    'latencyMs',
    'calls',
    'inputTokens',
    'outputTokens',
    'reasoningTokens',
    'cachedTokens',
    'cacheWriteTokens',
    'costUsd',
  ]),
  direction: z.enum(['higher', 'lower']),
  pairedCases: nonNegativeInteger,
  pairedClusters: nonNegativeInteger,
  eligibleObservations: nonNegativeInteger,
  pairedObservations: nonNegativeInteger,
  baselineMissingObservations: nonNegativeInteger,
  candidateMissingObservations: nonNegativeInteger,
  asymmetricMissingObservations: nonNegativeInteger,
  survivorOnly: z.boolean(),
  baselineMean: nullableFiniteNumber,
  candidateMean: nullableFiniteNumber,
  meanDelta: nullableFiniteNumber,
  intervalLow: nullableFiniteNumber,
  intervalHigh: nullableFiniteNumber,
  confidence: z.number().gt(0).lt(1),
  resamples: positiveInteger,
  minimumSampleMet: z.boolean(),
  populationInferenceEligible: z.boolean(),
  inferenceLimitations: stringArray,
})

const comparisonSchema = z.strictObject({
  baselineRunnerId: nonEmptyString,
  candidateRunnerId: nonEmptyString,
  metrics: z.array(comparisonMetricSchema),
})

const valueDistributionSchema = z.strictObject({
  total: nonNegativeInteger,
  missing: nonNegativeInteger,
  counts: z.record(z.string(), nonNegativeInteger),
})

const distributionsSchema = z.strictObject({
  class: valueDistributionSchema,
  agent: valueDistributionSchema,
  model: valueDistributionSchema,
  difficulty: valueDistributionSchema,
  solved: valueDistributionSchema,
})

const selectionReportSchema = z.strictObject({
  method: z.enum(['census', 'deterministic-hash']),
  seed: safeInteger,
  sourceCount: positiveInteger,
  selectedCount: positiveInteger,
  stratified: z.literal(false),
  representativeOfInput: z.boolean(),
  source: distributionsSchema,
  selected: distributionsSchema,
})

const verificationOutcomeSchema = z.strictObject({
  status: z.enum(['passed', 'failed', 'unavailable']),
  reason: z
    .enum([
      'missing-result',
      'result-output-unavailable',
      'result-parse-error',
      'result-label-disagreement',
    ])
    .optional(),
  parseError: errorSchema.optional(),
  sources: z.array(
    z.strictObject({
      path: nonEmptyString,
      format: z.enum(['terminal-bench', 'swe-bench', 'swe-multi']),
      status: z.enum(['passed', 'failed', 'unavailable']),
    }),
  ),
  passedCheckCount: nonNegativeInteger,
  failedCheckCount: nonNegativeInteger,
  passedChecks: stringArray,
  failedChecks: stringArray,
})

const verificationArtifactRole = z.enum(['final-test-output', 'final-result', 'final-metrics'])

const verificationArtifactSchema = z.strictObject({
  traceId: nonEmptyString,
  status: z.enum(['present', 'missing']),
  outcome: verificationOutcomeSchema,
  outcomeSpanId: nonEmptyString,
  caseDirectory: nonEmptyString,
  caseDirectoriesSearched: nonEmptyStringArray,
  totalBytes: nonNegativeInteger,
  maxBytes: positiveInteger,
  files: z.array(
    z.strictObject({
      role: verificationArtifactRole,
      path: nonEmptyString,
      relativePath: nonEmptyString,
      sha256,
      bytes: nonNegativeInteger,
      spanId: nonEmptyString,
    }),
  ),
  missingRoles: z.array(verificationArtifactRole),
  searched: z.strictObject({
    'final-test-output': stringArray,
    'final-result': stringArray,
    'final-metrics': stringArray,
  }),
})

const verificationAvailabilitySchema = z.strictObject({
  cases: nonNegativeInteger,
  resultFilesPresent: nonNegativeInteger,
  resultFilesMissing: nonNegativeInteger,
  outcomes: z.strictObject({
    passed: nonNegativeInteger,
    failed: nonNegativeInteger,
    unavailable: nonNegativeInteger,
  }),
})

const codeTraceCalibrationSchema = z.strictObject({
  protocol: z.literal('labeled-positive-and-solved-negative'),
  rationale: nonEmptyString,
  runners: z.array(
    z.strictObject({
      runnerId: nonEmptyString,
      selectedRuns: nonNegativeInteger,
      positiveRuns: nonNegativeInteger,
      trustedNegativeRuns: nonNegativeInteger,
      unlabeledRuns: nonNegativeInteger,
      failedLabelEmptyRuns: nonNegativeInteger,
      unknownLabelEmptyRuns: nonNegativeInteger,
      completedRuns: nonNegativeInteger,
      failedRuns: nonNegativeInteger,
      expectedIncorrectSteps: nonNegativeInteger,
      predictedIncorrectSteps: nonNegativeInteger,
      matchedIncorrectSteps: nonNegativeInteger,
      officialAllRowF1: nullableRate,
      officialAllRowRuns: nonNegativeInteger,
      precision: nullableRate,
      recall: nullableRate,
      f1: nullableRate,
      trustedNegativeFalsePositiveRate: nullableRate,
      trustedNegativeFailureRate: nullableRate,
      unlabeledPredictionRate: nullableRate,
      unlabeledFailureRate: nullableRate,
    }),
  ),
})

const agentRxCalibrationSchema = z.strictObject({
  protocol: z.literal('official-agentrx-root-cause'),
  upstreamRevision: revision,
  rationale: nonEmptyString,
  runners: z.array(
    z.strictObject({
      runnerId: nonEmptyString,
      selectedRuns: nonNegativeInteger,
      completedRuns: nonNegativeInteger,
      failedRuns: nonNegativeInteger,
      predictedRuns: nonNegativeInteger,
      missingPredictionRuns: nonNegativeInteger,
      exactStepAccuracy: nullableRate,
      stepAccuracyWithin1: nullableRate,
      stepAccuracyWithin2: nullableRate,
      stepAccuracyWithin3: nullableRate,
      stepAccuracyWithin4: nullableRate,
      stepAccuracyWithin5: nullableRate,
      meanStepDistance: nonNegativeNumber.nullable(),
      normalizedMeanStepDistance: nullableRate,
      normalizedDistanceRuns: nonNegativeInteger,
      normalizedDistanceUnknownRuns: nonNegativeInteger,
      rootCauseCategoryAccuracy: nullableRate,
      anyFailureCategoryAccuracy: nullableRate,
      earliestFailureCategoryAccuracy: nullableRate,
      terminalFailureCategoryAccuracy: nullableRate,
    }),
  ),
})

const artifactSchema: z.ZodType<AnalystBenchmarkArtifact> = z
  .strictObject({
    kind: z.literal('agent-eval/analyst-benchmark-result'),
    runIdentitySha256: sha256,
    inputs: z.strictObject({
      dataset: z.enum(['agentrx', 'codetracebench']),
      datasetRevision: revision,
      datasetSplit: nonEmptyString,
      labelsSha256: sha256,
      sourceRowCount: positiveInteger,
      traceFiles: z.array(
        z.strictObject({
          traceId: nonEmptyString,
          relativePath: nonEmptyString,
          sha256,
        }),
      ),
      verificationArtifacts: z.array(verificationArtifactSchema),
      verificationAvailability: verificationAvailabilitySchema,
      selection: z.strictObject({
        limit: positiveInteger,
        seed: safeInteger,
        selectedCaseIds: nonEmptyStringArray.min(1),
        report: selectionReportSchema,
      }),
      execution: z.strictObject({
        repetitions: positiveInteger,
        concurrency: positiveInteger,
        rlmSamples: positiveInteger.optional(),
        model: nonEmptyString,
        modelOwnerCallRef: nonEmptyString.optional(),
        maxOutputTokens: positiveInteger,
        maxReasoningTokens: nonNegativeInteger.optional(),
        maxModelRequestBytes: positiveInteger.optional(),
        maxModelResponseBytes: positiveInteger.optional(),
        modelRequestTimeoutMs: positiveInteger.optional(),
        timeoutMs: positiveInteger,
        pricing: z
          .strictObject({
            inputUsdPerMillion: nonNegativeNumber,
            cachedInputUsdPerMillion: nonNegativeNumber.optional(),
            cacheWriteUsdPerMillion: nonNegativeNumber.optional(),
            outputUsdPerMillion: nonNegativeNumber,
          })
          .optional(),
        recursiveLimits: z
          .strictObject({
            maxIterations: positiveInteger,
            maxLlmCalls: positiveInteger,
            maxToolCalls: positiveInteger,
            maxOutputChars: positiveInteger,
            maxModelRequests: positiveInteger.nullable(),
            traceToolRequestBytes: positiveInteger,
            traceToolResponseBytes: positiveInteger,
            traceToolTimeoutMs: positiveInteger,
          })
          .optional(),
        processLimits: z
          .strictObject({
            maxInputBytes: positiveInteger,
            maxResultBytes: positiveInteger,
            maxOutputChars: positiveInteger,
          })
          .optional(),
        maxCostUsd: nonNegativeNumber,
        maxArtifactBytes: positiveInteger,
        analystProtocolSha256: sha256,
        implementationSha256: sha256,
        dependencyLockSha256: sha256,
      }),
    }),
    result: resultSchema,
    comparisons: z.array(comparisonSchema),
    codeTraceCalibration: codeTraceCalibrationSchema.optional(),
    agentRxCalibration: agentRxCalibrationSchema.optional(),
  })
  .superRefine((artifact, context) => {
    const isCodeTrace = artifact.inputs.dataset === 'codetracebench'
    if (isCodeTrace && !artifact.codeTraceCalibration) {
      context.addIssue({
        code: 'custom',
        path: ['codeTraceCalibration'],
        message: 'is required for CodeTraceBench artifacts',
      })
    }
    if (isCodeTrace && artifact.agentRxCalibration) {
      context.addIssue({
        code: 'custom',
        path: ['agentRxCalibration'],
        message: 'is not allowed for CodeTraceBench artifacts',
      })
    }
    if (!isCodeTrace && !artifact.agentRxCalibration) {
      context.addIssue({
        code: 'custom',
        path: ['agentRxCalibration'],
        message: 'is required for AgentRx artifacts',
      })
    }
    if (!isCodeTrace && artifact.codeTraceCalibration) {
      context.addIssue({
        code: 'custom',
        path: ['codeTraceCalibration'],
        message: 'is not allowed for AgentRx artifacts',
      })
    }
  })

export function assertAnalystBenchmarkObservation(
  value: unknown,
  context: string,
): asserts value is AnalystBenchmarkObservation {
  assertSchema(observationSchema, value, context)
}

export function assertAnalystBenchmarkArtifact(
  value: unknown,
  context: string,
): asserts value is AnalystBenchmarkArtifact {
  assertSchema(artifactSchema, value, context)
}

function assertSchema(schema: z.ZodType, value: unknown, context: string): void {
  const result = schema.safeParse(value)
  if (result.success) return
  throw new TypeError(formatIssue(result.error.issues[0]!, context))
}

function formatIssue(issue: z.core.$ZodIssue, context: string): string {
  const path = issue.path.length === 0 ? context : `${context}.${issue.path.join('.')}`
  if (issue.code === 'unrecognized_keys') {
    return `${path} contains unknown field '${issue.keys[0]}'`
  }
  return `${path} ${issue.message}`
}
