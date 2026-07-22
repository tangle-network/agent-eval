import type { AgentProfile } from '@tangle-network/agent-interface'
import { ValidationError } from './errors'
import { hashJson } from './pre-registration'

export type AgentProfileCellSchemaVersion = 'agent-profile-cell/v1'

export type AgentProfileJsonObject = { [key: string]: AgentProfileJson }

export type AgentProfileJson =
  | string
  | number
  | boolean
  | null
  | AgentProfileJson[]
  | AgentProfileJsonObject

export type AgentProfileDimensionValue = string | number | boolean | null

export interface AgentProfileSource {
  /** Runtime/profile contract being fingerprinted, e.g. `agent-interface-profile`. */
  kind: string
  /** sha256 over the canonical source profile object. */
  hash: string
}

export interface AgentProfileSourceInput {
  kind: string
  /** Precomputed sha256 for callers that already sign their profile artifact. */
  hash?: string
  /** Full canonical runtime profile; hashed and then discarded from the cell. */
  profile?: AgentProfileJson
}

export interface AgentProfileHarness {
  id: string
  version?: string
  hash?: string
}

export interface AgentProfileCellInput {
  profileId: string
  sourceProfile: AgentProfileSourceInput
  harness?: AgentProfileHarness
  model?: string
  promptHash?: string
  dimensions?: Record<string, AgentProfileDimensionValue>
}

export interface AgentProfileCell {
  schemaVersion: AgentProfileCellSchemaVersion
  cellId: string
  profileId: string
  sourceProfile: AgentProfileSource
  harness?: AgentProfileHarness
  model?: string
  promptHash?: string
  dimensions?: Record<string, AgentProfileDimensionValue>
}

export class AgentProfileCellValidationError extends ValidationError {
  readonly path: string
  constructor(message: string, path = '') {
    super(path ? `${message} (at ${path})` : message)
    this.path = path
  }
}

const SHA256_HEX = /^[0-9a-f]{64}$/
const CELL_ID = /^agent-profile-cell:sha256:[0-9a-f]{64}$/

export async function buildAgentProfileCell(
  input: AgentProfileCellInput,
): Promise<AgentProfileCell> {
  const material = await normalizeAgentProfileCellInput(input)
  const cellId = `agent-profile-cell:sha256:${await hashJson(material)}`
  return { ...material, cellId }
}

export function agentProfileCellHashMaterial(
  cell: AgentProfileCell,
): Omit<AgentProfileCell, 'cellId'> {
  const { cellId: _cellId, ...material } = cell
  void _cellId
  return normalizeAgentProfileCell(material)
}

/**
 * Verify an `AgentProfileCell`'s `cellId` matches the sha256 of its hash-material fields, confirming the record has not been tampered with.
 */
export async function verifyAgentProfileCell(cell: AgentProfileCell): Promise<boolean> {
  validateAgentProfileCell(cell)
  return (
    cell.cellId ===
    `agent-profile-cell:sha256:${await hashJson(agentProfileCellHashMaterial(cell))}`
  )
}

export function validateAgentProfileCell(input: unknown): AgentProfileCell {
  if (input === null || typeof input !== 'object') {
    throw new AgentProfileCellValidationError('expected object')
  }
  const obj = input as Record<string, unknown>
  expectLiteral(obj.schemaVersion, 'agent-profile-cell/v1', 'schemaVersion')
  if (typeof obj.cellId !== 'string' || !CELL_ID.test(obj.cellId)) {
    throw new AgentProfileCellValidationError(
      'cellId must match agent-profile-cell:sha256:<64 lowercase hex chars>',
      'cellId',
    )
  }
  expectString(obj.profileId, 'profileId')
  validateSource(obj.sourceProfile, 'sourceProfile')
  if (obj.harness !== undefined) validateHarness(obj.harness, 'harness')
  if (obj.model !== undefined) expectString(obj.model, 'model')
  if (obj.promptHash !== undefined) expectString(obj.promptHash, 'promptHash')
  if (obj.dimensions !== undefined) validateDimensions(obj.dimensions, 'dimensions')
  return input as AgentProfileCell
}

export function requireAgentProfileCell(record: {
  runId: string
  agentProfile?: AgentProfileCell
}): AgentProfileCell {
  if (!record.agentProfile) {
    throw new AgentProfileCellValidationError(
      `run "${record.runId}" is missing agentProfile; profile-cell grouping requires explicit profile identity`,
      'agentProfile',
    )
  }
  return validateAgentProfileCell(record.agentProfile)
}

export function agentProfileCellKey(record: {
  runId: string
  agentProfile?: AgentProfileCell
}): string {
  return requireAgentProfileCell(record).cellId
}

export async function assertRunAgentProfileCell(record: {
  runId: string
  model: string
  promptHash: string
  agentProfile?: AgentProfileCell
}): Promise<AgentProfileCell> {
  const profile = requireAgentProfileCell(record)
  if (!(await verifyAgentProfileCell(profile))) {
    throw new AgentProfileCellValidationError(
      `run "${record.runId}" has an agentProfile.cellId that does not match its content`,
      'agentProfile.cellId',
    )
  }
  if (profile.model !== undefined && profile.model !== record.model) {
    throw new AgentProfileCellValidationError(
      `run "${record.runId}" agentProfile.model "${profile.model}" does not match model "${record.model}"`,
      'agentProfile.model',
    )
  }
  if (profile.promptHash !== undefined && profile.promptHash !== record.promptHash) {
    throw new AgentProfileCellValidationError(
      `run "${record.runId}" agentProfile.promptHash "${profile.promptHash}" does not match promptHash "${record.promptHash}"`,
      'agentProfile.promptHash',
    )
  }
  return profile
}

export function groupRunsByAgentProfileCell<
  T extends { runId: string; agentProfile?: AgentProfileCell },
>(records: readonly T[]): Map<string, T[]> {
  const groups = new Map<string, T[]>()
  for (const record of records) {
    const key = agentProfileCellKey(record)
    const bucket = groups.get(key)
    if (bucket) bucket.push(record)
    else groups.set(key, [record])
  }
  return groups
}

async function normalizeAgentProfileCellInput(
  input: AgentProfileCellInput,
): Promise<Omit<AgentProfileCell, 'cellId'>> {
  return normalizeAgentProfileCell({
    schemaVersion: 'agent-profile-cell/v1',
    profileId: input.profileId,
    sourceProfile: await normalizeSourceInput(input.sourceProfile),
    harness: input.harness,
    model: input.model,
    promptHash: input.promptHash,
    dimensions: input.dimensions,
  })
}

function normalizeAgentProfileCell(
  input: Omit<AgentProfileCell, 'cellId'>,
): Omit<AgentProfileCell, 'cellId'> {
  return compactObject({
    schemaVersion: 'agent-profile-cell/v1' as const,
    profileId: requireNonEmpty(input.profileId, 'profileId'),
    sourceProfile: normalizeSource(input.sourceProfile),
    harness: input.harness ? normalizeHarness(input.harness, 'harness') : undefined,
    model: optionalNonEmpty(input.model, 'model'),
    promptHash: optionalNonEmpty(input.promptHash, 'promptHash'),
    dimensions: input.dimensions
      ? nonEmptyRecord(normalizeDimensions(input.dimensions))
      : undefined,
  })
}

async function normalizeSourceInput(input: AgentProfileSourceInput): Promise<AgentProfileSource> {
  const kind = requireNonEmpty(input.kind, 'sourceProfile.kind')
  if (input.hash !== undefined && input.profile !== undefined) {
    throw new AgentProfileCellValidationError(
      'sourceProfile must provide either hash or profile, not both',
      'sourceProfile',
    )
  }
  if (input.hash !== undefined) {
    return { kind, hash: requireSha256Hex(input.hash, 'sourceProfile.hash') }
  }
  if (input.profile === undefined) {
    throw new AgentProfileCellValidationError(
      'sourceProfile must provide hash or profile',
      'sourceProfile',
    )
  }
  assertJson(input.profile, 'sourceProfile.profile')
  return { kind, hash: await hashJson(input.profile) }
}

function normalizeSource(input: AgentProfileSource): AgentProfileSource {
  return {
    kind: requireNonEmpty(input.kind, 'sourceProfile.kind'),
    hash: requireSha256Hex(input.hash, 'sourceProfile.hash'),
  }
}

function normalizeHarness(input: AgentProfileHarness, path: string): AgentProfileHarness {
  return compactObject({
    id: requireNonEmpty(input.id, `${path}.id`),
    version: optionalNonEmpty(input.version, `${path}.version`),
    hash: optionalNonEmpty(input.hash, `${path}.hash`),
  })
}

function normalizeDimensions(
  input: Record<string, AgentProfileDimensionValue>,
): Record<string, AgentProfileDimensionValue> {
  const out: Record<string, AgentProfileDimensionValue> = {}
  for (const key of Object.keys(input).sort()) {
    const value = input[key]
    requireNonEmpty(key, 'dimensions.<key>')
    if (
      value !== null &&
      typeof value !== 'string' &&
      typeof value !== 'number' &&
      typeof value !== 'boolean'
    ) {
      throw new AgentProfileCellValidationError(
        'expected primitive dimension value',
        `dimensions.${key}`,
      )
    }
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new AgentProfileCellValidationError('expected finite number', `dimensions.${key}`)
    }
    out[key] = value
  }
  return out
}

function compactObject<T extends Record<string, unknown>>(input: T): T {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) out[key] = value
  }
  return out as T
}

function nonEmptyRecord<T extends Record<string, unknown>>(input: T): T | undefined {
  return Object.keys(input).length > 0 ? input : undefined
}

function validateSource(value: unknown, path: string): void {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new AgentProfileCellValidationError('expected object', path)
  }
  const rec = value as Record<string, unknown>
  expectString(rec.kind, `${path}.kind`)
  requireSha256Hex(rec.hash, `${path}.hash`)
}

function validateHarness(value: unknown, path: string): void {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new AgentProfileCellValidationError('expected object', path)
  }
  const rec = value as Record<string, unknown>
  expectString(rec.id, `${path}.id`)
  if (rec.version !== undefined) expectString(rec.version, `${path}.version`)
  if (rec.hash !== undefined) expectString(rec.hash, `${path}.hash`)
}

function validateDimensions(value: unknown, path: string): void {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new AgentProfileCellValidationError('expected object', path)
  }
  normalizeDimensions(value as Record<string, AgentProfileDimensionValue>)
}

function assertJson(value: AgentProfileJson, path: string): void {
  if (value === null) return
  const type = typeof value
  if (type === 'string' || type === 'boolean') return
  if (type === 'number') {
    if (!Number.isFinite(value)) {
      throw new AgentProfileCellValidationError('expected finite number', path)
    }
    return
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      assertJson(item, `${path}[${index}]`)
    })
    return
  }
  if (type === 'object') {
    for (const [key, nested] of Object.entries(value)) {
      requireNonEmpty(key, `${path}.<key>`)
      assertJson(nested, `${path}.${key}`)
    }
    return
  }
  throw new AgentProfileCellValidationError('expected JSON-compatible value', path)
}

function expectLiteral(value: unknown, expected: string, path: string): void {
  if (value !== expected) {
    throw new AgentProfileCellValidationError(`expected ${expected}`, path)
  }
}

function expectString(value: unknown, path: string): void {
  if (typeof value !== 'string' || value.length === 0) {
    throw new AgentProfileCellValidationError('expected non-empty string', path)
  }
}

function requireNonEmpty(value: string, path: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new AgentProfileCellValidationError('expected non-empty string', path)
  }
  return value
}

function optionalNonEmpty(value: string | undefined, path: string): string | undefined {
  if (value === undefined) return undefined
  return requireNonEmpty(value, path)
}

function requireSha256Hex(value: unknown, path: string): string {
  if (typeof value !== 'string' || !SHA256_HEX.test(value)) {
    throw new AgentProfileCellValidationError('expected 64 lowercase sha256 hex chars', path)
  }
  return value
}

// ── Consumer helpers ─────────────────────────────────────────────────
//
// Boilerplate every product consuming `buildAgentProfileCell` used to duplicate:
//
//   1. A `JSON.parse(JSON.stringify(value))` helper that canonicalizes an
//      arbitrary `@tangle-network/agent-interface` `AgentProfile` into the recursive
//      `AgentProfileJson` shape, with a fail-loud error when the profile
//      is not JSON-serializable.
//
//   2. The magic string `'agent-interface-profile'` for `sourceProfile.kind`.
//
// Both belong here so the cross-product cell join (same canonical profile
// hashes to the same `sourceProfile.hash` across products) is enforced by
// the type system, not by every consumer remembering to do it right.
// See blueprint-agent issue tangle-network/agent-eval#82.

/** Canonical `sourceProfile.kind` values. Two products fingerprinting the
 *  same canonical profile MUST use the same kind for their cells to share
 *  `sourceProfile.hash`. Extend rather than create new strings — adding a
 *  new kind is a deliberate cross-product schema change. */
export const AGENT_PROFILE_KINDS = {
  /** A profile declared via `defineAgentProfile(...)` from
   *  `@tangle-network/agent-interface`. The default kind for router-backed
   *  and sandbox-backed products. */
  AGENT_INTERFACE_PROFILE: 'agent-interface-profile',
} as const

export type AgentProfileKind = (typeof AGENT_PROFILE_KINDS)[keyof typeof AGENT_PROFILE_KINDS]

/** Canonicalize an arbitrary value into `AgentProfileJson` by JSON
 *  round-trip. Throws when the value contains anything not representable
 *  as JSON (functions, BigInt, cycles) — non-portable profiles fail loud
 *  rather than silently dropping fields. */
export function toAgentProfileJson(value: unknown): AgentProfileJson {
  let serialized: string | undefined
  try {
    serialized = JSON.stringify(value)
  } catch (err) {
    throw new AgentProfileCellValidationError(
      `agent profile must be JSON-serializable: ${err instanceof Error ? err.message : String(err)}`,
      'sourceProfile.profile',
    )
  }
  if (serialized === undefined) {
    throw new AgentProfileCellValidationError(
      'agent profile must be JSON-serializable (got undefined after JSON.stringify)',
      'sourceProfile.profile',
    )
  }
  return JSON.parse(serialized) as AgentProfileJson
}

/** Canonical AgentProfile shape required when deriving a stable cell id. */
export type AgentInterfaceProfileLike = AgentProfile & { name: string; version: string }

/** Higher-level helper that hard-codes the canonical
 *  `agent-interface-profile` kind plus the JSON canonicalization. Equivalent
 *  to calling `buildAgentProfileCell` with `profileId = \`${name}@${version}\``
 *  and `sourceProfile = { kind: AGENT_INTERFACE_PROFILE, profile: <round-tripped> }`.
 *
 *  Use this from any product consuming an agent-interface `AgentProfile`; the
 *  manual `buildAgentProfileCell` call is reserved for advanced cases
 *  (custom kinds, pre-computed source hashes, alternate profileId
 *  conventions). */
export async function buildAgentInterfaceProfileCell(
  profile: AgentInterfaceProfileLike,
  input: Omit<AgentProfileCellInput, 'profileId' | 'sourceProfile'>,
): Promise<AgentProfileCell> {
  if (!profile || typeof profile !== 'object') {
    throw new AgentProfileCellValidationError('AgentProfile must be an object', 'profile')
  }
  if (typeof profile.name !== 'string' || profile.name.length === 0) {
    throw new AgentProfileCellValidationError(
      'AgentProfile must have a non-empty `name`',
      'profile.name',
    )
  }
  if (typeof profile.version !== 'string' || profile.version.length === 0) {
    throw new AgentProfileCellValidationError(
      'AgentProfile must have a non-empty `version`',
      'profile.version',
    )
  }
  return buildAgentProfileCell({
    ...input,
    profileId: `${profile.name}@${profile.version}`,
    sourceProfile: {
      kind: AGENT_PROFILE_KINDS.AGENT_INTERFACE_PROFILE,
      profile: toAgentProfileJson(profile),
    },
  })
}
