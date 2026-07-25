import { z } from 'zod'
import type { MutableSurface } from '../campaign/types'
import type { InsightReport } from '../contract/insight-report'
import type {
  EvalRunCellScore,
  EvalRunEvent,
  EvalRunGenerationSnapshot,
  IngestEvalRunsRequest,
  IngestResponse,
  IngestTracesRequest,
  TraceSpanEvent,
  UnixNanoTimestamp,
} from './types'
import { HOSTED_WIRE_VERSION } from './types'

const finiteNumber = z.number().finite()
const nonNegativeNumber = finiteNumber.nonnegative()
const nonNegativeInteger = z.number().int().nonnegative()
const nonEmptyString = z
  .string()
  .min(1)
  .refine((value) => value.trim().length > 0, 'must not be blank')
const attributeValue = z.union([z.string(), finiteNumber, z.boolean()])
const attributes = z.record(z.string(), attributeValue)
const UINT64_MAX = 18_446_744_073_709_551_615n

export const UnixNanoTimestampSchema: z.ZodType<UnixNanoTimestamp> = z
  .string()
  .regex(/^(0|[1-9][0-9]*)$/, 'expected an unsigned base-10 integer string')
  .refine((value) => BigInt(value) <= UINT64_MAX, 'must fit in an unsigned 64-bit integer')

const GainDistributionBinSchema = z
  .object({
    lo: finiteNumber,
    hi: finiteNumber,
    count: nonNegativeInteger,
  })
  .strict()

const ScalarDistributionSchema = z
  .object({
    n: nonNegativeInteger,
    mean: finiteNumber.nullable(),
    p50: finiteNumber.nullable(),
    p95: finiteNumber.nullable(),
    stddev: nonNegativeNumber.nullable(),
    min: finiteNumber.nullable(),
    max: finiteNumber.nullable(),
    histogram: z.array(GainDistributionBinSchema),
    tailRuns: z
      .array(
        z
          .object({
            runId: nonEmptyString,
            score: finiteNumber,
          })
          .strict(),
      )
      .optional(),
  })
  .strict()
  .superRefine((distribution, ctx) => {
    const values = [
      distribution.mean,
      distribution.p50,
      distribution.p95,
      distribution.stddev,
      distribution.min,
      distribution.max,
    ]
    if (distribution.n === 0 && values.some((value) => value !== null)) {
      ctx.addIssue({
        code: 'custom',
        message: 'distribution values must be null when n is 0',
      })
    }
    if (distribution.n > 0 && values.some((value) => value === null)) {
      ctx.addIssue({
        code: 'custom',
        message: 'distribution values must be numbers when n is greater than 0',
      })
    }
    if (
      distribution.min !== null &&
      distribution.max !== null &&
      distribution.min > distribution.max
    ) {
      ctx.addIssue({ code: 'custom', path: ['min'], message: 'min must not exceed max' })
    }
  })

const TokenUsageInsightSchema = z
  .object({
    input: ScalarDistributionSchema,
    output: ScalarDistributionSchema,
    reasoning: ScalarDistributionSchema,
    cached: ScalarDistributionSchema,
    cacheWrite: ScalarDistributionSchema,
    totals: z
      .object({
        input: nonNegativeNumber,
        output: nonNegativeNumber,
        reasoning: nonNegativeNumber,
        cached: nonNegativeNumber,
        cacheWrite: nonNegativeNumber,
      })
      .strict(),
  })
  .strict()

const ExecutionErrorOutcomeCellSchema = z
  .object({
    withErrors: nonNegativeInteger,
    withoutErrors: nonNegativeInteger,
    unreported: nonNegativeInteger,
  })
  .strict()

const ExecutionInsightSchema = z
  .object({
    durationMs: ScalarDistributionSchema,
    queueMs: ScalarDistributionSchema,
    tokenUsage: TokenUsageInsightSchema,
    aggregateUsage: z
      .object({
        runs: nonNegativeInteger,
        tokenUsage: TokenUsageInsightSchema,
        costUsd: ScalarDistributionSchema,
        totalCostUsd: nonNegativeNumber,
      })
      .strict(),
    models: z.array(
      z
        .object({
          model: nonEmptyString,
          runs: nonNegativeInteger,
        })
        .strict(),
    ),
    modelCalls: z
      .object({
        runs: nonNegativeInteger,
        events: nonNegativeInteger,
        reportingRuns: nonNegativeInteger,
      })
      .strict(),
    executionErrors: z
      .object({
        runs: nonNegativeInteger,
        fraction: finiteNumber.min(0).max(1).nullable(),
        events: nonNegativeInteger,
        reportingRuns: nonNegativeInteger,
        errorSpanEvents: nonNegativeInteger,
        errorSpanReportingRuns: nonNegativeInteger,
        byTerminalOutcome: z
          .object({
            succeeded: ExecutionErrorOutcomeCellSchema,
            failed: ExecutionErrorOutcomeCellSchema,
            cancelled: ExecutionErrorOutcomeCellSchema,
            incomplete: ExecutionErrorOutcomeCellSchema,
            unknown: ExecutionErrorOutcomeCellSchema,
          })
          .strict(),
      })
      .strict(),
    terminalOutcomes: z
      .object({
        succeeded: nonNegativeInteger,
        failed: nonNegativeInteger,
        cancelled: nonNegativeInteger,
        incomplete: nonNegativeInteger,
        unknown: nonNegativeInteger,
      })
      .strict(),
  })
  .strict()

const CostProvenanceSummarySchema = z
  .object({
    observed: z
      .object({
        n: nonNegativeInteger,
        totalUsd: nonNegativeNumber,
      })
      .strict(),
    estimated: z
      .object({
        n: nonNegativeInteger,
        totalUsd: nonNegativeNumber,
      })
      .strict(),
    uncaptured: z.object({ n: nonNegativeInteger }).strict(),
    knownFraction: finiteNumber.min(0).max(1),
  })
  .strict()

const ParetoFigureSpecSchema = z
  .object({
    kind: z.literal('pareto-cost-quality'),
    split: z.enum(['search', 'holdout']),
    points: z.array(
      z
        .object({
          candidateId: nonEmptyString,
          cost: nonNegativeNumber,
          quality: finiteNumber,
          n: nonNegativeInteger,
          onFrontier: z.boolean(),
          gate: z.enum(['promote', 'reject']).optional(),
        })
        .strict(),
    ),
    axes: z.object({ x: z.literal('costUsd'), y: z.literal('score') }).strict(),
  })
  .strict()

const ContinuousAgreementSchema = z
  .object({
    weightedKappa: finiteNumber,
    icc: finiteNumber,
    pearson: finiteNumber,
    spearman: finiteNumber,
    ci: z
      .object({
        icc: z.tuple([finiteNumber, finiteNumber]),
        weightedKappa: z.tuple([finiteNumber, finiteNumber]),
      })
      .strict(),
    n: nonNegativeInteger,
    raters: nonNegativeInteger,
  })
  .strict()

const JudgeInsightSchema = z
  .object({
    n: nonNegativeInteger,
    meanScore: finiteNumber,
    calibration: ContinuousAgreementSchema.optional(),
    positionalBias: finiteNumber.optional(),
    selfPreference: finiteNumber.optional(),
    verbosityBias: finiteNumber.optional(),
  })
  .strict()

const InterRaterInsightSchema = z
  .object({
    raters: nonNegativeInteger,
    jointlyRated: nonNegativeInteger,
    kappa: finiteNumber,
    icc: finiteNumber,
    pearson: finiteNumber,
    spearman: finiteNumber,
    perPair: z.record(z.string(), finiteNumber),
    disagreementCases: z.array(
      z
        .object({
          runId: nonEmptyString,
          ratings: z.array(
            z
              .object({
                rater: nonEmptyString,
                score: finiteNumber,
              })
              .strict(),
          ),
          range: nonNegativeNumber,
        })
        .strict(),
    ),
  })
  .strict()

const LiftInsightSchema = z
  .object({
    baselineMean: finiteNumber,
    candidateMean: finiteNumber,
    delta: finiteNumber,
    ci95: z.tuple([finiteNumber, finiteNumber]),
    pValue: finiteNumber.min(0).max(1),
    n: nonNegativeInteger,
    unpairedBaseline: nonNegativeInteger,
    unpairedCandidate: nonNegativeInteger,
    cohensD: finiteNumber.nullable(),
    mde: nonNegativeNumber,
    requiredN: nonNegativeInteger.nullable(),
  })
  .strict()

const FailureClusterInsightSchema = z
  .object({
    clusters: z.array(
      z
        .object({
          id: nonEmptyString,
          name: nonEmptyString,
          share: finiteNumber.min(0).max(1),
          exemplars: z.array(nonEmptyString).max(5),
          suggestedFix: nonEmptyString.optional(),
        })
        .strict(),
    ),
    totalFailures: nonNegativeInteger,
  })
  .strict()

const ContaminationInsightSchema = z
  .object({
    leaks: nonNegativeInteger,
    holdoutAuditPassed: z.boolean(),
    details: z
      .array(
        z
          .object({
            runId: nonEmptyString,
            canary: nonEmptyString,
            matched: nonEmptyString,
          })
          .strict(),
      )
      .optional(),
  })
  .strict()

const OutcomeCorrelationInsightSchema = z
  .object({
    metric: nonEmptyString,
    n: nonNegativeInteger,
    pearson: finiteNumber,
    spearman: finiteNumber,
    rewardModel: z
      .object({
        intercept: finiteNumber,
        slope: finiteNumber,
        r2: finiteNumber,
      })
      .strict()
      .optional(),
  })
  .strict()

const ReleaseSummarySchema = z
  .object({
    status: z.enum(['pass', 'warn', 'fail']),
    axes: z.array(
      z
        .object({
          name: z.enum(['quality-lift', 'contamination', 'composite-distribution']),
          status: z.enum(['pass', 'warn', 'fail', 'not_evaluated']),
          detail: nonEmptyString,
        })
        .strict(),
    ),
    issues: z.array(z.string()),
  })
  .strict()

const MetricDeltaSchema = z
  .object({
    current: finiteNumber,
    baseline: finiteNumber,
    delta: finiteNumber,
    ci95: z.tuple([finiteNumber, finiteNumber]),
    pValue: finiteNumber.min(0).max(1),
    cohensD: finiteNumber,
    baselineN: nonNegativeInteger,
    currentN: nonNegativeInteger,
    significant: z.boolean(),
  })
  .strict()

const PriorPeriodComparisonSchema = z
  .object({
    baselineN: nonNegativeInteger,
    currentN: nonNegativeInteger,
    windowLabel: nonEmptyString.optional(),
    metrics: z.record(z.string(), MetricDeltaSchema),
    regressedMetrics: z.array(nonEmptyString),
    improvedMetrics: z.array(nonEmptyString),
  })
  .strict()

const RecommendationSchema = z
  .object({
    priority: z.enum(['critical', 'high', 'medium', 'low']),
    kind: z.enum(['ship', 'hold', 'investigate', 'fix', 'recalibrate', 'expand-corpus']),
    title: nonEmptyString,
    detail: nonEmptyString,
    evidencePath: nonEmptyString.optional(),
  })
  .strict()

export const InsightReportSchema: z.ZodType<InsightReport> = z
  .object({
    n: nonNegativeInteger,
    execution: ExecutionInsightSchema,
    composite: ScalarDistributionSchema,
    perDimension: z.record(z.string(), ScalarDistributionSchema),
    costQuality: z
      .object({
        cost: ScalarDistributionSchema,
        pareto: ParetoFigureSpecSchema,
        provenance: CostProvenanceSummarySchema.optional(),
        degraded: z
          .object({
            cost: nonEmptyString.optional(),
            pareto: nonEmptyString.optional(),
          })
          .strict()
          .optional(),
      })
      .strict(),
    judges: z.record(z.string(), JudgeInsightSchema),
    interRater: InterRaterInsightSchema.optional(),
    lift: LiftInsightSchema.optional(),
    failureClusters: FailureClusterInsightSchema.optional(),
    contamination: ContaminationInsightSchema.optional(),
    outcomeCorrelation: OutcomeCorrelationInsightSchema.optional(),
    release: ReleaseSummarySchema,
    priorPeriodComparison: PriorPeriodComparisonSchema.optional(),
    failureModes: z
      .array(
        z
          .object({
            mode: nonEmptyString,
            count: nonNegativeInteger,
            share: finiteNumber.min(0).max(1),
          })
          .strict(),
      )
      .optional(),
    recommendations: z.array(RecommendationSchema),
  })
  .strict()

const sha256Digest = z.custom<`sha256:${string}`>(
  (value) => typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value),
  'expected sha256:<64 lowercase hex characters>',
)

export const MutableSurfaceSchema: z.ZodType<MutableSurface> = z.union([
  z.string(),
  z
    .object({
      kind: z.literal('components'),
      components: z.record(z.string(), z.string()),
    })
    .strict(),
  z
    .object({
      kind: z.literal('code'),
      worktreeRef: nonEmptyString,
      baseRef: nonEmptyString,
      baseCommit: nonEmptyString,
      baseTree: nonEmptyString,
      candidateCommit: nonEmptyString,
      candidateTree: nonEmptyString,
      patch: z
        .object({
          format: z.literal('git-diff-binary'),
          sha256: sha256Digest,
          byteLength: nonNegativeInteger,
        })
        .strict(),
      summary: z.string().optional(),
    })
    .strict(),
])

export const RunTerminalOutcomeSchema = z.enum([
  'succeeded',
  'failed',
  'cancelled',
  'incomplete',
  'unknown',
])

export const EvalRunCellScoreSchema: z.ZodType<EvalRunCellScore> = z
  .object({
    scenarioId: nonEmptyString,
    rep: nonNegativeInteger,
    compositeMean: finiteNumber.nullable(),
    dimensions: z.record(z.string(), z.record(z.string(), finiteNumber)),
    terminalOutcome: RunTerminalOutcomeSchema,
    executionErrorCount: nonNegativeInteger.nullable(),
    errorMessage: z.string().optional(),
  })
  .strict()

export const EvalRunGenerationSnapshotSchema: z.ZodType<EvalRunGenerationSnapshot> = z
  .object({
    index: nonNegativeInteger,
    surfaceHash: nonEmptyString,
    surface: MutableSurfaceSchema.optional(),
    cells: z.array(EvalRunCellScoreSchema),
    compositeMean: finiteNumber.nullable(),
    costUsd: nonNegativeNumber,
    durationMs: nonNegativeNumber,
  })
  .strict()

const EvalRunStatusSchema = z.enum([
  'started',
  'baseline-complete',
  'generation-complete',
  'gate-decided',
  'finished',
  'errored',
])

const GateDecisionSchema = z.enum([
  'ship',
  'hold',
  'need_more_work',
  'model_ceiling',
  'arch_ceiling',
])

export const EvalRunEventSchema: z.ZodType<EvalRunEvent> = z
  .object({
    runId: nonEmptyString,
    runDir: nonEmptyString,
    timestamp: z.string().datetime({ offset: true }),
    status: EvalRunStatusSchema,
    labels: z.record(z.string(), z.string()),
    baseline: EvalRunGenerationSnapshotSchema.optional(),
    generations: z.array(EvalRunGenerationSnapshotSchema),
    gateDecision: GateDecisionSchema.optional(),
    holdoutLift: finiteNumber.optional(),
    totalCostUsd: nonNegativeNumber,
    totalDurationMs: nonNegativeNumber,
    errorMessage: z.string().optional(),
    insightReport: InsightReportSchema.optional(),
  })
  .strict()
  .superRefine((event, ctx) => {
    if (event.baseline && event.baseline.index !== 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['baseline', 'index'],
        message: 'baseline index must be 0',
      })
    }

    const seen = new Set<number>()
    for (let i = 0; i < event.generations.length; i++) {
      const index = event.generations[i]!.index
      if (seen.has(index)) {
        ctx.addIssue({
          code: 'custom',
          path: ['generations', i, 'index'],
          message: `duplicate generation index ${index}`,
        })
      }
      seen.add(index)
    }

    if (event.status === 'errored' && !event.errorMessage?.trim()) {
      ctx.addIssue({
        code: 'custom',
        path: ['errorMessage'],
        message: 'errorMessage is required when status is errored',
      })
    }
  })

const TraceSpanEventEntrySchema = z
  .object({
    timeUnixNano: UnixNanoTimestampSchema,
    name: nonEmptyString,
    attributes: attributes.optional(),
  })
  .strict()

export const TraceSpanEventSchema: z.ZodType<TraceSpanEvent> = z
  .object({
    traceId: nonEmptyString,
    spanId: nonEmptyString,
    parentSpanId: nonEmptyString.optional(),
    name: nonEmptyString,
    startTimeUnixNano: UnixNanoTimestampSchema,
    endTimeUnixNano: UnixNanoTimestampSchema,
    attributes,
    events: z.array(TraceSpanEventEntrySchema).optional(),
    status: z
      .object({
        code: z.enum(['OK', 'ERROR', 'UNSET']),
        message: z.string().optional(),
      })
      .strict()
      .optional(),
    'tangle.runId': nonEmptyString.optional(),
    'tangle.generation': nonNegativeInteger.optional(),
    'tangle.cellId': nonEmptyString.optional(),
    'tangle.scenarioId': nonEmptyString.optional(),
  })
  .strict()
  .refine((span) => BigInt(span.endTimeUnixNano) >= BigInt(span.startTimeUnixNano), {
    path: ['endTimeUnixNano'],
    message: 'endTimeUnixNano must be greater than or equal to startTimeUnixNano',
  })

export const IngestEvalRunsEnvelopeSchema = z
  .object({
    wireVersion: z.literal(HOSTED_WIRE_VERSION),
    events: z.array(z.unknown()),
  })
  .strict()

export const IngestTracesEnvelopeSchema = z
  .object({
    wireVersion: z.literal(HOSTED_WIRE_VERSION),
    spans: z.array(z.unknown()),
  })
  .strict()

export const IngestEvalRunsRequestSchema: z.ZodType<IngestEvalRunsRequest> = z
  .object({
    wireVersion: z.literal(HOSTED_WIRE_VERSION),
    events: z.array(EvalRunEventSchema),
  })
  .strict()

export const IngestTracesRequestSchema: z.ZodType<IngestTracesRequest> = z
  .object({
    wireVersion: z.literal(HOSTED_WIRE_VERSION),
    spans: z.array(TraceSpanEventSchema),
  })
  .strict()

export const IngestResponseSchema: z.ZodType<IngestResponse> = z
  .object({
    accepted: nonNegativeInteger,
    rejected: z.array(
      z
        .object({
          index: nonNegativeInteger,
          reason: nonEmptyString,
        })
        .strict(),
    ),
  })
  .strict()
