import { z } from 'zod'
import type { AgentProfileJson, AgentProfileJsonObject } from '../../agent-profile-cell'
import {
  makePolicyEdit,
  POLICY_EDIT_AXES,
  POLICY_EDIT_TARGET_SURFACES,
  type PolicyEdit,
  type PolicyEditAdmission,
  type PolicyEditAdmissionOptions,
  type PolicyEditCandidateRecord,
  type PolicyEditExpectedGain,
  type PolicyEditInit,
  validatePolicyEditCandidateRecord,
} from '../../analyst/policy-edit'
import { assertNoJudgeVerdict } from '../../analyst/steer-firewall'
import type { AnalystFinding, EvidenceRef } from '../../analyst/types'
import { CostLedger, type CostLedgerHandle } from '../../cost-ledger'
import {
  callLlmJson,
  costReceiptFromLlm,
  costReceiptFromLlmError,
  type LlmCallRequest,
  type LlmClientOptions,
  maximumChargeForLlmRequest,
} from '../../llm-client'
import type {
  GenerationCandidate,
  GenerationRecord,
  MutableSurface,
  ProposeContext,
  ProposedCandidate,
  ScoredSurfaceOutcome,
  SurfaceProposer,
} from '../types'
import { policyEditProposer } from './policy-edit'
import {
  assertPolicyEditAuthorContextBudget,
  selectPolicyEditAuthorRows,
} from './policy-edit-author-context'

const JSON_POLICY_EDIT_TARGET_SURFACES = [
  'prompt',
  'tool-contract',
  'runtime-config',
  'memory',
  'agent-profile',
] as const satisfies readonly (typeof POLICY_EDIT_TARGET_SURFACES)[number][]

export type JsonPolicyEditTargetSurface = (typeof JSON_POLICY_EDIT_TARGET_SURFACES)[number]

const NonEmptyStringSchema = z.string().trim().min(1)
const JsonObjectKeySchema = z
  .string()
  .min(1)
  .refine((key) => key.trim() === key, 'JSON object keys must not have surrounding whitespace')

const JsonValueSchema: z.ZodType<AgentProfileJson> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(JsonObjectKeySchema, JsonValueSchema),
  ]),
)

const AuthoredJsonChangeSchema = z.discriminatedUnion('mode', [
  z
    .object({
      kind: z.literal('json'),
      mode: z.literal('set'),
      path: NonEmptyStringSchema,
      value: JsonValueSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('json'),
      mode: z.literal('merge'),
      path: NonEmptyStringSchema,
      value: JsonValueSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('json'),
      mode: z.literal('remove'),
      path: NonEmptyStringSchema,
    })
    .strict(),
])

const AuthoredPolicyEditSchema = z
  .object({
    axis: z.enum(POLICY_EDIT_AXES),
    target: z
      .object({
        surface: z.enum(POLICY_EDIT_TARGET_SURFACES),
        path: NonEmptyStringSchema,
        label: NonEmptyStringSchema.max(200).nullable(),
      })
      .strict(),
    change: AuthoredJsonChangeSchema,
    claim: NonEmptyStringSchema.max(2_000),
    expectedGain: z
      .object({
        metric: NonEmptyStringSchema.max(400),
        direction: z.enum(['increase', 'decrease']),
        amount: z.number().finite().positive(),
        unit: z.enum(['absolute', 'relative', 'percent', 'score']).nullable(),
        rationale: NonEmptyStringSchema.max(2_000).nullable(),
      })
      .strict(),
    confidence: z.number().finite().min(0).max(1),
    risk: z.enum(['low', 'medium', 'high', 'unknown']),
    source: z
      .object({
        findingKeys: z
          .array(NonEmptyStringSchema)
          .min(1)
          .refine((ids) => new Set(ids).size === ids.length, 'findingKeys must be unique'),
      })
      .strict(),
    rationale: NonEmptyStringSchema.max(4_000).nullable(),
    validationPlan: NonEmptyStringSchema.max(2_000).nullable(),
  })
  .strict()

const PolicyEditAuthorResponseSchema = z
  .object({
    edits: z.array(AuthoredPolicyEditSchema),
  })
  .strict()

type AuthoredPolicyEdit = z.infer<typeof AuthoredPolicyEditSchema>

const POLICY_EDIT_AUTHOR_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['edits'],
  properties: {
    edits: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'axis',
          'target',
          'change',
          'claim',
          'expectedGain',
          'confidence',
          'risk',
          'source',
          'rationale',
          'validationPlan',
        ],
        properties: {
          axis: { type: 'string', enum: [...POLICY_EDIT_AXES] },
          target: {
            type: 'object',
            additionalProperties: false,
            required: ['surface', 'path', 'label'],
            properties: {
              surface: { type: 'string', enum: [...POLICY_EDIT_TARGET_SURFACES] },
              path: { type: 'string', minLength: 1 },
              label: { type: ['string', 'null'], maxLength: 200 },
            },
          },
          change: {
            anyOf: [
              {
                type: 'object',
                additionalProperties: false,
                required: ['kind', 'mode', 'path', 'value'],
                properties: {
                  kind: { const: 'json' },
                  mode: { const: 'set' },
                  path: { type: 'string', minLength: 1 },
                  value: {},
                },
              },
              {
                type: 'object',
                additionalProperties: false,
                required: ['kind', 'mode', 'path', 'value'],
                properties: {
                  kind: { const: 'json' },
                  mode: { const: 'merge' },
                  path: { type: 'string', minLength: 1 },
                  value: {},
                },
              },
              {
                type: 'object',
                additionalProperties: false,
                required: ['kind', 'mode', 'path'],
                properties: {
                  kind: { const: 'json' },
                  mode: { const: 'remove' },
                  path: { type: 'string', minLength: 1 },
                },
              },
            ],
          },
          claim: { type: 'string', minLength: 1, maxLength: 2_000 },
          expectedGain: {
            type: 'object',
            additionalProperties: false,
            required: ['metric', 'direction', 'amount', 'unit', 'rationale'],
            properties: {
              metric: { type: 'string', minLength: 1, maxLength: 400 },
              direction: { type: 'string', enum: ['increase', 'decrease'] },
              amount: { type: 'number', exclusiveMinimum: 0 },
              unit: {
                type: ['string', 'null'],
                enum: ['absolute', 'relative', 'percent', 'score', null],
              },
              rationale: { type: ['string', 'null'], maxLength: 2_000 },
            },
          },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
          risk: { type: 'string', enum: ['low', 'medium', 'high', 'unknown'] },
          source: {
            type: 'object',
            additionalProperties: false,
            required: ['findingKeys'],
            properties: {
              findingKeys: {
                type: 'array',
                minItems: 1,
                uniqueItems: true,
                items: { type: 'string', minLength: 1 },
              },
            },
          },
          rationale: { type: ['string', 'null'], maxLength: 4_000 },
          validationPlan: { type: ['string', 'null'], maxLength: 2_000 },
        },
      },
    },
  },
}

function policyEditAuthorJsonSchema(
  maxItems: number,
  targetSurface: JsonPolicyEditTargetSurface,
  allowedJsonPaths: readonly string[],
  objectives: readonly PolicyEditObjective[],
): Record<string, unknown> {
  const schema = JSON.parse(JSON.stringify(POLICY_EDIT_AUTHOR_JSON_SCHEMA)) as Record<
    string,
    unknown
  >
  const properties = schema.properties as Record<string, unknown>
  const edits = properties.edits as Record<string, unknown>
  edits.maxItems = maxItems
  const item = edits.items as Record<string, unknown>
  const itemProperties = item.properties as Record<string, unknown>
  const target = itemProperties.target as Record<string, unknown>
  const targetProperties = target.properties as Record<string, unknown>
  targetProperties.surface = { type: 'string', enum: [targetSurface] }
  targetProperties.path = { type: 'string', enum: [...allowedJsonPaths] }
  const change = itemProperties.change as { anyOf: Array<Record<string, unknown>> }
  for (const variant of change.anyOf) {
    const variantProperties = variant.properties as Record<string, unknown>
    variantProperties.path = { type: 'string', enum: [...allowedJsonPaths] }
  }
  const expectedGain = itemProperties.expectedGain as Record<string, unknown>
  const gainProperties = expectedGain.properties as Record<string, unknown>
  gainProperties.metric = { type: 'string', enum: objectives.map((objective) => objective.key) }
  gainProperties.direction = {
    type: 'string',
    enum: [...new Set(objectives.map((objective) => objective.direction))],
  }
  gainProperties.unit = {
    type: 'string',
    enum: [...new Set(objectives.map((objective) => objective.unit))],
  }
  return schema
}

export const DEFAULT_POLICY_EDIT_HISTORY_LIMITS = Object.freeze({
  generations: 4,
  candidatesPerGeneration: 16,
  scenariosPerCandidate: 12,
  findings: 32,
  authorContextChars: 200_000,
})

export interface PolicyEditObjective {
  /** Stable objective key cited by forecasts, for example `search.composite`. */
  key: string
  /** Steering objectives are search-only; fresh-task results never enter author context. */
  split: 'search'
  /** Search promotes only larger composite scores. */
  direction: 'increase'
  scale: { min: number; max: number }
  /** Forecast amounts are absolute deltas on the declared score scale. */
  unit: 'score'
}

export type PolicyEditFindingSource =
  | { kind: 'surface'; surfaceHash: string; generation: number }
  | { kind: 'global'; label: string }

/** Trace-derived findings must name the measured profile that produced them.
 *  Cross-run doctrine can be explicitly global; an unwrapped finding is rejected. */
export interface PolicyEditFindingInput {
  finding: AnalystFinding
  source: PolicyEditFindingSource
}

export interface PolicyEditHistoryProjectionOptions {
  /** Number of most recent generations retained. Default: 4. */
  maxGenerations?: number
  /** Number of candidates retained per generation. Default: 16. */
  maxCandidatesPerGeneration?: number
  /** Scored tasks retained per candidate/outcome after deterministic extreme selection. */
  maxScenariosPerCandidate?: number
  /** Optional pseudonymizer applied before scenario IDs enter author text. */
  scenarioIdTransform?: (scenarioId: string) => string
  /** Objectives used to compute forecast residuals from measured composite deltas. */
  objectives?: readonly PolicyEditObjective[]
}

export interface PolicyEditCandidateSummary {
  editId: string
  axis: PolicyEdit['axis']
  target: PolicyEdit['target']
  change: PolicyEdit['change']
  claim: string
  expectedGain: PolicyEdit['expectedGain']
  confidence: number
  risk: PolicyEdit['risk']
  sourceFindingIds: string[]
  rationale: string | null
  validationPlan: string | null
}

export interface PolicyEditHistoryCandidateContext {
  surfaceHash: string
  parentSurfaceHash: string | null
  parentComposite: number | null
  label: string | null
  rationale: string | null
  composite: number
  observedDeltaFromParent: number | null
  eligibleForPromotion: boolean | null
  coverage: {
    expectedCells: number
    scorableCells: number
    unscorableCells: Array<{ reason: string }>
  } | null
  dimensions: Record<string, number>
  scenarios: Array<{ scenarioId: string; composite: number; notes: string | null }>
  candidateEdit: PolicyEditCandidateSummary | null
  forecastCalibration: {
    objectiveKey: string
    predictedDelta: number
    observedDelta: number
    residual: number
  } | null
}

export interface PolicyEditOutcomeContext {
  split: 'search'
  generation: number
  surfaceHash: string
  composite: number
  dimensions: Record<string, number>
  scenarios: Array<{ scenarioId: string; composite: number; notes: string | null }>
  coverage: { expectedCells: number; scorableCells: number }
}

export interface PolicyEditHistoryGenerationContext {
  generationIndex: number
  promoted: string[]
  candidates: PolicyEditHistoryCandidateContext[]
}

const POLICY_EDIT_AUTHOR_SYSTEM = [
  'You author strictly typed PolicyEdit candidates over one JSON surface.',
  'Return exactly one JSON object with shape {"edits":[...]}; emit an empty edits array when no evidence supports a change.',
  `axis must be one of: ${POLICY_EDIT_AXES.join(', ')}.`,
  `target.surface must be one of: ${POLICY_EDIT_TARGET_SURFACES.join(', ')}.`,
  'target.path and change.path must be the same caller-allowed JSON path.',
  'change must be exactly one operation: {"kind":"json","mode":"set","path":string,"value":json}, {"kind":"json","mode":"merge","path":string,"value":json}, or {"kind":"json","mode":"remove","path":string}.',
  'Nullable fields required by the response schema must be null when they do not apply.',
  'Every edit must cite one or more supplied finding keys in source.findingKeys. Do not emit persistent finding IDs, analyst IDs, or evidence references; the caller binds those from the cited findings.',
  'Treat expectedGain and confidence as forecasts, never as measured evidence. Learn from baselineOutcome, incumbentOutcome, and observedDeltaFromParent.',
  'Do not invent a finding, path, field, score, or task fact. Do not include schemaVersion, editId, metadata, prose, or undeclared keys.',
].join('\n')

function policyEditAuthorSystem(responseSchema: Record<string, unknown>): string {
  return [
    POLICY_EDIT_AUTHOR_SYSTEM,
    'The exact required response JSON Schema follows. Obey it even when the provider does not enforce response_format:',
    JSON.stringify(responseSchema),
  ].join('\n')
}

export interface LlmPolicyEditProposerOptions {
  llm: LlmClientOptions
  model: string
  /** Optional ledger for direct proposer use. Campaign context takes precedence. */
  costLedger?: CostLedgerHandle
  /** Plain-language description of the JSON surface being improved. */
  target: string
  /** PolicyEdit target surface every authored edit must retain. */
  targetSurface: JsonPolicyEditTargetSurface
  /** Exact JSON paths the author may change. Prefix or fuzzy matches are not accepted. */
  allowedJsonPaths: readonly string[]
  /** Exact search objectives forecasts may name. Unknown keys or mismatched directions fail. */
  objectives: readonly PolicyEditObjective[]
  /** Default: evidence-only, so uncertain edits are measured rather than
   *  suppressed by their own model-authored predictions. */
  admissionMode?: 'evidence-only' | 'strict'
  /** Readiness thresholds used only when admissionMode is explicitly strict. */
  admission?: PolicyEditAdmissionOptions
  maxCandidates?: number
  temperature?: number
  maxTokens?: number
  timeoutMs?: number
  /** Number of most recent scored generations sent to the author. Default: 4. */
  maxHistoryGenerations?: number
  /** Candidates retained per admitted generation. Default: 16. */
  maxHistoryCandidatesPerGeneration?: number
  /** Scored tasks retained per candidate/outcome after deterministic extreme selection. */
  maxScenariosPerCandidate?: number
  /** Evidence-bearing findings retained after deterministic severity/confidence ordering. */
  maxFindings?: number
  /** Hard character limit over system + schema + serialized author context. */
  maxAuthorContextChars?: number
  /** Optional one-to-one pseudonymizer applied to every author-visible evidence field. */
  scenarioIdTransform?: (scenarioId: string) => string
  /**
   * Remove credentials or unrelated fields from the current surface before it
   * is sent to the model. The callback receives a clone and must preserve every
   * editable path unchanged. Validated edits apply to the complete original.
   * This callback does not redact findings or scored history.
   */
  redactCurrentSurfaceForModel?: (surface: AgentProfileJsonObject) => AgentProfileJsonObject
  onAdmission?: (admission: PolicyEditAdmission) => void
}

/**
 * LLM-backed PolicyEdit author. It reads only the current JSON surface,
 * evidence-bearing analyst findings, and scored generation history. Model output
 * is validated and rebound to exact finding evidence before the deterministic
 * policyEditProposer applies, admits, and deduplicates candidates.
 */
export function llmPolicyEditProposer(
  opts: LlmPolicyEditProposerOptions,
): SurfaceProposer<PolicyEditFindingInput> {
  const allowedJsonPaths = validateAllowedJsonPaths(opts.allowedJsonPaths)
  const allowedPathSet = new Set(allowedJsonPaths)
  const objectives = validateObjectives(opts.objectives)
  const objectiveByKey = new Map(objectives.map((objective) => [objective.key, objective]))
  requireNonEmpty(opts.model, 'model')
  requireNonEmpty(opts.target, 'target')
  if (!(JSON_POLICY_EDIT_TARGET_SURFACES as readonly string[]).includes(opts.targetSurface)) {
    throw new Error(
      `llmPolicyEditProposer: targetSurface '${opts.targetSurface}' is not a JSON-backed surface`,
    )
  }
  if (
    opts.maxCandidates !== undefined &&
    (!Number.isSafeInteger(opts.maxCandidates) || opts.maxCandidates < 0)
  ) {
    throw new Error('llmPolicyEditProposer: maxCandidates must be a non-negative safe integer')
  }
  const admissionMode = opts.admissionMode ?? 'evidence-only'
  if (admissionMode !== 'evidence-only' && admissionMode !== 'strict') {
    throw new Error("llmPolicyEditProposer: admissionMode must be 'evidence-only' or 'strict'")
  }
  if (opts.admission && admissionMode !== 'strict') {
    throw new Error("llmPolicyEditProposer: admission thresholds require admissionMode: 'strict'")
  }
  const historyLimits = validateHistoryLimits({
    ...(opts.maxHistoryGenerations === undefined
      ? {}
      : { maxGenerations: opts.maxHistoryGenerations }),
    ...(opts.maxHistoryCandidatesPerGeneration === undefined
      ? {}
      : { maxCandidatesPerGeneration: opts.maxHistoryCandidatesPerGeneration }),
    ...(opts.maxScenariosPerCandidate === undefined
      ? {}
      : { maxScenariosPerCandidate: opts.maxScenariosPerCandidate }),
    ...(opts.scenarioIdTransform === undefined
      ? {}
      : { scenarioIdTransform: opts.scenarioIdTransform }),
  })
  const maxFindings = positiveLimit(
    opts.maxFindings ?? DEFAULT_POLICY_EDIT_HISTORY_LIMITS.findings,
    'maxFindings',
  )
  const maxAuthorContextChars = positiveLimit(
    opts.maxAuthorContextChars ?? DEFAULT_POLICY_EDIT_HISTORY_LIMITS.authorContextChars,
    'maxAuthorContextChars',
  )
  const directCostLedger = opts.costLedger ?? new CostLedger()

  return {
    kind: 'llm-policy-edit',
    async propose(
      ctx: ProposeContext<PolicyEditFindingInput>,
    ): Promise<Array<MutableSurface | ProposedCandidate>> {
      const limit = Math.min(ctx.populationSize, opts.maxCandidates ?? ctx.populationSize)
      if (limit <= 0) return []

      const currentSurface = parseJsonSurface(ctx.currentSurface)
      assertSearchOutcome(ctx.baselineOutcome, 'baselineOutcome')
      assertSearchOutcome(ctx.incumbentOutcome, 'incumbentOutcome')
      assertMeasuredCompositesInScale(ctx, objectives[0]!)
      const scenarioIds = createScenarioIdProjector(historyLimits.scenarioIdTransform)
      registerOutcomeScenarioIds(ctx.baselineOutcome, scenarioIds)
      registerOutcomeScenarioIds(ctx.incumbentOutcome, scenarioIds)
      registerHistoryScenarioIds(ctx.history.slice(-historyLimits.maxGenerations), scenarioIds)
      assertSurfaceIsTaskAgnostic(
        { currentSurface, allowedJsonPaths, objectives, targetSurface: opts.targetSurface },
        scenarioIds,
      )
      const modelSurface = redactCurrentSurfaceForModel(
        currentSurface,
        allowedJsonPaths,
        opts.redactCurrentSurfaceForModel,
      )
      assertSurfaceIsTaskAgnostic(modelSurface, scenarioIds)
      const measuredSources = measuredSourceMeasurements(ctx)
      const findings = citableFindings(ctx.findings, measuredSources, maxFindings)
      const findingByKey = new Map(
        findings.map((finding, index) => [`finding-${index + 1}`, finding]),
      )
      const authorContext = {
        target: scenarioIds.sanitize(opts.target),
        targetSurface: opts.targetSurface,
        allowedJsonPaths,
        objectives,
        candidateCount: limit,
        generation: ctx.generation,
        currentSurface: modelSurface,
        findings: findings.map((finding, index) =>
          renderFinding(finding, `finding-${index + 1}`, scenarioIds, measuredSources),
        ),
        baselineOutcome: projectOutcome(
          ctx.baselineOutcome,
          scenarioIds,
          historyLimits.maxScenariosPerCandidate,
        ),
        incumbentOutcome: projectOutcome(
          ctx.incumbentOutcome,
          scenarioIds,
          historyLimits.maxScenariosPerCandidate,
          ctx.baselineOutcome,
        ),
        history: projectPolicyEditHistoryWithProjector(
          ctx.history,
          historyLimits,
          scenarioIds,
          objectiveByKey,
        ),
      }
      const responseSchema = policyEditAuthorJsonSchema(
        limit,
        opts.targetSurface,
        allowedJsonPaths,
        objectives,
      )
      const system = policyEditAuthorSystem(responseSchema)
      assertPolicyEditAuthorContextBudget(
        { system, authorContext, responseSchema },
        maxAuthorContextChars,
      )
      const userContent = JSON.stringify(authorContext)
      const request: LlmCallRequest = {
        model: opts.model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: userContent },
        ],
        jsonSchema: {
          name: 'policy_edit_author',
          schema: responseSchema,
        },
        temperature: opts.temperature ?? 0.2,
        maxTokens: opts.maxTokens ?? 6_000,
        timeoutMs: opts.timeoutMs,
      }
      const paid = await (ctx.costLedger ?? directCostLedger).runPaidCall({
        channel: 'driver',
        phase: ctx.costPhase ?? 'search.proposal',
        actor: 'llm-policy-edit.author',
        model: opts.model,
        maximumCharge: maximumChargeForLlmRequest(request, opts.llm),
        tags: { generation: String(ctx.generation) },
        signal: ctx.signal,
        execute: (signal, callId) =>
          callLlmJson<unknown>(request, { ...opts.llm, signal, idempotencyKey: callId }),
        receipt: ({ result }) => costReceiptFromLlm(result),
        receiptFromError: costReceiptFromLlmError,
      })
      if (!paid.succeeded) throw paid.error
      const { value } = paid.value
      const response = parseAuthorResponse(value)
      if (response.edits.length > limit) {
        throw new Error(
          `llmPolicyEditProposer: author returned ${response.edits.length} edits for ${limit} candidate slots`,
        )
      }
      const edits = response.edits.map((draft) =>
        bindAuthoredEdit(
          draft,
          findingByKey,
          opts.targetSurface,
          allowedPathSet,
          objectiveByKey,
          ctx.incumbentOutcome?.composite ?? ctx.baselineOutcome?.composite,
        ),
      )
      return policyEditProposer({
        edits,
        admission:
          admissionMode === 'strict'
            ? opts.admission
            : {
                minScore: 0,
                minExpectedGain: 0,
                allowHighRisk: true,
                requireEvidence: true,
              },
        maxCandidates: limit,
        onAdmission: opts.onAdmission,
      }).propose(ctx)
    },
  }
}

/**
 * Projects scored history into the only fields a policy author may consume.
 * It admits recent generations and a bounded candidate count, while retaining
 * every dimension and scenario score for each admitted candidate.
 */
export function projectPolicyEditHistory(
  history: readonly GenerationRecord[],
  options: PolicyEditHistoryProjectionOptions = {},
): PolicyEditHistoryGenerationContext[] {
  const limits = validateHistoryLimits(options)
  const objectiveByKey = new Map(
    (options.objectives ? validateObjectives(options.objectives) : []).map((objective) => [
      objective.key,
      objective,
    ]),
  )
  const scenarioIds = createScenarioIdProjector(limits.scenarioIdTransform)
  registerHistoryScenarioIds(history.slice(-limits.maxGenerations), scenarioIds)
  return projectPolicyEditHistoryWithProjector(history, limits, scenarioIds, objectiveByKey)
}

function projectPolicyEditHistoryWithProjector(
  history: readonly GenerationRecord[],
  limits: ReturnType<typeof validateHistoryLimits>,
  scenarioIds: ScenarioIdProjector,
  objectiveByKey: ReadonlyMap<string, PolicyEditObjective>,
): PolicyEditHistoryGenerationContext[] {
  const retainedHistory = history.slice(-limits.maxGenerations)
  const candidateByHash = new Map(
    retainedHistory.flatMap((record) =>
      record.candidates.map((candidate) => [candidate.surfaceHash, candidate] as const),
    ),
  )
  return retainedHistory.map((record) => {
    const candidates = selectHistoryCandidates(record, limits.maxCandidatesPerGeneration)
    const hashes = new Set(candidates.map((candidate) => candidate.surfaceHash))
    return {
      generationIndex: record.generationIndex,
      promoted: record.promoted
        .filter((hash) => hashes.has(hash))
        .map((hash) => scenarioIds.sanitize(hash)),
      candidates: candidates.map((candidate) =>
        projectHistoryCandidate(
          candidate,
          scenarioIds,
          limits.maxScenariosPerCandidate,
          candidate.parentSurfaceHash
            ? candidateByHash.get(candidate.parentSurfaceHash)?.scenarios
            : undefined,
          objectiveByKey,
        ),
      ),
    }
  })
}

function selectHistoryCandidates(record: GenerationRecord, limit: number): GenerationCandidate[] {
  const promotionOrder = new Map(record.promoted.map((hash, index) => [hash, index]))
  const promoted = [...record.candidates]
    .filter((candidate) => promotionOrder.has(candidate.surfaceHash))
    .sort((a, b) => promotionOrder.get(a.surfaceHash)! - promotionOrder.get(b.surfaceHash)!)
  const selected = promoted.slice(0, limit)
  const selectedHashes = new Set(selected.map((candidate) => candidate.surfaceHash))
  const remaining = [...record.candidates]
    .filter((candidate) => !promotionOrder.has(candidate.surfaceHash))
    .sort((a, b) => b.composite - a.composite || a.surfaceHash.localeCompare(b.surfaceHash))
  let high = 0
  let low = remaining.length - 1
  let takeLow = selected.length > 0
  while (selected.length < limit && high <= low) {
    const candidate = takeLow ? remaining[low--] : remaining[high++]
    takeLow = !takeLow
    if (!candidate || selectedHashes.has(candidate.surfaceHash)) continue
    selected.push(candidate)
    selectedHashes.add(candidate.surfaceHash)
  }
  return selected
}

function projectHistoryCandidate(
  candidate: GenerationCandidate,
  scenarioIds: ScenarioIdProjector,
  maxScenarios: number,
  parentScenarios: GenerationCandidate['scenarios'] | undefined,
  objectiveByKey: ReadonlyMap<string, PolicyEditObjective>,
): PolicyEditHistoryCandidateContext {
  const referenceByScenario = parentScenarios
    ? new Map(parentScenarios.map((scenario) => [scenario.scenarioId, scenario.composite]))
    : undefined
  const selectedScenarios = selectPolicyEditAuthorRows(candidate.scenarios, {
    limit: maxScenarios,
    ...(referenceByScenario ? { referenceByScenario } : {}),
  })
  const validatedRecord = candidate.candidateRecord
    ? validatePolicyEditCandidateRecord(candidate.candidateRecord)
    : undefined
  return {
    surfaceHash: scenarioIds.sanitize(candidate.surfaceHash),
    parentSurfaceHash: candidate.parentSurfaceHash
      ? scenarioIds.sanitize(candidate.parentSurfaceHash)
      : null,
    parentComposite: candidate.parentComposite ?? null,
    label: candidate.label ? scenarioIds.sanitize(candidate.label) : null,
    rationale: candidate.rationale ? scenarioIds.sanitize(candidate.rationale) : null,
    composite: candidate.composite,
    observedDeltaFromParent: candidate.observedDeltaFromParent ?? null,
    eligibleForPromotion: candidate.eligibleForPromotion ?? null,
    coverage: candidate.coverage
      ? {
          expectedCells: candidate.coverage.expectedCells,
          scorableCells: candidate.coverage.scorableCells,
          // `cellId` embeds the raw scenario ID. The aggregate reason is useful
          // for search, but the identifier must not bypass scenarioIdTransform.
          unscorableCells: [...candidate.coverage.unscorableCells]
            .sort((a, b) => a.cellId.localeCompare(b.cellId))
            .slice(0, maxScenarios)
            .map((cell) => ({ reason: scenarioIds.sanitize(cell.reason) })),
        }
      : null,
    // GenerationCandidate.ci95 is currently a placeholder [composite, composite],
    // not a measured interval. Keep it out of author context until it is real.
    dimensions: sanitizeDimensions(candidate.dimensions, scenarioIds),
    scenarios: selectedScenarios.map((scenario) => {
      return {
        scenarioId: scenarioIds.project(scenario.scenarioId),
        composite: scenario.composite,
        notes: scenario.notes ? scenarioIds.sanitize(scenario.notes) : null,
      }
    }),
    candidateEdit: validatedRecord ? summarizeCandidateEdit(validatedRecord, scenarioIds) : null,
    forecastCalibration: forecastCalibration(candidate, validatedRecord, objectiveByKey),
  }
}

function projectOutcome(
  outcome: ScoredSurfaceOutcome | undefined,
  scenarioIds: ScenarioIdProjector,
  maxScenarios: number,
  reference: ScoredSurfaceOutcome | undefined = undefined,
): PolicyEditOutcomeContext | null {
  if (!outcome) return null
  const referenceByScenario = reference
    ? new Map(reference.scenarios.map((scenario) => [scenario.scenarioId, scenario.composite]))
    : undefined
  const selectedScenarios = selectPolicyEditAuthorRows(outcome.scenarios, {
    limit: maxScenarios,
    ...(referenceByScenario ? { referenceByScenario } : {}),
  })
  return {
    split: 'search',
    generation: outcome.generation,
    surfaceHash: scenarioIds.sanitize(outcome.surfaceHash),
    composite: outcome.composite,
    dimensions: sanitizeDimensions(outcome.dimensions, scenarioIds),
    scenarios: selectedScenarios.map((scenario) => {
      return {
        scenarioId: scenarioIds.project(scenario.scenarioId),
        composite: scenario.composite,
        notes: scenario.notes ? scenarioIds.sanitize(scenario.notes) : null,
      }
    }),
    coverage: { ...outcome.coverage },
  }
}

interface ScenarioIdProjector {
  project(scenarioId: string): string
  sanitize(text: string): string
}

function createScenarioIdProjector(transform: (scenarioId: string) => string): ScenarioIdProjector {
  const aliases = new Map<string, string>()
  const originals = new Map<string, string>()
  return {
    project(scenarioId) {
      const known = aliases.get(scenarioId)
      if (known) return known
      const alias = transform(scenarioId)
      if (!alias || alias.trim() !== alias) {
        throw new Error(
          'llmPolicyEditProposer: scenarioIdTransform must return a trimmed non-empty string',
        )
      }
      const collision = originals.get(alias)
      if (collision && collision !== scenarioId) {
        throw new Error(
          `llmPolicyEditProposer: scenarioIdTransform collision for '${collision}' and '${scenarioId}'`,
        )
      }
      const aliasIsAnotherOriginal = aliases.has(alias) && alias !== scenarioId
      const originalIsAnotherAlias =
        originals.has(scenarioId) && originals.get(scenarioId) !== scenarioId
      if (aliasIsAnotherOriginal || originalIsAnotherAlias) {
        throw new Error(
          'llmPolicyEditProposer: scenarioIdTransform aliases overlap raw scenario IDs',
        )
      }
      aliases.set(scenarioId, alias)
      originals.set(alias, scenarioId)
      return alias
    },
    sanitize(text) {
      const originalsByLength = [...aliases.keys()].sort((a, b) => b.length - a.length)
      if (originalsByLength.length === 0) return text
      const pattern = new RegExp(
        `(^|[^A-Za-z0-9_-])(${originalsByLength.map(escapeRegExp).join('|')})(?=$|[^A-Za-z0-9_-])`,
        'g',
      )
      return text.replace(
        pattern,
        (_match, prefix: string, original: string) =>
          `${prefix}${aliases.get(original) ?? original}`,
      )
    },
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

interface PolicyEditFindingMeasurement {
  surfaceHash: string
  generation: number
  composite: number
  parentComposite: number | null
  observedDeltaFromParent: number | null
  eligibleForPromotion: boolean
  coverage: { expectedCells: number; scorableCells: number }
}

function sourceKey(surfaceHash: string, generation: number): string {
  return `${surfaceHash}@${generation}`
}

function measuredSourceMeasurements(
  ctx: ProposeContext<PolicyEditFindingInput>,
): Map<string, PolicyEditFindingMeasurement> {
  const measurements = new Map<string, PolicyEditFindingMeasurement>()
  const add = (measurement: PolicyEditFindingMeasurement) => {
    measurements.set(sourceKey(measurement.surfaceHash, measurement.generation), measurement)
  }
  if (ctx.baselineOutcome) {
    add({
      surfaceHash: ctx.baselineOutcome.surfaceHash,
      generation: ctx.baselineOutcome.generation,
      composite: ctx.baselineOutcome.composite,
      parentComposite: null,
      observedDeltaFromParent: null,
      eligibleForPromotion: true,
      coverage: { ...ctx.baselineOutcome.coverage },
    })
  }
  for (const record of ctx.history) {
    for (const candidate of record.candidates) {
      add({
        surfaceHash: candidate.surfaceHash,
        generation: record.generationIndex,
        composite: candidate.composite,
        parentComposite: candidate.parentComposite ?? null,
        observedDeltaFromParent: candidate.observedDeltaFromParent ?? null,
        eligibleForPromotion: candidate.eligibleForPromotion === true,
        coverage: candidate.coverage
          ? {
              expectedCells: candidate.coverage.expectedCells,
              scorableCells: candidate.coverage.scorableCells,
            }
          : { expectedCells: 0, scorableCells: 0 },
      })
    }
  }
  if (ctx.incumbentOutcome) {
    const generation = ctx.incumbentOutcome.generation
    const key = sourceKey(ctx.incumbentOutcome.surfaceHash, generation)
    if (!measurements.has(key)) {
      add({
        surfaceHash: ctx.incumbentOutcome.surfaceHash,
        generation,
        composite: ctx.incumbentOutcome.composite,
        parentComposite: null,
        observedDeltaFromParent: null,
        eligibleForPromotion: true,
        coverage: { ...ctx.incumbentOutcome.coverage },
      })
    }
  }
  return measurements
}

function validateFindingSource(
  source: PolicyEditFindingSource,
  measured: ReadonlyMap<string, PolicyEditFindingMeasurement>,
): void {
  if (source.kind === 'global') {
    requireNonEmpty(source.label, 'global finding source label')
    return
  }
  if (!measured.has(sourceKey(source.surfaceHash, source.generation))) {
    throw new Error(
      `llmPolicyEditProposer: finding source ${source.surfaceHash}@${source.generation} is not a measured surface`,
    )
  }
}

function sameFindingSource(a: PolicyEditFindingSource, b: PolicyEditFindingSource): boolean {
  if (a.kind !== b.kind) return false
  return a.kind === 'surface' && b.kind === 'surface'
    ? a.surfaceHash === b.surfaceHash && a.generation === b.generation
    : a.kind === 'global' && b.kind === 'global' && a.label === b.label
}

function summarizeCandidateEdit(
  record: PolicyEditCandidateRecord,
  scenarioIds: ScenarioIdProjector,
): PolicyEditCandidateSummary {
  const edit = record.policyEdit
  return {
    editId: edit.editId,
    axis: edit.axis,
    target: sanitizeAuthorValue(edit.target, scenarioIds) as PolicyEdit['target'],
    change: sanitizeAuthorValue(edit.change, scenarioIds) as PolicyEdit['change'],
    claim: scenarioIds.sanitize(edit.claim),
    expectedGain: sanitizeAuthorValue(edit.expectedGain, scenarioIds) as PolicyEdit['expectedGain'],
    confidence: edit.confidence,
    risk: edit.risk,
    sourceFindingIds: edit.source.findingIds.map((id) => scenarioIds.sanitize(id)),
    rationale: edit.rationale ? scenarioIds.sanitize(edit.rationale) : null,
    validationPlan: edit.validationPlan ? scenarioIds.sanitize(edit.validationPlan) : null,
  }
}

function sanitizeAuthorValue(value: unknown, scenarioIds: ScenarioIdProjector): unknown {
  if (typeof value === 'string') return scenarioIds.sanitize(value)
  if (Array.isArray(value)) return value.map((item) => sanitizeAuthorValue(item, scenarioIds))
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        scenarioIds.sanitize(key),
        sanitizeAuthorValue(child, scenarioIds),
      ]),
    )
  }
  return value
}

function sanitizeDimensions(
  dimensions: Readonly<Record<string, number>>,
  scenarioIds: ScenarioIdProjector,
): Record<string, number> {
  const sanitized = new Map<string, { original: string; value: number }>()
  for (const [key, value] of Object.entries(dimensions)) {
    const projected = scenarioIds.sanitize(key)
    const prior = sanitized.get(projected)
    if (prior && prior.original !== key) {
      throw new Error(
        `llmPolicyEditProposer: pseudonymized dimension key collision for '${prior.original}' and '${key}'`,
      )
    }
    sanitized.set(projected, { original: key, value })
  }
  return Object.fromEntries([...sanitized].map(([key, entry]) => [key, entry.value]))
}

function forecastCalibration(
  candidate: GenerationCandidate,
  record: PolicyEditCandidateRecord | undefined,
  objectiveByKey: ReadonlyMap<string, PolicyEditObjective>,
): PolicyEditHistoryCandidateContext['forecastCalibration'] {
  if (!record || candidate.observedDeltaFromParent === undefined) return null
  const forecast = record.policyEdit.expectedGain
  const objective = objectiveByKey.get(forecast.metric)
  if (!objective || objective.key !== 'search.composite') return null
  if (forecast.direction !== objective.direction || forecast.unit !== objective.unit) return null
  if (forecast.amount > objective.scale.max - objective.scale.min) return null
  const predictedDelta = forecast.amount
  return {
    objectiveKey: objective.key,
    predictedDelta,
    observedDelta: candidate.observedDeltaFromParent,
    residual: candidate.observedDeltaFromParent - predictedDelta,
  }
}

function assertSearchOutcome(outcome: ScoredSurfaceOutcome | undefined, field: string): void {
  if (outcome && (outcome as { split?: unknown }).split !== 'search') {
    throw new Error(`llmPolicyEditProposer: ${field} must be a search-split outcome`)
  }
}

function assertMeasuredCompositesInScale(
  ctx: ProposeContext<PolicyEditFindingInput>,
  objective: PolicyEditObjective,
): void {
  const assertInScale = (value: number, field: string) => {
    if (!Number.isFinite(value) || value < objective.scale.min || value > objective.scale.max) {
      throw new Error(
        `llmPolicyEditProposer: ${field} ${value} is outside objective '${objective.key}' scale [${objective.scale.min}, ${objective.scale.max}]`,
      )
    }
  }
  const assertOutcome = (outcome: ScoredSurfaceOutcome | undefined, field: string) => {
    if (!outcome) return
    assertInScale(outcome.composite, `${field}.composite`)
    for (const [index, scenario] of outcome.scenarios.entries()) {
      assertInScale(scenario.composite, `${field}.scenarios[${index}].composite`)
    }
  }
  assertOutcome(ctx.baselineOutcome, 'baselineOutcome')
  assertOutcome(ctx.incumbentOutcome, 'incumbentOutcome')
  for (const [generationIndex, generation] of ctx.history.entries()) {
    for (const [candidateIndex, candidate] of generation.candidates.entries()) {
      const field = `history[${generationIndex}].candidates[${candidateIndex}]`
      assertInScale(candidate.composite, `${field}.composite`)
      if (candidate.parentComposite !== undefined) {
        assertInScale(candidate.parentComposite, `${field}.parentComposite`)
      }
      for (const [scenarioIndex, scenario] of candidate.scenarios.entries()) {
        assertInScale(scenario.composite, `${field}.scenarios[${scenarioIndex}].composite`)
      }
    }
  }
}

function assertSurfaceIsTaskAgnostic(value: unknown, scenarioIds: ScenarioIdProjector): void {
  const serialized = JSON.stringify(value)
  if (scenarioIds.sanitize(serialized) !== serialized) {
    throw new Error(
      'llmPolicyEditProposer: current JSON surface or signature contains a raw scenario identifier',
    )
  }
}

function registerOutcomeScenarioIds(
  outcome: ScoredSurfaceOutcome | undefined,
  scenarioIds: ScenarioIdProjector,
): void {
  for (const scenario of outcome?.scenarios ?? []) scenarioIds.project(scenario.scenarioId)
}

function registerHistoryScenarioIds(
  history: readonly GenerationRecord[],
  scenarioIds: ScenarioIdProjector,
): void {
  for (const record of history) {
    for (const candidate of record.candidates) {
      for (const scenario of candidate.scenarios) scenarioIds.project(scenario.scenarioId)
      for (const cell of candidate.coverage?.unscorableCells ?? []) {
        const separator = cell.cellId.lastIndexOf(':')
        if (separator <= 0 || !/^\d+$/.test(cell.cellId.slice(separator + 1))) continue
        scenarioIds.project(cell.cellId.slice(0, separator))
      }
    }
  }
}

function validateHistoryLimits(options: PolicyEditHistoryProjectionOptions): {
  maxGenerations: number
  maxCandidatesPerGeneration: number
  maxScenariosPerCandidate: number
  scenarioIdTransform: (scenarioId: string) => string
} {
  const maxGenerations = options.maxGenerations ?? DEFAULT_POLICY_EDIT_HISTORY_LIMITS.generations
  const maxCandidatesPerGeneration =
    options.maxCandidatesPerGeneration ?? DEFAULT_POLICY_EDIT_HISTORY_LIMITS.candidatesPerGeneration
  const maxScenariosPerCandidate =
    options.maxScenariosPerCandidate ?? DEFAULT_POLICY_EDIT_HISTORY_LIMITS.scenariosPerCandidate
  if (!Number.isSafeInteger(maxGenerations) || maxGenerations <= 0) {
    throw new Error('llmPolicyEditProposer: maxHistoryGenerations must be a positive safe integer')
  }
  if (!Number.isSafeInteger(maxCandidatesPerGeneration) || maxCandidatesPerGeneration <= 0) {
    throw new Error(
      'llmPolicyEditProposer: maxHistoryCandidatesPerGeneration must be a positive safe integer',
    )
  }
  if (!Number.isSafeInteger(maxScenariosPerCandidate) || maxScenariosPerCandidate <= 0) {
    throw new Error(
      'llmPolicyEditProposer: maxScenariosPerCandidate must be a positive safe integer',
    )
  }
  return {
    maxGenerations,
    maxCandidatesPerGeneration,
    maxScenariosPerCandidate,
    scenarioIdTransform: options.scenarioIdTransform ?? ((scenarioId) => scenarioId),
  }
}

function validateObjectives(inputs: readonly PolicyEditObjective[]): PolicyEditObjective[] {
  if (inputs.length === 0) {
    throw new Error('llmPolicyEditProposer: objectives must not be empty')
  }
  const seen = new Set<string>()
  return inputs.map((input) => {
    requireNonEmpty(input.key, 'objective key')
    if (seen.has(input.key)) {
      throw new Error(`llmPolicyEditProposer: duplicate objective '${input.key}'`)
    }
    seen.add(input.key)
    if (input.split !== 'search') {
      throw new Error(`llmPolicyEditProposer: objective '${input.key}' must use the search split`)
    }
    if (input.key !== 'search.composite') {
      throw new Error(
        `llmPolicyEditProposer: objective '${input.key}' is not yet measurable; use 'search.composite'`,
      )
    }
    if (input.direction !== 'increase') {
      throw new Error(
        `llmPolicyEditProposer: objective '${input.key}' must increase because search promotes larger composite scores`,
      )
    }
    if (
      !Number.isFinite(input.scale.min) ||
      !Number.isFinite(input.scale.max) ||
      input.scale.max <= input.scale.min
    ) {
      throw new Error(`llmPolicyEditProposer: objective '${input.key}' has an invalid scale`)
    }
    if (input.unit !== 'score') {
      throw new Error(`llmPolicyEditProposer: objective '${input.key}' must use raw score deltas`)
    }
    return {
      key: input.key,
      split: 'search',
      direction: input.direction,
      scale: { ...input.scale },
      unit: input.unit,
    }
  })
}

function positiveLimit(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`llmPolicyEditProposer: ${field} must be a positive safe integer`)
  }
  return value
}

function parseAuthorResponse(value: unknown): z.infer<typeof PolicyEditAuthorResponseSchema> {
  const parsed = PolicyEditAuthorResponseSchema.safeParse(value)
  if (parsed.success) return parsed.data
  const issues = parsed.error.issues
    .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
    .join('; ')
  throw new Error(`llmPolicyEditProposer: invalid PolicyEdit response: ${issues}`)
}

function bindAuthoredEdit(
  draft: AuthoredPolicyEdit,
  findingByKey: ReadonlyMap<string, CitableFinding>,
  targetSurface: JsonPolicyEditTargetSurface,
  allowedPaths: ReadonlySet<string>,
  objectiveByKey: ReadonlyMap<string, PolicyEditObjective>,
  currentComposite: number | undefined,
): PolicyEdit {
  if (draft.target.surface !== targetSurface) {
    throw new Error(
      `llmPolicyEditProposer: target surface '${draft.target.surface}' does not match '${targetSurface}'`,
    )
  }
  if (draft.target.path !== draft.change.path) {
    throw new Error('llmPolicyEditProposer: target.path must equal change.path')
  }
  if (!allowedPaths.has(draft.change.path)) {
    throw new Error(
      `llmPolicyEditProposer: JSON path '${draft.change.path}' is outside allowedJsonPaths`,
    )
  }

  const cited = draft.source.findingKeys.map((findingKey) => {
    const finding = findingByKey.get(findingKey)
    if (!finding) {
      throw new Error(
        `llmPolicyEditProposer: edit cites unknown or uncitable finding key '${findingKey}'`,
      )
    }
    return finding
  })
  const evidenceRefs = uniqueEvidenceRefs(cited.flatMap((finding) => finding.evidenceRefs))
  if (evidenceRefs.length === 0) {
    throw new Error('llmPolicyEditProposer: authored edit has no cited evidence')
  }

  const objective = objectiveByKey.get(draft.expectedGain.metric)
  if (!objective) {
    throw new Error(
      `llmPolicyEditProposer: unknown forecast objective '${draft.expectedGain.metric}'`,
    )
  }
  if (draft.expectedGain.direction !== objective.direction) {
    throw new Error(
      `llmPolicyEditProposer: forecast direction for '${objective.key}' must be '${objective.direction}'`,
    )
  }
  if (draft.expectedGain.unit !== objective.unit) {
    throw new Error(
      `llmPolicyEditProposer: forecast unit for '${objective.key}' must be '${objective.unit}'`,
    )
  }
  const maxGain =
    currentComposite === undefined
      ? objective.scale.max - objective.scale.min
      : objective.scale.max - currentComposite
  if (draft.expectedGain.amount > maxGain) {
    throw new Error(
      `llmPolicyEditProposer: forecast amount for '${objective.key}' exceeds the available score headroom`,
    )
  }

  const expectedGain: PolicyEditExpectedGain = {
    metric: draft.expectedGain.metric,
    direction: draft.expectedGain.direction,
    amount: draft.expectedGain.amount,
    ...(draft.expectedGain.unit ? { unit: draft.expectedGain.unit } : {}),
    ...(draft.expectedGain.rationale ? { rationale: draft.expectedGain.rationale } : {}),
  }
  const init: PolicyEditInit = {
    axis: draft.axis,
    target: {
      surface: draft.target.surface,
      path: draft.target.path,
      ...(draft.target.label ? { label: draft.target.label } : {}),
    },
    change: draft.change,
    claim: draft.claim,
    expectedGain,
    confidence: draft.confidence,
    risk: draft.risk,
    source: {
      findingIds: [...new Set(cited.map((finding) => finding.finding.finding_id))],
      analystIds: [...new Set(cited.map((finding) => finding.finding.analyst_id))],
      evidenceRefs,
    },
    ...(draft.rationale ? { rationale: draft.rationale } : {}),
    ...(draft.validationPlan ? { validationPlan: draft.validationPlan } : {}),
  }
  return makePolicyEdit(init)
}

function parseJsonSurface(surface: MutableSurface): AgentProfileJsonObject {
  if (typeof surface !== 'string') {
    throw new Error('llmPolicyEditProposer: currentSurface must be serialized JSON')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(surface)
  } catch {
    throw new Error('llmPolicyEditProposer: currentSurface must be valid JSON')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('llmPolicyEditProposer: currentSurface JSON root must be an object')
  }
  return parsed as AgentProfileJsonObject
}

function redactCurrentSurfaceForModel(
  surface: AgentProfileJsonObject,
  allowedJsonPaths: readonly string[],
  redact: LlmPolicyEditProposerOptions['redactCurrentSurfaceForModel'],
): AgentProfileJsonObject {
  if (!redact) return surface
  const redacted = redact(structuredClone(surface))
  const parsed = JsonValueSchema.safeParse(redacted)
  if (!parsed.success) {
    const detail = formatJsonValidationError(parsed.error)
    throw new Error(
      `llmPolicyEditProposer: redactCurrentSurfaceForModel returned invalid JSON (${detail})`,
    )
  }
  if (!parsed.data || typeof parsed.data !== 'object' || Array.isArray(parsed.data)) {
    throw new Error('llmPolicyEditProposer: redactCurrentSurfaceForModel must return a JSON object')
  }
  for (const path of allowedJsonPaths) {
    if (!jsonValuesEqual(readJsonPath(surface, path), readJsonPath(parsed.data, path))) {
      throw new Error(
        `llmPolicyEditProposer: redactCurrentSurfaceForModel must not change or hide editable JSON path '${path}'`,
      )
    }
  }
  return parsed.data as AgentProfileJsonObject
}

function formatJsonValidationError(error: z.ZodError): string {
  const messages = [...new Set(collectZodMessages(error.issues))]
  const informative = messages.filter(
    (message) => message !== 'Invalid input' && message !== 'Invalid key in record',
  )
  const custom = informative.filter((message) => !message.startsWith('Invalid input: expected'))
  return (custom.length > 0 ? custom : informative).join('; ') || 'invalid JSON value'
}

function collectZodMessages(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(collectZodMessages)
  if (!value || typeof value !== 'object') return []
  const issue = value as Record<string, unknown>
  return [
    ...(typeof issue.message === 'string' ? [issue.message] : []),
    ...collectZodMessages(issue.errors),
    ...collectZodMessages(issue.issues),
  ]
}

function readJsonPath(root: AgentProfileJsonObject, path: string): AgentProfileJson | undefined {
  let cursor: AgentProfileJson | undefined = root
  for (const part of path
    .split('.')
    .map((segment) => segment.trim())
    .filter(Boolean)) {
    if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor)) return undefined
    cursor = cursor[part]
  }
  return cursor
}

function jsonValuesEqual(
  left: AgentProfileJson | undefined,
  right: AgentProfileJson | undefined,
): boolean {
  if (left === right) return true
  if (left === undefined || right === undefined || left === null || right === null) return false
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => jsonValuesEqual(value, right[index]))
    )
  }
  if (typeof left !== 'object' || typeof right !== 'object') return false
  const leftKeys = Object.keys(left)
  const rightKeys = Object.keys(right)
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key) => Object.hasOwn(right, key) && jsonValuesEqual(left[key], right[key]))
  )
}

interface CitableFinding {
  finding: AnalystFinding
  sources: PolicyEditFindingSource[]
  evidenceRefs: EvidenceRef[]
}

function citableFindings(
  inputs: readonly PolicyEditFindingInput[],
  measuredSources: ReadonlyMap<string, PolicyEditFindingMeasurement>,
  limit: number,
): CitableFinding[] {
  if (inputs.length === 0) {
    throw new Error('llmPolicyEditProposer: at least one analyst finding is required')
  }
  const findings: AnalystFinding[] = []
  for (const input of inputs) {
    if (!isPolicyEditFindingInput(input)) {
      throw new Error(
        'llmPolicyEditProposer: ctx.findings must contain attributed PolicyEditFindingInput rows',
      )
    }
    findings.push(input.finding)
  }
  assertNoJudgeVerdict(findings, 'llmPolicyEditProposer')
  const grouped = new Map<string, CitableFinding>()
  for (const input of inputs) {
    validateFindingSource(input.source, measuredSources)
    if (input.finding.evidence_refs.length === 0) continue
    const existing = grouped.get(input.finding.finding_id)
    if (existing) {
      if (
        existing.finding.analyst_id !== input.finding.analyst_id ||
        existing.finding.area !== input.finding.area ||
        existing.finding.claim !== input.finding.claim ||
        existing.finding.subject !== input.finding.subject
      ) {
        throw new Error(
          `llmPolicyEditProposer: finding '${input.finding.finding_id}' has conflicting content`,
        )
      }
      if (!existing.sources.some((source) => sameFindingSource(source, input.source))) {
        existing.sources.push(input.source)
      }
      existing.evidenceRefs = uniqueEvidenceRefs([
        ...existing.evidenceRefs,
        ...input.finding.evidence_refs,
      ])
      continue
    }
    grouped.set(input.finding.finding_id, {
      finding: input.finding,
      sources: [input.source],
      evidenceRefs: uniqueEvidenceRefs(input.finding.evidence_refs),
    })
  }
  if (grouped.size === 0) {
    throw new Error('llmPolicyEditProposer: no evidence-bearing findings are available')
  }
  const severityRank: Record<AnalystFinding['severity'], number> = {
    critical: 0,
    high: 1,
    medium: 2,
    low: 3,
    info: 4,
  }
  return [...grouped.values()]
    .sort(
      (a, b) =>
        severityRank[a.finding.severity] - severityRank[b.finding.severity] ||
        b.finding.confidence - a.finding.confidence ||
        a.finding.finding_id.localeCompare(b.finding.finding_id),
    )
    .slice(0, limit)
}

function isAnalystFindingLike(input: unknown): input is AnalystFinding {
  if (!input || typeof input !== 'object') return false
  const value = input as Partial<AnalystFinding>
  return (
    typeof value.finding_id === 'string' &&
    typeof value.analyst_id === 'string' &&
    typeof value.claim === 'string' &&
    Array.isArray(value.evidence_refs)
  )
}

function isPolicyEditFindingInput(input: unknown): input is PolicyEditFindingInput {
  if (!input || typeof input !== 'object') return false
  const value = input as Partial<PolicyEditFindingInput>
  return isAnalystFindingLike(value.finding) && isFindingSource(value.source)
}

function isFindingSource(input: unknown): input is PolicyEditFindingSource {
  if (!input || typeof input !== 'object') return false
  const value = input as Partial<PolicyEditFindingSource>
  if (value.kind === 'surface') {
    return typeof value.surfaceHash === 'string' && Number.isSafeInteger(value.generation)
  }
  return value.kind === 'global' && typeof value.label === 'string' && value.label.trim().length > 0
}

function renderFinding(
  context: CitableFinding,
  findingKey: string,
  scenarioIds: ScenarioIdProjector,
  measuredSources: ReadonlyMap<string, PolicyEditFindingMeasurement>,
): Record<string, unknown> {
  const { finding } = context
  return {
    findingKey,
    sources: context.sources.map((source) =>
      source.kind === 'surface'
        ? {
            ...measuredSources.get(sourceKey(source.surfaceHash, source.generation))!,
            surfaceHash: scenarioIds.sanitize(source.surfaceHash),
            kind: 'surface',
          }
        : { kind: 'global', label: scenarioIds.sanitize(source.label) },
    ),
    analystId: scenarioIds.sanitize(finding.analyst_id),
    area: scenarioIds.sanitize(finding.area),
    severity: finding.severity,
    subject: finding.subject ? scenarioIds.sanitize(finding.subject) : null,
    claim: scenarioIds.sanitize(finding.claim),
    rationale: finding.rationale ? scenarioIds.sanitize(finding.rationale) : null,
    recommendedAction: finding.recommended_action
      ? scenarioIds.sanitize(finding.recommended_action)
      : null,
    validationPlan: finding.validation_plan ? scenarioIds.sanitize(finding.validation_plan) : null,
    confidence: finding.confidence,
    evidenceRefs: context.evidenceRefs.map((ref) => ({
      kind: ref.kind,
      uri: scenarioIds.sanitize(ref.uri),
      excerpt: ref.excerpt ? scenarioIds.sanitize(ref.excerpt) : null,
    })),
  }
}

function uniqueEvidenceRefs(refs: readonly EvidenceRef[]): EvidenceRef[] {
  const seen = new Set<string>()
  return refs.filter((ref) => {
    const key = JSON.stringify([ref.kind, ref.uri, ref.excerpt ?? null])
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function validateAllowedJsonPaths(paths: readonly string[]): string[] {
  if (paths.length === 0) {
    throw new Error('llmPolicyEditProposer: allowedJsonPaths must not be empty')
  }
  for (const path of paths) {
    if (!path || path.trim() !== path) {
      throw new Error(
        'llmPolicyEditProposer: allowedJsonPaths must contain trimmed non-empty paths',
      )
    }
  }
  if (new Set(paths).size !== paths.length) {
    throw new Error('llmPolicyEditProposer: allowedJsonPaths must be unique')
  }
  return [...paths]
}

function requireNonEmpty(value: string, field: string): void {
  if (!value || value.trim() !== value) {
    throw new Error(`llmPolicyEditProposer: ${field} must be a trimmed non-empty string`)
  }
}
