import type { AgentProfileCell, AgentProfileJson } from '../agent-profile-cell'
import { validateAgentProfileCell } from '../agent-profile-cell'
import { ValidationError } from '../errors'
import { hashCanonical } from '../ledger-core/canonical'


import type { AnalystFinding, EvidenceRef } from './types'

export type PolicyEditSchemaVersion = 'policy-edit/v1'

const POLICY_EDIT_AXES = [
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

const POLICY_EDIT_TARGET_SURFACES = [
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

const POLICY_EDIT_CANDIDATE_RECORD_SCHEMA = 'tangle.policy-edit-candidate.v1' as const

/** JSON-safe attribution carried with a measured candidate and its scores. */
export interface PolicyEditCandidateRecord {
  schema: typeof POLICY_EDIT_CANDIDATE_RECORD_SCHEMA
  policyEdit: PolicyEdit
}

export type PolicyEditInit = Omit<PolicyEdit, 'schemaVersion' | 'editId'> & {
  schemaVersion?: PolicyEditSchemaVersion
  editId?: string
}

class PolicyEditValidationError extends ValidationError {
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



const POLICY_EDIT_ID = /^policy-edit:sha256:[0-9a-f]{64}$/



function computePolicyEditId(edit: Omit<PolicyEdit, 'editId'> | PolicyEdit): string {
  const { editId: _editId, schemaVersion, ...material } = edit as PolicyEdit
  void _editId
  return `policy-edit:${hashCanonical({ schemaVersion, ...material })}`
}

function validatePolicyEdit(input: unknown): PolicyEdit {
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

function validatePolicyEditCandidateRecord(input: unknown): PolicyEditCandidateRecord {
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
  splitPath(obj.path)
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



// Assigning through these keys on a plain object mutates the prototype chain
// instead of writing an own property: the edit silently no-ops after
// JSON.stringify, or crashes the canonical hasher. Edits are analyst- and
// LLM-authored input, so the refusal is loud, at parse time.
const FORBIDDEN_PATH_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

function splitPath(path: string): string[] {
  const parts = path
    .split('.')
    .map((p) => p.trim())
    .filter(Boolean)
  if (parts.length === 0)
    throw new PolicyEditValidationError('path must not be empty', 'change.path')
  for (const part of parts) {
    if (FORBIDDEN_PATH_KEYS.has(part)) {
      throw new PolicyEditValidationError(
        `path segment "${part}" would write through the prototype chain`,
        'change.path',
      )
    }
  }
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



function expectConfidence(value: unknown, path: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new PolicyEditValidationError('expected finite number in [0,1]', path)
  }
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




