import { z } from 'zod'
import type { AgentProfileJson } from '../../agent-profile-cell'
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
  type PolicyEditTargetSurface,
  validatePolicyEditCandidateRecord,
} from '../../analyst/policy-edit'
import { assertNoJudgeVerdict } from '../../analyst/steer-firewall'
import type { AnalystFinding, EvidenceRef } from '../../analyst/types'
import { callLlmJson, type LlmClientOptions } from '../../llm-client'
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

const NonEmptyStringSchema = z.string().trim().min(1)

const JsonValueSchema: z.ZodType<AgentProfileJson> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(NonEmptyStringSchema, JsonValueSchema),
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
        findingIds: z
          .array(NonEmptyStringSchema)
          .min(1)
          .refine((ids) => new Set(ids).size === ids.length, 'findingIds must be unique'),
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
            required: ['findingIds'],
            properties: {
              findingIds: {
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

function policyEditAuthorJsonSchema(maxItems: number): Record<string, unknown> {
  const schema = JSON.parse(JSON.stringify(POLICY_EDIT_AUTHOR_JSON_SCHEMA)) as Record<
    string,
    unknown
  >
  const properties = schema.properties as Record<string, unknown>
  const edits = properties.edits as Record<string, unknown>
  edits.maxItems = maxItems
  return schema
}

export const DEFAULT_POLICY_EDIT_HISTORY_LIMITS = Object.freeze({
  generations: 4,
  candidatesPerGeneration: 16,
})

export interface PolicyEditHistoryProjectionOptions {
  /** Number of most recent generations retained. Default: 4. */
  maxGenerations?: number
  /** Number of candidates retained per generation. Default: 16. */
  maxCandidatesPerGeneration?: number
  /** Optional pseudonymizer applied before scenario IDs enter author text. */
  scenarioIdTransform?: (scenarioId: string) => string
}

export interface PolicyEditHistoryCandidateContext {
  surfaceHash: string
  parentSurfaceHash: string | null
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
  candidateRecord: PolicyEditCandidateRecord | null
}

export interface PolicyEditOutcomeContext {
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
  'Every edit must cite one or more supplied finding IDs in source.findingIds. Do not emit analyst IDs or evidence references; the caller binds those from the cited findings.',
  'Treat expectedGain and confidence as forecasts, never as measured evidence. Learn from baselineOutcome, incumbentOutcome, and observedDeltaFromParent.',
  'Do not invent a finding, path, field, score, or task fact. Do not include schemaVersion, editId, metadata, prose, or undeclared keys.',
].join('\n')

export interface LlmPolicyEditProposerOptions {
  llm: LlmClientOptions
  model: string
  /** Plain-language description of the JSON surface being improved. */
  target: string
  /** PolicyEdit target surface every authored edit must retain. */
  targetSurface: PolicyEditTargetSurface
  /** Exact JSON paths the author may change. Prefix or fuzzy matches are not accepted. */
  allowedJsonPaths: readonly string[]
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
  /** Optional pseudonymizer applied before scenario IDs enter author text. */
  historyScenarioIdTransform?: (scenarioId: string) => string
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
): SurfaceProposer<AnalystFinding> {
  const allowedJsonPaths = validateAllowedJsonPaths(opts.allowedJsonPaths)
  const allowedPathSet = new Set(allowedJsonPaths)
  requireNonEmpty(opts.model, 'model')
  requireNonEmpty(opts.target, 'target')
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
    ...(opts.historyScenarioIdTransform === undefined
      ? {}
      : { scenarioIdTransform: opts.historyScenarioIdTransform }),
  })

  return {
    kind: 'llm-policy-edit',
    async propose(
      ctx: ProposeContext<AnalystFinding>,
    ): Promise<Array<MutableSurface | ProposedCandidate>> {
      const limit = Math.min(ctx.populationSize, opts.maxCandidates ?? ctx.populationSize)
      if (limit <= 0) return []

      const currentSurface = parseJsonSurface(ctx.currentSurface)
      const findings = citableFindings(ctx.findings)
      const findingById = new Map(findings.map((finding) => [finding.finding_id, finding]))
      const { value } = await callLlmJson<unknown>(
        {
          model: opts.model,
          messages: [
            { role: 'system', content: POLICY_EDIT_AUTHOR_SYSTEM },
            {
              role: 'user',
              content: JSON.stringify({
                target: opts.target,
                targetSurface: opts.targetSurface,
                allowedJsonPaths,
                candidateCount: limit,
                generation: ctx.generation,
                currentSurface,
                findings: findings.map(renderFinding),
                baselineOutcome: projectOutcome(
                  ctx.baselineOutcome,
                  historyLimits.scenarioIdTransform,
                ),
                incumbentOutcome: projectOutcome(
                  ctx.incumbentOutcome,
                  historyLimits.scenarioIdTransform,
                ),
                history: projectPolicyEditHistory(ctx.history, historyLimits),
              }),
            },
          ],
          jsonSchema: {
            name: 'policy_edit_author',
            schema: policyEditAuthorJsonSchema(limit),
          },
          temperature: opts.temperature ?? 0.2,
          maxTokens: opts.maxTokens ?? 6_000,
          timeoutMs: opts.timeoutMs,
        },
        { ...opts.llm, signal: ctx.signal },
      )
      const response = parseAuthorResponse(value)
      if (response.edits.length > limit) {
        throw new Error(
          `llmPolicyEditProposer: author returned ${response.edits.length} edits for ${limit} candidate slots`,
        )
      }
      const edits = response.edits.map((draft) =>
        bindAuthoredEdit(draft, findingById, opts.targetSurface, allowedPathSet),
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
  return history.slice(-limits.maxGenerations).map((record) => {
    const candidates = selectHistoryCandidates(record, limits.maxCandidatesPerGeneration)
    const hashes = new Set(candidates.map((candidate) => candidate.surfaceHash))
    return {
      generationIndex: record.generationIndex,
      promoted: record.promoted.filter((hash) => hashes.has(hash)),
      candidates: candidates.map((candidate) =>
        projectHistoryCandidate(candidate, limits.scenarioIdTransform),
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
  scenarioIdTransform: (scenarioId: string) => string,
): PolicyEditHistoryCandidateContext {
  return {
    surfaceHash: candidate.surfaceHash,
    parentSurfaceHash: candidate.parentSurfaceHash ?? null,
    label: candidate.label ?? null,
    rationale: candidate.rationale ?? null,
    composite: candidate.composite,
    observedDeltaFromParent: candidate.observedDeltaFromParent ?? null,
    eligibleForPromotion: candidate.eligibleForPromotion ?? null,
    coverage: candidate.coverage
      ? {
          expectedCells: candidate.coverage.expectedCells,
          scorableCells: candidate.coverage.scorableCells,
          // `cellId` embeds the raw scenario ID. The aggregate reason is useful
          // for search, but the identifier must not bypass scenarioIdTransform.
          unscorableCells: candidate.coverage.unscorableCells.map((cell) => ({
            reason: cell.reason,
          })),
        }
      : null,
    // GenerationCandidate.ci95 is currently a placeholder [composite, composite],
    // not a measured interval. Keep it out of author context until it is real.
    dimensions: { ...candidate.dimensions },
    scenarios: candidate.scenarios.map((scenario) => {
      const scenarioId = scenarioIdTransform(scenario.scenarioId)
      if (!scenarioId || scenarioId.trim() !== scenarioId) {
        throw new Error(
          'llmPolicyEditProposer: scenarioIdTransform must return a trimmed non-empty string',
        )
      }
      return {
        scenarioId,
        composite: scenario.composite,
        notes: scenario.notes ?? null,
      }
    }),
    candidateRecord: candidate.candidateRecord
      ? validatePolicyEditCandidateRecord(candidate.candidateRecord)
      : null,
  }
}

function projectOutcome(
  outcome: ScoredSurfaceOutcome | undefined,
  scenarioIdTransform: (scenarioId: string) => string,
): PolicyEditOutcomeContext | null {
  if (!outcome) return null
  return {
    surfaceHash: outcome.surfaceHash,
    composite: outcome.composite,
    dimensions: { ...outcome.dimensions },
    scenarios: outcome.scenarios.map((scenario) => {
      const scenarioId = scenarioIdTransform(scenario.scenarioId)
      if (!scenarioId || scenarioId.trim() !== scenarioId) {
        throw new Error(
          'llmPolicyEditProposer: scenarioIdTransform must return a trimmed non-empty string',
        )
      }
      return {
        scenarioId,
        composite: scenario.composite,
        notes: scenario.notes ?? null,
      }
    }),
    coverage: { ...outcome.coverage },
  }
}

function validateHistoryLimits(options: PolicyEditHistoryProjectionOptions): {
  maxGenerations: number
  maxCandidatesPerGeneration: number
  scenarioIdTransform: (scenarioId: string) => string
} {
  const maxGenerations = options.maxGenerations ?? DEFAULT_POLICY_EDIT_HISTORY_LIMITS.generations
  const maxCandidatesPerGeneration =
    options.maxCandidatesPerGeneration ?? DEFAULT_POLICY_EDIT_HISTORY_LIMITS.candidatesPerGeneration
  if (!Number.isSafeInteger(maxGenerations) || maxGenerations <= 0) {
    throw new Error('llmPolicyEditProposer: maxHistoryGenerations must be a positive safe integer')
  }
  if (!Number.isSafeInteger(maxCandidatesPerGeneration) || maxCandidatesPerGeneration <= 0) {
    throw new Error(
      'llmPolicyEditProposer: maxHistoryCandidatesPerGeneration must be a positive safe integer',
    )
  }
  return {
    maxGenerations,
    maxCandidatesPerGeneration,
    scenarioIdTransform: options.scenarioIdTransform ?? ((scenarioId) => scenarioId),
  }
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
  findingById: ReadonlyMap<string, AnalystFinding>,
  targetSurface: PolicyEditTargetSurface,
  allowedPaths: ReadonlySet<string>,
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

  const cited = draft.source.findingIds.map((findingId) => {
    const finding = findingById.get(findingId)
    if (!finding) {
      throw new Error(
        `llmPolicyEditProposer: edit cites unknown or uncitable finding '${findingId}'`,
      )
    }
    return finding
  })
  const evidenceRefs = uniqueEvidenceRefs(cited.flatMap((finding) => finding.evidence_refs))
  if (evidenceRefs.length === 0) {
    throw new Error('llmPolicyEditProposer: authored edit has no cited evidence')
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
      findingIds: draft.source.findingIds,
      analystIds: cited.map((finding) => finding.analyst_id),
      evidenceRefs,
    },
    ...(draft.rationale ? { rationale: draft.rationale } : {}),
    ...(draft.validationPlan ? { validationPlan: draft.validationPlan } : {}),
  }
  return makePolicyEdit(init)
}

function parseJsonSurface(surface: MutableSurface): AgentProfileJson {
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
  return parsed as AgentProfileJson
}

function citableFindings(inputs: readonly AnalystFinding[]): AnalystFinding[] {
  if (inputs.length === 0) {
    throw new Error('llmPolicyEditProposer: at least one analyst finding is required')
  }
  for (const input of inputs) {
    if (!isAnalystFindingLike(input)) {
      throw new Error('llmPolicyEditProposer: ctx.findings contains an invalid AnalystFinding')
    }
  }
  assertNoJudgeVerdict(inputs, 'llmPolicyEditProposer')
  const ids = inputs.map((finding) => finding.finding_id)
  if (new Set(ids).size !== ids.length) {
    throw new Error('llmPolicyEditProposer: finding IDs must be unique')
  }
  const citable = inputs.filter((finding) => finding.evidence_refs.length > 0)
  if (citable.length === 0) {
    throw new Error('llmPolicyEditProposer: no evidence-bearing findings are available')
  }
  return citable
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

function renderFinding(finding: AnalystFinding): Record<string, unknown> {
  return {
    findingId: finding.finding_id,
    analystId: finding.analyst_id,
    area: finding.area,
    severity: finding.severity,
    claim: finding.claim,
    rationale: finding.rationale ?? null,
    recommendedAction: finding.recommended_action ?? null,
    confidence: finding.confidence,
    evidenceRefs: finding.evidence_refs,
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
