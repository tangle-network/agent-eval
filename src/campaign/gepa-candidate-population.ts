import { createHash } from 'node:crypto'
import { deepFreezeCanonicalJson } from '../ledger-core/deep-freeze'
import { contentHash } from '../verdict-cache'
import {
  type ExternalTextCandidate,
  isExternalTextCandidate,
  isRecord,
} from './external-optimizer-contracts'
import { type CampaignStorage, fsCampaignStorage } from './storage'

export interface GepaCandidatePopulationSummary {
  readonly scope: 'gepa-candidate-population'
  readonly path: string
  readonly sha256: `sha256:${string}`
  readonly bytes: number
  readonly runId: string
  readonly candidates: number
  readonly bestIndex: number
}

export interface GepaCandidateSelectionScore {
  readonly scenarioId: string
  readonly score: number
}

export interface GepaCandidatePopulationCandidate {
  /** Zero-based index assigned by the exact GEPA result. */
  readonly index: number
  readonly candidate: ExternalTextCandidate
  readonly candidateHash: string
  readonly candidateDigest: `sha256:${string}`
  /** Exact GEPA parent indices. The seed candidate has one null parent. */
  readonly parentIndices: readonly (number | null)[]
  /** Null means GEPA had no selection score for this candidate. */
  readonly aggregateScore: number | null
  readonly selectionScores: readonly GepaCandidateSelectionScore[]
  readonly discoveryEvaluationCount: number
}

export interface GepaCandidatePopulationArtifact {
  readonly summary: GepaCandidatePopulationSummary
  readonly runId: string
  readonly bestIndex: number
  readonly candidates: readonly GepaCandidatePopulationCandidate[]
}

/**
 * Read GEPA's exact candidate graph from the artifact addressed by method provenance.
 *
 * The reader checks the supplied digest, declared byte count, run identity,
 * candidate surfaces, parent graph, selection scores, and configured bounds.
 * This proves that the bytes match the supplied summary. The caller remains
 * responsible for obtaining that summary from trusted method provenance.
 */
export function readGepaCandidatePopulationArtifact(input: {
  summary: GepaCandidatePopulationSummary
  maxCandidates: number
  maxCandidateChars: number
  scenarioIds: readonly string[]
  expectsComponents: boolean
  storage?: CampaignStorage
}): GepaCandidatePopulationArtifact {
  assertGepaCandidatePopulationSummary(input.summary)
  assertPositiveSafeInteger(input.maxCandidates, 'maxCandidates')
  assertPositiveSafeInteger(input.maxCandidateChars, 'maxCandidateChars')
  const scenarioIds = scenarioIdSet(input.scenarioIds)
  const storage = input.storage ?? fsCampaignStorage()
  const contents = storage.read(input.summary.path)
  if (contents === undefined) {
    const state = storage.exists(input.summary.path) ? 'unreadable' : 'missing'
    throw new Error(`GEPA candidate population artifact is ${state} at '${input.summary.path}'`)
  }
  const bytes = new TextEncoder().encode(contents).byteLength
  if (bytes !== input.summary.bytes) {
    throw new Error(
      `GEPA candidate population byte count mismatch at '${input.summary.path}': expected ${input.summary.bytes}, got ${bytes}`,
    )
  }
  if (
    BigInt(bytes) > maximumArtifactBytes(input.maxCandidates, input.maxCandidateChars, scenarioIds)
  ) {
    throw new Error(
      `GEPA candidate population exceeds its configured bounds at '${input.summary.path}'`,
    )
  }
  const sha256 = `sha256:${createHash('sha256').update(contents).digest('hex')}` as const
  if (sha256 !== input.summary.sha256) {
    throw new Error(
      `GEPA candidate population digest mismatch at '${input.summary.path}': expected ${input.summary.sha256}, got ${sha256}`,
    )
  }

  let raw: unknown
  try {
    raw = JSON.parse(contents)
  } catch (cause) {
    throw new Error(`GEPA candidate population is not JSON at '${input.summary.path}'`, {
      cause,
    })
  }
  assertExactKeys(raw, ['bestIndex', 'candidates', 'runId', 'schemaVersion', 'scope'], 'artifact')
  if (raw.schemaVersion !== 1 || raw.scope !== 'gepa-candidate-population') {
    throw new Error('GEPA candidate population has an unsupported schema')
  }
  if (raw.runId !== input.summary.runId) {
    throw new Error('GEPA candidate population run ID differs from its summary')
  }
  if (!Array.isArray(raw.candidates) || raw.candidates.length === 0) {
    throw new Error('GEPA candidate population must contain candidates')
  }
  if (
    raw.candidates.length !== input.summary.candidates ||
    raw.candidates.length > input.maxCandidates
  ) {
    throw new Error('GEPA candidate population count differs from its summary or configured bound')
  }
  const bestIndex = raw.bestIndex
  if (
    typeof bestIndex !== 'number' ||
    !Number.isSafeInteger(bestIndex) ||
    bestIndex < 0 ||
    bestIndex >= raw.candidates.length ||
    bestIndex !== input.summary.bestIndex
  ) {
    throw new Error('GEPA candidate population has an invalid best index')
  }

  const candidates = raw.candidates.map((candidate, index) =>
    parseCandidate({
      candidate,
      index,
      maxCandidateChars: input.maxCandidateChars,
      scenarioIds,
      expectsComponents: input.expectsComponents,
    }),
  )
  return deepFreezeCanonicalJson({
    summary: structuredClone(input.summary),
    runId: raw.runId,
    bestIndex,
    candidates,
  })
}

export function assertGepaCandidatePopulationSummary(
  value: unknown,
): asserts value is GepaCandidatePopulationSummary {
  assertExactKeys(
    value,
    ['bestIndex', 'bytes', 'candidates', 'path', 'runId', 'scope', 'sha256'],
    'summary',
  )
  if (value.scope !== 'gepa-candidate-population') {
    throw new Error('GEPA candidate population summary has an invalid scope')
  }
  if (typeof value.path !== 'string' || value.path.trim().length === 0) {
    throw new Error('GEPA candidate population summary has an invalid path')
  }
  if (typeof value.sha256 !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(value.sha256)) {
    throw new Error('GEPA candidate population summary has an invalid SHA-256')
  }
  if (typeof value.runId !== 'string' || value.runId.trim().length === 0) {
    throw new Error('GEPA candidate population summary has an invalid run ID')
  }
  const bytes = value.bytes
  const candidates = value.candidates
  assertPositiveSafeInteger(bytes, 'summary.bytes')
  assertPositiveSafeInteger(candidates, 'summary.candidates')
  const bestIndex = value.bestIndex
  if (
    typeof bestIndex !== 'number' ||
    !Number.isSafeInteger(bestIndex) ||
    bestIndex < 0 ||
    bestIndex >= candidates
  ) {
    throw new Error('GEPA candidate population summary has an invalid best index')
  }
}

function parseCandidate(input: {
  candidate: unknown
  index: number
  maxCandidateChars: number
  scenarioIds: ReadonlySet<string>
  expectsComponents: boolean
}): GepaCandidatePopulationCandidate {
  const { candidate, index } = input
  assertExactKeys(
    candidate,
    [
      'aggregateScore',
      'candidate',
      'discoveryEvaluationCount',
      'index',
      'parentIndices',
      'selectionScores',
    ],
    `candidate ${index}`,
  )
  if (candidate.index !== index) {
    throw new Error(`GEPA candidate population expected index ${index}`)
  }
  if (
    !isExternalTextCandidate(candidate.candidate) ||
    input.expectsComponents !== (typeof candidate.candidate !== 'string') ||
    candidateChars(candidate.candidate) > input.maxCandidateChars
  ) {
    throw new Error(`GEPA candidate ${index} has an invalid surface`)
  }
  const parentIndices = parseParents(candidate.parentIndices, index)
  const selectionScores = parseSelectionScores(candidate.selectionScores, input.scenarioIds, index)
  const aggregateScore = parseAggregateScore(candidate.aggregateScore, selectionScores, index)
  const discoveryEvaluationCount = candidate.discoveryEvaluationCount
  if (
    typeof discoveryEvaluationCount !== 'number' ||
    !Number.isSafeInteger(discoveryEvaluationCount) ||
    discoveryEvaluationCount < 0
  ) {
    throw new Error(`GEPA candidate ${index} has an invalid discovery evaluation count`)
  }
  const candidateHash = contentHash({
    kind: 'external-text-candidate',
    candidate: candidate.candidate,
  })
  return {
    index,
    candidate: structuredClone(candidate.candidate),
    candidateHash,
    candidateDigest: `sha256:${candidateHash}`,
    parentIndices,
    aggregateScore,
    selectionScores,
    discoveryEvaluationCount,
  }
}

function parseParents(value: unknown, index: number): (number | null)[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`GEPA candidate ${index} has invalid parents`)
  }
  const seen = new Set<number | null>()
  for (const parent of value) {
    if (parent === null) {
      if (index !== 0) throw new Error(`GEPA candidate ${index} has a null parent`)
    } else if (!Number.isSafeInteger(parent) || parent < 0 || parent >= index) {
      throw new Error(`GEPA candidate ${index} has an invalid parent index`)
    }
    if (seen.has(parent)) throw new Error(`GEPA candidate ${index} repeats a parent index`)
    seen.add(parent)
  }
  if (index === 0 && (value.length !== 1 || value[0] !== null)) {
    throw new Error('GEPA root candidate must have one null parent')
  }
  return [...value]
}

function parseSelectionScores(
  value: unknown,
  scenarioIds: ReadonlySet<string>,
  candidateIndex: number,
): GepaCandidateSelectionScore[] {
  if (!Array.isArray(value)) {
    throw new Error(`GEPA candidate ${candidateIndex} has invalid selection scores`)
  }
  const seen = new Set<string>()
  let prior = ''
  return value.map((row, index) => {
    assertExactKeys(row, ['scenarioId', 'score'], `candidate ${candidateIndex} score ${index}`)
    if (
      typeof row.scenarioId !== 'string' ||
      !scenarioIds.has(row.scenarioId) ||
      seen.has(row.scenarioId) ||
      (index > 0 && row.scenarioId <= prior)
    ) {
      throw new Error(`GEPA candidate ${candidateIndex} has invalid selection score identity`)
    }
    if (typeof row.score !== 'number' || !Number.isFinite(row.score)) {
      throw new Error(`GEPA candidate ${candidateIndex} has an invalid selection score`)
    }
    seen.add(row.scenarioId)
    prior = row.scenarioId
    return { scenarioId: row.scenarioId, score: row.score }
  })
}

function parseAggregateScore(
  value: unknown,
  scores: readonly GepaCandidateSelectionScore[],
  candidateIndex: number,
): number | null {
  if (scores.length === 0) {
    if (value !== null) {
      throw new Error(`GEPA candidate ${candidateIndex} has a score without selection evidence`)
    }
    return null
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`GEPA candidate ${candidateIndex} has an invalid aggregate score`)
  }
  const mean = scores.reduce((total, row) => total + row.score, 0) / scores.length
  if (Math.abs(value - mean) > Math.max(1e-12, Math.abs(mean) * 1e-9)) {
    throw new Error(
      `GEPA candidate ${candidateIndex} aggregate score differs from its selection scores`,
    )
  }
  return value
}

function candidateChars(candidate: ExternalTextCandidate): number {
  return typeof candidate === 'string' ? candidate.length : JSON.stringify(candidate).length
}

function scenarioIdSet(values: readonly string[]): ReadonlySet<string> {
  if (!Array.isArray(values)) throw new Error('scenarioIds must be an array')
  const result = new Set<string>()
  for (const value of values) {
    if (typeof value !== 'string' || value.length === 0 || result.has(value)) {
      throw new Error('scenarioIds must contain unique non-empty strings')
    }
    result.add(value)
  }
  return result
}

function maximumArtifactBytes(
  maxCandidates: number,
  maxCandidateChars: number,
  scenarioIds: ReadonlySet<string>,
): bigint {
  const scenarioChars = [...scenarioIds].reduce((total, id) => total + id.length, 0)
  const candidates = BigInt(maxCandidates)
  const perCandidate =
    BigInt(maxCandidateChars) * 6n +
    BigInt(scenarioChars) * 6n +
    BigInt(scenarioIds.size) * 128n +
    candidates * 32n +
    8_192n
  return 8_192n + candidates * perCandidate
}

function assertExactKeys(
  value: unknown,
  expected: readonly string[],
  label: string,
): asserts value is Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`GEPA candidate population ${label} must be an object`)
  const actual = Object.keys(value).sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`GEPA candidate population ${label} has unexpected fields`)
  }
}

function assertPositiveSafeInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error(`GEPA candidate population ${label} must be a positive safe integer`)
  }
}
