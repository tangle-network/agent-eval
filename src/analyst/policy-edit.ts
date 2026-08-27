import { createHash } from 'node:crypto'
import type { AgentProfileCell, AgentProfileJson } from '../agent-profile-cell'
import { validateAgentProfileCell } from '../agent-profile-cell'
import { ValidationError } from '../errors'
import { canonicalize } from '../pre-registration'
import { type FindingSubject, parseFindingSubject } from './finding-subject'
import { assertNoJudgeVerdict } from './steer-firewall'
import type { AnalystFinding, EvidenceRef } from './types'

export type PolicyEditSchemaVersion = 'policy-edit/v1'

export const POLICY_EDIT_AXES = [
  'carrier',
  'representation',
  'budget',
  'sampling',
  'output_contract',
  'tool_contract',
  'routing',
  'memory',
  'agent_profile',
  'deployment_target',
] as const

export type PolicyEditAxis = (typeof POLICY_EDIT_AXES)[number]

export const POLICY_EDIT_TARGET_SURFACES = [
  'prompt',
  'tool-contract',
  'runtime-config',
  'memory',
  'agent-profile',
  'code',
  'deployment',
] as const

export type PolicyEditTargetSurface = (typeof POLICY_EDIT_TARGET_SURFACES)[number]
export type PolicyEditRisk = 'low' | 'medium' | 'high' | 'unknown'
export type PolicyEditGainDirection = 'increase' | 'decrease'
export type PolicyEditGainUnit = 'absolute' | 'relative' | 'percent' | 'score'

export interface PolicyEditTarget {
  surface: PolicyEditTargetSurface
  /** Stable path inside the target surface, for example `system-prompt:tools`
   * or `budget.maxTurns`. */
  path?: string
  /** Optional canonical deployment identity. Store the existing cell, not a
   * local profile shape. */
  agentProfileCell?: AgentProfileCell
  /** Human label when the path is not enough for a readable audit trail. */
  label?: string
}

export type PolicyEditChange =
  | {
      kind: 'text'
      mode: 'append' | 'prepend' | 'replace'
      value: string
      /** Required when `mode === 'replace'`; exact match only. */
      find?: string
    }
  | {
      kind: 'json'
      mode: 'set' | 'merge' | 'remove'
      path: string
      value?: AgentProfileJson
    }

export interface PolicyEditExpectedGain {
  /** Metric this edit is expected to move, e.g. `holdout.composite`. */
  metric: string
  direction: PolicyEditGainDirection
  /** Positive magnitude in the metric's native units. */
  amount: number
  unit?: PolicyEditGainUnit
  rationale?: string
}

export interface PolicyEditSource {
  findingIds: string[]
  analystIds: string[]
  evidenceRefs: EvidenceRef[]
  /** Mirrors `AnalystFinding.derived_from_judge`; admission rejects it. */
  derivedFromJudge?: boolean
}

export interface PolicyEdit {
  schemaVersion: PolicyEditSchemaVersion
  editId: string
  axis: PolicyEditAxis
  target: PolicyEditTarget
  change: PolicyEditChange
  claim: string
  expectedGain: PolicyEditExpectedGain
  confidence: number
  risk: PolicyEditRisk
  source: PolicyEditSource
  rationale?: string
  validationPlan?: string
  metadata?: Record<string, unknown>
}

export const POLICY_EDIT_CANDIDATE_RECORD_SCHEMA = 'tangle.policy-edit-candidate.v1' as const

/** JSON-safe attribution carried with a measured candidate and its scores. */
export interface PolicyEditCandidateRecord {
  schema: typeof POLICY_EDIT_CANDIDATE_RECORD_SCHEMA
  policyEdit: PolicyEdit
}

export type PolicyEditInit = Omit<PolicyEdit, 'schemaVersion' | 'editId'> & {
  schemaVersion?: PolicyEditSchemaVersion
  editId?: string
}

export class PolicyEditValidationError extends ValidationError {
  readonly path: string
  constructor(message: string, path = '') {
    super(path ? `${message} (at ${path})` : message)
    this.path = path
  }
}

export interface FindingToPolicyEditOptions {
  expectedGain?:
    | PolicyEditExpectedGain
    | ((finding: AnalystFinding) => PolicyEditExpectedGain | null | undefined)
  risk?: PolicyEditRisk | ((finding: AnalystFinding) => PolicyEditRisk)
  defaultAxis?: PolicyEditAxis
  defaultTargetSurface?: PolicyEditTargetSurface
}

export interface PolicyEditAdmissionOptions {
  minScore?: number
  minExpectedGain?: number
  allowHighRisk?: boolean
  requireEvidence?: boolean
}

export interface PolicyEditAdmission {
  edit: PolicyEdit
  decision: 'admit' | 'reject'
  score: number
  reasons: string[]
}

const DEFAULT_MIN_SCORE = 0.7
const DEFAULT_MIN_EXPECTED_GAIN = 0.01
const POLICY_EDIT_ID = /^policy-edit:sha256:[0-9a-f]{64}$/

export function makePolicyEdit(init: PolicyEditInit): PolicyEdit {
  const normalized = normalizePolicyEdit({
    schemaVersion: 'policy-edit/v1',
    ...init,
    source: normalizeSource(init.source),
  })
  const edit = {
    ...normalized,
    editId: init.editId ?? computePolicyEditId(normalized),
  }
  return validatePolicyEdit(edit)
}

export function computePolicyEditId(edit: Omit<PolicyEdit, 'editId'> | PolicyEdit): string {
  const { editId: _editId, schemaVersion, ...material } = edit as PolicyEdit
  void _editId
  const canonical = JSON.stringify(canonicalize({ schemaVersion, ...material }))
  return `policy-edit:sha256:${createHash('sha256').update(canonical).digest('hex')}`
}

export function validatePolicyEdit(input: unknown): PolicyEdit {
  if (input === null || typeof input !== 'object') {
    throw new PolicyEditValidationError('expected object')
  }
  const obj = input as PolicyEdit
  expectLiteral(obj.schemaVersion, 'policy-edit/v1', 'schemaVersion')
  expectString(obj.editId, 'editId')
  if (!POLICY_EDIT_ID.test(obj.editId)) {
    throw new PolicyEditValidationError(
      'editId must match policy-edit:sha256:<64 lowercase hex chars>',
      'editId',
    )
  }
  expectOneOf(obj.axis, POLICY_EDIT_AXES, 'axis')
  validateTarget(obj.target)
  validateChange(obj.change)
  expectString(obj.claim, 'claim')
  validateExpectedGain(obj.expectedGain)
  expectConfidence(obj.confidence, 'confidence')
  expectOneOf(obj.risk, ['low', 'medium', 'high', 'unknown'] as const, 'risk')
  validateSource(obj.source)
  if (obj.rationale !== undefined) expectString(obj.rationale, 'rationale')
  if (obj.validationPlan !== undefined) expectString(obj.validationPlan, 'validationPlan')
  if (obj.metadata !== undefined && (obj.metadata === null || typeof obj.metadata !== 'object')) {
    throw new PolicyEditValidationError('expected object', 'metadata')
  }
  const expectedId = computePolicyEditId(obj)
  if (obj.editId !== expectedId) {
    throw new PolicyEditValidationError('editId does not match policy edit content', 'editId')
  }
  return obj
}

export function makePolicyEditCandidateRecord(edit: PolicyEdit): PolicyEditCandidateRecord {
  return validatePolicyEditCandidateRecord({
    schema: POLICY_EDIT_CANDIDATE_RECORD_SCHEMA,
    policyEdit: edit,
  })
}

export function validatePolicyEditCandidateRecord(input: unknown): PolicyEditCandidateRecord {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new PolicyEditValidationError('expected object', 'candidateRecord')
  }
  const obj = input as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  if (keys.length !== 2 || keys[0] !== 'policyEdit' || keys[1] !== 'schema') {
    throw new PolicyEditValidationError('expected exactly schema and policyEdit', 'candidateRecord')
  }
  expectLiteral(obj.schema, POLICY_EDIT_CANDIDATE_RECORD_SCHEMA, 'candidateRecord.schema')
  const policyEdit = validatePolicyEdit(obj.policyEdit)
  assertJsonSafe(policyEdit, 'candidateRecord.policyEdit')
  const snapshot = JSON.parse(JSON.stringify(policyEdit)) as unknown
  return {
    schema: POLICY_EDIT_CANDIDATE_RECORD_SCHEMA,
    policyEdit: validatePolicyEdit(snapshot),
  }
}

export function isPolicyEdit(input: unknown): input is PolicyEdit {
  try {
    validatePolicyEdit(input)
    return true
  } catch {
    return false
  }
}

export function policyEditsFromFindings(
  findings: ReadonlyArray<AnalystFinding>,
  opts: FindingToPolicyEditOptions = {},
): PolicyEdit[] {
  assertNoJudgeVerdict(findings, 'policyEditsFromFindings')
  const edits: PolicyEdit[] = []
  for (const finding of findings) {
    const edit = policyEditFromFinding(finding, opts)
    if (edit) edits.push(edit)
  }
  return edits
}

export function policyEditFromFinding(
  finding: AnalystFinding,
  opts: FindingToPolicyEditOptions = {},
): PolicyEdit | null {
  assertNoJudgeVerdict([finding], 'policyEditFromFinding')
  if (!finding.recommended_action?.trim()) return null

  const expectedGain = resolveExpectedGain(finding, opts)
  if (!expectedGain) return null

  const routed = routeFindingSubject(finding.subject, opts)
  const risk = resolveRisk(finding, opts)
  return makePolicyEdit({
    axis: routed.axis,
    target: routed.target,
    change: { kind: 'text', mode: 'append', value: finding.recommended_action.trim() },
    claim: finding.claim,
    rationale: finding.rationale,
    expectedGain,
    confidence: finding.confidence,
    risk,
    validationPlan: finding.validation_plan,
    source: {
      findingIds: [finding.finding_id],
      analystIds: [finding.analyst_id],
      evidenceRefs: finding.evidence_refs,
      derivedFromJudge: finding.derived_from_judge,
    },
  })
}

export function scorePolicyEditReadiness(
  edit: PolicyEdit,
  opts: PolicyEditAdmissionOptions = {},
): number {
  validatePolicyEdit(edit)
  const minExpectedGain = opts.minExpectedGain ?? DEFAULT_MIN_EXPECTED_GAIN
  const evidenceScore = Math.min(1, edit.source.evidenceRefs.length / 2)
  const confidenceScore = clamp01(edit.confidence)
  const gainScore = clamp01(
    Math.abs(edit.expectedGain.amount) / Math.max(minExpectedGain * 5, 0.001),
  )
  const targetScore = targetSpecificityScore(edit)
  const riskPenalty =
    edit.risk === 'high' && opts.allowHighRisk !== true ? 0.35 : edit.risk === 'unknown' ? 0.2 : 0

  return clamp01(
    0.3 * evidenceScore +
      0.25 * confidenceScore +
      0.25 * gainScore +
      0.2 * targetScore -
      riskPenalty,
  )
}

export function admitPolicyEdit(
  edit: PolicyEdit,
  opts: PolicyEditAdmissionOptions = {},
): PolicyEditAdmission {
  const validated = validatePolicyEdit(edit)
  const score = scorePolicyEditReadiness(validated, opts)
  const reasons: string[] = []
  const minExpectedGain = opts.minExpectedGain ?? DEFAULT_MIN_EXPECTED_GAIN
  const requireEvidence = opts.requireEvidence ?? true

  if (validated.source.derivedFromJudge) {
    reasons.push('source is judge-derived; judge verdicts cannot steer policy edits')
  }
  if (requireEvidence && validated.source.evidenceRefs.length === 0) {
    reasons.push('missing evidence refs')
  }
  if (Math.abs(validated.expectedGain.amount) < minExpectedGain) {
    reasons.push(`expected gain below ${minExpectedGain}`)
  }
  if (validated.risk === 'high' && opts.allowHighRisk !== true) {
    reasons.push('high-risk edit requires explicit allowHighRisk')
  }
  if (score < (opts.minScore ?? DEFAULT_MIN_SCORE)) {
    reasons.push(
      `readiness score ${score.toFixed(3)} below ${(opts.minScore ?? DEFAULT_MIN_SCORE).toFixed(3)}`,
    )
  }

  return {
    edit: validated,
    decision: reasons.length === 0 ? 'admit' : 'reject',
    score,
    reasons,
  }
}

export function applyPolicyEditToSurface(surface: unknown, edit: PolicyEdit): unknown {
  const validated = validatePolicyEdit(edit)
  if (validated.change.kind === 'text') return applyTextChange(surface, validated.change)
  return applyJsonChange(surface, validated.change)
}

function routeFindingSubject(
  subject: string | undefined,
  opts: FindingToPolicyEditOptions,
): { axis: PolicyEditAxis; target: PolicyEditTarget } {
  const parsed = parseFindingSubject(subject)
  if (!parsed) {
    return {
      axis: opts.defaultAxis ?? 'representation',
      target: { surface: opts.defaultTargetSurface ?? 'prompt' },
    }
  }
  return routeParsedSubject(parsed)
}

function routeParsedSubject(subject: FindingSubject): {
  axis: PolicyEditAxis
  target: PolicyEditTarget
} {
  switch (subject.kind) {
    case 'system-prompt':
      return {
        axis: 'representation',
        target: { surface: 'prompt', path: `system-prompt:${subject.section}` },
      }
    case 'skill':
      return {
        axis: 'agent_profile',
        target: { surface: 'agent-profile', path: `skill:${subject.name}` },
      }
    case 'tool-doc':
      return {
        axis: 'tool_contract',
        target: {
          surface: 'tool-contract',
          path: subject.aspect
            ? `tool-doc:${subject.tool}:${subject.aspect}`
            : `tool-doc:${subject.tool}`,
        },
      }
    case 'new-tool':
      return {
        axis: 'tool_contract',
        target: { surface: 'tool-contract', path: `new-tool:${subject.name}` },
      }
    case 'mcp':
      return {
        axis: 'tool_contract',
        target: {
          surface: 'agent-profile',
          path: subject.tool ? `mcp:${subject.server}:${subject.tool}` : `mcp:${subject.server}`,
        },
      }
    case 'hook':
      return {
        axis: 'agent_profile',
        target: { surface: 'agent-profile', path: `hook:${subject.name}` },
      }
    case 'subagent':
      return {
        axis: 'routing',
        target: { surface: 'agent-profile', path: `subagent:${subject.name}` },
      }
    case 'workflow':
      return {
        axis: 'routing',
        target: { surface: 'runtime-config', path: `workflow:${subject.name}` },
      }
    case 'rollout-policy':
      return {
        axis: rolloutPolicyAxis(subject.field),
        target: { surface: 'runtime-config', path: `rollout-policy:${subject.field}` },
      }
    case 'agent-profile':
      return {
        axis: 'agent_profile',
        target: { surface: 'agent-profile', path: `agent-profile:${subject.field}` },
      }
    case 'code':
      return {
        axis: 'representation',
        target: { surface: 'code', path: `code:${subject.path}` },
      }
    case 'rag':
      return {
        axis: 'memory',
        target: { surface: 'memory', path: `rag:${subject.corpus}:${subject.docId}` },
      }
    case 'memory':
      return { axis: 'memory', target: { surface: 'memory', path: `memory:${subject.key}` } }
    case 'scaffolding':
      return {
        axis: 'routing',
        target: { surface: 'runtime-config', path: `scaffolding:${subject.concern}` },
      }
    case 'output-schema':
      return {
        axis: 'output_contract',
        target: { surface: 'runtime-config', path: `output-schema:${subject.field}` },
      }
    case 'knowledge.wiki':
      return {
        axis: 'memory',
        target: {
          surface: 'memory',
          path: `agent-knowledge:wiki:${subject.slug}${subject.heading ? `#${subject.heading}` : ''}`,
        },
      }
    case 'knowledge.claim':
      return {
        axis: 'memory',
        target: { surface: 'memory', path: `agent-knowledge:claim:${subject.topic}` },
      }
    case 'knowledge.raw':
      return {
        axis: 'memory',
        target: { surface: 'memory', path: `agent-knowledge:raw:${subject.sourceId}` },
      }
    case 'knowledge.stale':
      return {
        axis: 'memory',
        target: { surface: 'memory', path: `agent-knowledge:stale:${subject.slug}` },
      }
    case 'websearch.outdated':
      return {
        axis: 'memory',
        target: { surface: 'memory', path: `websearch:outdated:${subject.topic}` },
      }
    case 'prior-run-summary':
      return {
        axis: 'memory',
        target: { surface: 'memory', path: `prior-run-summary:${subject.topic}` },
      }
    case 'cluster':
      return { axis: 'representation', target: { surface: 'prompt', path: subject.label } }
  }
}

function rolloutPolicyAxis(field: string): PolicyEditAxis {
  const normalized = field.toLowerCase()
  if (/budget|max(?:imum)?[-_. ]?(?:turns?|tokens?|cost)|timeout|deadline/.test(normalized)) {
    return 'budget'
  }
  if (/temperature|top[-_. ]?p|sampling|seed|shots?|parallel|concurrency/.test(normalized)) {
    return 'sampling'
  }
  if (/output|schema|format/.test(normalized)) return 'output_contract'
  return 'routing'
}

function resolveExpectedGain(
  finding: AnalystFinding,
  opts: FindingToPolicyEditOptions,
): PolicyEditExpectedGain | null {
  if (typeof opts.expectedGain === 'function') return opts.expectedGain(finding) ?? null
  if (opts.expectedGain) return opts.expectedGain
  return readExpectedGainFromMetadata(finding.metadata)
}

function readExpectedGainFromMetadata(
  metadata: Record<string, unknown> | undefined,
): PolicyEditExpectedGain | null {
  const raw =
    readPolicyEditMetadata(metadata)?.expectedGain ??
    readPolicyEditMetadata(metadata)?.expected_gain
  if (!raw || typeof raw !== 'object') return null
  const obj = raw as Record<string, unknown>
  if (
    typeof obj.metric !== 'string' ||
    (obj.direction !== 'increase' && obj.direction !== 'decrease') ||
    typeof obj.amount !== 'number'
  ) {
    return null
  }
  const out: PolicyEditExpectedGain = {
    metric: obj.metric,
    direction: obj.direction,
    amount: obj.amount,
  }
  if (
    obj.unit === 'absolute' ||
    obj.unit === 'relative' ||
    obj.unit === 'percent' ||
    obj.unit === 'score'
  ) {
    out.unit = obj.unit
  }
  if (typeof obj.rationale === 'string') out.rationale = obj.rationale
  return out
}

function readPolicyEditMetadata(
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> | null {
  const raw = metadata?.policyEdit ?? metadata?.policy_edit
  return raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null
}

function resolveRisk(finding: AnalystFinding, opts: FindingToPolicyEditOptions): PolicyEditRisk {
  if (typeof opts.risk === 'function') return opts.risk(finding)
  if (opts.risk) return opts.risk
  const raw = readPolicyEditMetadata(finding.metadata)?.risk
  if (raw === 'low' || raw === 'medium' || raw === 'high' || raw === 'unknown') return raw
  if (finding.severity === 'critical' || finding.severity === 'high') return 'medium'
  return 'low'
}

function applyTextChange(
  surface: unknown,
  change: Extract<PolicyEditChange, { kind: 'text' }>,
): string {
  if (typeof surface !== 'string') {
    throw new PolicyEditValidationError('text policy edits require a string surface', 'change')
  }
  if (change.mode === 'append') {
    if (hasExactTextBlock(surface, change.value)) return surface
    return `${surface.trimEnd()}\n\n${change.value}`.trimStart()
  }
  if (change.mode === 'prepend') {
    if (hasExactTextBlock(surface, change.value)) return surface
    return `${change.value}\n\n${surface.trimStart()}`.trimEnd()
  }
  const find = expectNonEmpty(change.find, 'change.find')
  if (!surface.includes(find)) {
    throw new PolicyEditValidationError('replace target not found in surface', 'change.find')
  }
  return surface.replace(find, change.value)
}

function applyJsonChange(
  surface: unknown,
  change: Extract<PolicyEditChange, { kind: 'json' }>,
): AgentProfileJson {
  const root = parseJsonSurface(surface)
  const path = splitPath(change.path)
  if (change.mode === 'remove') return setJsonAtPath(root, path, undefined, 'remove')
  if (change.mode === 'set') return setJsonAtPath(root, path, change.value ?? null, 'set')
  const prior = readJsonAtPath(root, path)
  const merged =
    prior &&
    typeof prior === 'object' &&
    !Array.isArray(prior) &&
    change.value &&
    typeof change.value === 'object' &&
    !Array.isArray(change.value)
      ? { ...prior, ...change.value }
      : (change.value ?? null)
  return setJsonAtPath(root, path, merged as AgentProfileJson, 'set')
}

function parseJsonSurface(surface: unknown): AgentProfileJson {
  if (typeof surface === 'string') {
    try {
      return JSON.parse(surface) as AgentProfileJson
    } catch {
      throw new PolicyEditValidationError(
        'json policy edits require a JSON string surface',
        'change',
      )
    }
  }
  assertJson(surface, 'surface')
  return surface as AgentProfileJson
}

function readJsonAtPath(root: AgentProfileJson, path: string[]): AgentProfileJson | undefined {
  let cursor: AgentProfileJson | undefined = root
  for (const part of path) {
    if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor)) return undefined
    cursor = cursor[part]
  }
  return cursor
}

function setJsonAtPath(
  root: AgentProfileJson,
  path: string[],
  value: AgentProfileJson | undefined,
  mode: 'set' | 'remove',
): AgentProfileJson {
  if (path.length === 0) {
    if (mode === 'remove') return null
    return value ?? null
  }
  if (root === null || typeof root !== 'object' || Array.isArray(root)) {
    throw new PolicyEditValidationError('json edit root must be an object', 'change.path')
  }
  const out: Record<string, AgentProfileJson> = { ...root }
  let cursor: Record<string, AgentProfileJson> = out
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i]!
    const existing = cursor[key]
    if (
      mode === 'remove' &&
      (!existing || typeof existing !== 'object' || Array.isArray(existing))
    ) {
      return out
    }
    const next =
      existing && typeof existing === 'object' && !Array.isArray(existing) ? { ...existing } : {}
    cursor[key] = next
    cursor = next
  }
  const leaf = path[path.length - 1]!
  if (mode === 'remove') delete cursor[leaf]
  else cursor[leaf] = value ?? null
  return out
}

function normalizePolicyEdit(input: Omit<PolicyEdit, 'editId'>): Omit<PolicyEdit, 'editId'> {
  const out: Omit<PolicyEdit, 'editId'> = {
    schemaVersion: 'policy-edit/v1',
    axis: input.axis,
    target: normalizeTarget(input.target),
    change: normalizeChange(input.change),
    claim: input.claim.trim(),
    expectedGain: normalizeExpectedGain(input.expectedGain),
    confidence: input.confidence,
    risk: input.risk,
    source: normalizeSource(input.source),
  }
  if (input.rationale?.trim()) out.rationale = input.rationale.trim()
  if (input.validationPlan?.trim()) out.validationPlan = input.validationPlan.trim()
  if (input.metadata) out.metadata = input.metadata
  return out
}

function assertJsonSafe(value: unknown, path: string, ancestors = new WeakSet<object>()): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return
    throw new PolicyEditValidationError('expected finite JSON number', path)
  }
  if (typeof value !== 'object') {
    throw new PolicyEditValidationError('expected JSON-safe value', path)
  }
  if (ancestors.has(value)) {
    throw new PolicyEditValidationError('cyclic value is not JSON-safe', path)
  }
  ancestors.add(value)
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      if (!(i in value)) {
        throw new PolicyEditValidationError('sparse array is not JSON-safe', `${path}.${i}`)
      }
      assertJsonSafe(value[i], `${path}.${i}`, ancestors)
    }
  } else {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      throw new PolicyEditValidationError('expected plain JSON object', path)
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new PolicyEditValidationError('symbol keys are not JSON-safe', path)
    }
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      assertJsonSafe(child, `${path}.${key}`, ancestors)
    }
  }
  ancestors.delete(value)
}

function normalizeTarget(target: PolicyEditTarget): PolicyEditTarget {
  const out: PolicyEditTarget = { surface: target.surface }
  if (target.path?.trim()) out.path = target.path.trim()
  if (target.agentProfileCell)
    out.agentProfileCell = validateAgentProfileCell(target.agentProfileCell)
  if (target.label?.trim()) out.label = target.label.trim()
  return out
}

function normalizeChange(change: PolicyEditChange): PolicyEditChange {
  if (change.kind === 'text') {
    const out: Extract<PolicyEditChange, { kind: 'text' }> = {
      kind: 'text',
      mode: change.mode,
      value: change.value.trim(),
    }
    if (change.find?.trim()) out.find = change.find.trim()
    return out
  }
  const out: Extract<PolicyEditChange, { kind: 'json' }> = {
    kind: 'json',
    mode: change.mode,
    path: change.path.trim(),
  }
  if (change.value !== undefined) out.value = change.value
  return out
}

function normalizeExpectedGain(gain: PolicyEditExpectedGain): PolicyEditExpectedGain {
  const out: PolicyEditExpectedGain = {
    metric: gain.metric.trim(),
    direction: gain.direction,
    amount: gain.amount,
  }
  if (gain.unit) out.unit = gain.unit
  if (gain.rationale?.trim()) out.rationale = gain.rationale.trim()
  return out
}

function normalizeSource(source: PolicyEditSource): PolicyEditSource {
  const out: PolicyEditSource = {
    findingIds: uniqueSorted(source.findingIds.map((s) => s.trim()).filter(Boolean)),
    analystIds: uniqueSorted(source.analystIds.map((s) => s.trim()).filter(Boolean)),
    evidenceRefs: source.evidenceRefs,
  }
  if (source.derivedFromJudge) out.derivedFromJudge = true
  return out
}

function validateTarget(target: unknown): asserts target is PolicyEditTarget {
  if (!target || typeof target !== 'object')
    throw new PolicyEditValidationError('expected object', 'target')
  const obj = target as PolicyEditTarget
  expectOneOf(obj.surface, POLICY_EDIT_TARGET_SURFACES, 'target.surface')
  if (obj.path !== undefined) expectString(obj.path, 'target.path')
  if (obj.label !== undefined) expectString(obj.label, 'target.label')
  if (obj.agentProfileCell !== undefined) validateAgentProfileCell(obj.agentProfileCell)
}

function validateChange(change: unknown): asserts change is PolicyEditChange {
  if (!change || typeof change !== 'object')
    throw new PolicyEditValidationError('expected object', 'change')
  const obj = change as PolicyEditChange
  if (obj.kind !== 'text' && obj.kind !== 'json') {
    throw new PolicyEditValidationError('kind must be text or json', 'change.kind')
  }
  if (obj.kind === 'text') {
    expectOneOf(obj.mode, ['append', 'prepend', 'replace'] as const, 'change.mode')
    expectString(obj.value, 'change.value')
    if (obj.mode === 'replace') expectString(obj.find, 'change.find')
    return
  }
  expectOneOf(obj.mode, ['set', 'merge', 'remove'] as const, 'change.mode')
  expectString(obj.path, 'change.path')
  if (obj.value !== undefined) assertJson(obj.value, 'change.value')
}

function validateExpectedGain(gain: unknown): asserts gain is PolicyEditExpectedGain {
  if (!gain || typeof gain !== 'object')
    throw new PolicyEditValidationError('expected object', 'expectedGain')
  const obj = gain as PolicyEditExpectedGain
  expectString(obj.metric, 'expectedGain.metric')
  expectOneOf(obj.direction, ['increase', 'decrease'] as const, 'expectedGain.direction')
  if (!Number.isFinite(obj.amount) || obj.amount <= 0) {
    throw new PolicyEditValidationError(
      'amount must be a positive finite number',
      'expectedGain.amount',
    )
  }
  if (obj.unit !== undefined) {
    expectOneOf(
      obj.unit,
      ['absolute', 'relative', 'percent', 'score'] as const,
      'expectedGain.unit',
    )
  }
  if (obj.rationale !== undefined) expectString(obj.rationale, 'expectedGain.rationale')
}

function validateSource(source: unknown): asserts source is PolicyEditSource {
  if (!source || typeof source !== 'object')
    throw new PolicyEditValidationError('expected object', 'source')
  const obj = source as PolicyEditSource
  expectNonEmptyStringArray(obj.findingIds, 'source.findingIds')
  expectNonEmptyStringArray(obj.analystIds, 'source.analystIds')
  if (!Array.isArray(obj.evidenceRefs)) {
    throw new PolicyEditValidationError('expected array', 'source.evidenceRefs')
  }
  for (const [i, ref] of obj.evidenceRefs.entries())
    validateEvidenceRef(ref, `source.evidenceRefs.${i}`)
  if (obj.derivedFromJudge !== undefined && typeof obj.derivedFromJudge !== 'boolean') {
    throw new PolicyEditValidationError('expected boolean', 'source.derivedFromJudge')
  }
}

function validateEvidenceRef(ref: unknown, path: string): asserts ref is EvidenceRef {
  if (!ref || typeof ref !== 'object') throw new PolicyEditValidationError('expected object', path)
  const obj = ref as EvidenceRef
  expectOneOf(obj.kind, ['span', 'event', 'artifact', 'finding', 'metric'] as const, `${path}.kind`)
  expectString(obj.uri, `${path}.uri`)
  if (obj.excerpt !== undefined) expectString(obj.excerpt, `${path}.excerpt`)
}

function assertJson(value: unknown, path: string): asserts value is AgentProfileJson {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  ) {
    return
  }
  if (Array.isArray(value)) {
    for (const [i, item] of value.entries()) assertJson(item, `${path}.${i}`)
    return
  }
  if (typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (!key) throw new PolicyEditValidationError('empty object key', path)
      assertJson(item, `${path}.${key}`)
    }
    return
  }
  throw new PolicyEditValidationError('expected JSON-compatible value', path)
}

function targetSpecificityScore(edit: PolicyEdit): number {
  let score = 0.4
  if (edit.target.path) score += 0.25
  if (edit.target.agentProfileCell) score += 0.15
  if (edit.change.kind === 'json' || edit.change.mode === 'replace') score += 0.2
  else if (edit.change.value.length > 0) score += 0.1
  return clamp01(score)
}

function splitPath(path: string): string[] {
  const parts = path
    .split('.')
    .map((p) => p.trim())
    .filter(Boolean)
  if (parts.length === 0)
    throw new PolicyEditValidationError('path must not be empty', 'change.path')
  return parts
}

function expectLiteral<T extends string>(
  value: unknown,
  expected: T,
  path: string,
): asserts value is T {
  if (value !== expected) throw new PolicyEditValidationError(`expected ${expected}`, path)
}

function expectString(value: unknown, path: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new PolicyEditValidationError('expected non-empty string', path)
  }
}

function expectNonEmpty(value: unknown, path: string): string {
  expectString(value, path)
  return value
}

function expectConfidence(value: unknown, path: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new PolicyEditValidationError('expected finite number in [0,1]', path)
  }
}

function hasExactTextBlock(surface: string, value: string): boolean {
  const needle = normalizeTextBlock(value)
  const normalizedSurface = surface.replace(/\r\n/g, '\n')
  return [...normalizedSurface.split(/\n{2,}/), ...normalizedSurface.split('\n')].some(
    (block) => normalizeTextBlock(block) === needle,
  )
}

function normalizeTextBlock(value: string): string {
  return value.replace(/\r\n/g, '\n').trim()
}

function expectOneOf<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  path: string,
): asserts value is T[number] {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw new PolicyEditValidationError(`expected one of ${allowed.join(', ')}`, path)
  }
}

function expectStringArray(value: unknown, path: string): asserts value is string[] {
  if (!Array.isArray(value)) throw new PolicyEditValidationError('expected array', path)
  for (const [i, item] of value.entries()) expectString(item, `${path}.${i}`)
}

function expectNonEmptyStringArray(value: unknown, path: string): asserts value is string[] {
  expectStringArray(value, path)
  if (value.length === 0) throw new PolicyEditValidationError('expected non-empty array', path)
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort()
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0
  if (n < 0) return 0
  if (n > 1) return 1
  return n
}
