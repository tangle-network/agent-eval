import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { deepFreezeCanonicalJson } from '../ledger-core/deep-freeze'
import { canonicalJson } from '../verdict-cache'
import {
  assertJsonValue,
  type ExternalOptimizerEvaluationObservation,
  type ExternalOptimizerModelExecutionObservation,
  type ExternalTextCandidate,
  isExternalTextCandidate,
} from './external-optimizer-contracts'
import { type CampaignStorage, fsCampaignStorage } from './storage'

export interface ExternalOptimizerObservationSummary {
  scope: 'callback-submitted-candidates'
  path: string
  sha256: `sha256:${string}`
  submittedCandidates: number
  evaluations: number
  refusals: number
}

export interface ExternalOptimizerExecutionSummary {
  scope: 'runtime-model-calls'
  path: string
  sha256: `sha256:${string}`
  calls: number
  succeeded: number
  failed: number
}

export interface ExternalOptimizerSubmittedCandidate {
  /** Exact text or named-component surface submitted to the evaluation callback. */
  readonly candidate: ExternalTextCandidate
  /** Eval's canonical content identity for `candidate`. */
  readonly candidateHash: string
  readonly candidateDigest: `sha256:${string}`
  readonly proposalSequence: number
  /** Exact observation artifact that proves this candidate was submitted. */
  readonly provenance: {
    readonly path: string
    readonly sha256: `sha256:${string}`
  }
}

export interface ExternalOptimizerObservationArtifact {
  readonly summary: ExternalOptimizerObservationSummary
  readonly observations: readonly ExternalOptimizerEvaluationObservation[]
  /** Every distinct callback-submitted candidate in proposal order. */
  readonly candidates: readonly ExternalOptimizerSubmittedCandidate[]
}

/**
 * Read and verify the exact callback observation artifact addressed by method provenance.
 *
 * The reader checks the raw SHA-256, canonical JSONL bytes, sequence, candidate
 * identities, and summary counts before it returns any candidate.
 * This proves that the bytes match the supplied summary. The caller remains
 * responsible for obtaining that summary from trusted provenance.
 */
export function readExternalOptimizerObservationArtifact(input: {
  summary: ExternalOptimizerObservationSummary
  storage?: CampaignStorage
}): ExternalOptimizerObservationArtifact {
  const { summary } = input
  assertObservationSummary(summary)
  const storage = input.storage ?? fsCampaignStorage()
  const contents = storage.read(summary.path)
  if (contents === undefined) {
    const state = storage.exists(summary.path) ? 'unreadable' : 'missing'
    throw new Error(`external optimizer observation artifact is ${state} at '${summary.path}'`)
  }
  const sha256 = `sha256:${createHash('sha256').update(contents).digest('hex')}` as const
  if (sha256 !== summary.sha256) {
    throw new Error(
      `external optimizer observation artifact digest mismatch at '${summary.path}': expected ${summary.sha256}, got ${sha256}`,
    )
  }
  if (contents.length > 0 && !contents.endsWith('\n')) {
    throw new Error(
      `external optimizer observation artifact must end with a newline at '${summary.path}'`,
    )
  }

  const observations = contents.length === 0 ? [] : parseObservationLines(contents, summary.path)
  const candidates: ExternalOptimizerSubmittedCandidate[] = []
  const proposed = new Map<string, ExternalOptimizerSubmittedCandidate>()
  const evaluationNumbers = new Set<number>()
  let evaluations = 0
  let failedEvaluations = 0
  let refusals = 0

  for (const [index, observation] of observations.entries()) {
    if (observation.sequence !== index + 1) {
      throw new Error(
        `external optimizer observation artifact expected sequence ${index + 1}, got ${observation.sequence}`,
      )
    }
    if (observation.kind === 'proposal') {
      assertCandidateIdentity(
        observation.candidate,
        observation.candidateHash,
        observation.sequence,
      )
      if (proposed.has(observation.candidateHash)) {
        throw new Error(
          `external optimizer observation artifact repeats candidate ${observation.candidateHash}`,
        )
      }
      const candidate: ExternalOptimizerSubmittedCandidate = {
        candidate: structuredClone(observation.candidate),
        candidateHash: observation.candidateHash,
        candidateDigest: `sha256:${observation.candidateHash}`,
        proposalSequence: observation.sequence,
        provenance: { path: summary.path, sha256: summary.sha256 },
      }
      proposed.set(observation.candidateHash, candidate)
      candidates.push(candidate)
      continue
    }

    if (observation.kind === 'evaluation') {
      evaluations += 1
      if (evaluationNumbers.has(observation.evaluationNumber)) {
        throw new Error(
          `external optimizer observation artifact repeats evaluation number ${observation.evaluationNumber}`,
        )
      }
      evaluationNumbers.add(observation.evaluationNumber)
      assertObservedCandidate(observation, proposed)
      assertJsonValue(observation.response, 'external optimizer evaluation response')
      continue
    }

    refusals += 1
    if (
      observation.reason !== 'invalid-request' &&
      observation.reason !== 'evaluation-limit' &&
      observation.reason !== 'evaluation-failed'
    ) {
      throw new Error(
        `external optimizer observation artifact has invalid refusal reason at sequence ${observation.sequence}`,
      )
    }
    if (observation.reason === 'evaluation-failed') failedEvaluations += 1
    const candidateFields = [observation.candidate, observation.candidateHash]
    if (
      observation.reason !== 'invalid-request' &&
      candidateFields.some((value) => value === undefined)
    ) {
      throw new Error(
        `external optimizer observation artifact omits a refused candidate at sequence ${observation.sequence}`,
      )
    }
    if (candidateFields.some((value) => value !== undefined)) {
      if (candidateFields.some((value) => value === undefined)) {
        throw new Error(
          `external optimizer observation artifact has incomplete candidate identity at sequence ${observation.sequence}`,
        )
      }
      assertObservedCandidate(
        observation as ExternalOptimizerEvaluationObservation & {
          candidate: NonNullable<typeof observation.candidate>
          candidateHash: string
        },
        proposed,
      )
    }
  }

  const acceptedEvaluations = evaluations + failedEvaluations
  for (const evaluationNumber of evaluationNumbers) {
    if (evaluationNumber > acceptedEvaluations) {
      throw new Error(
        `external optimizer observation artifact has out-of-range evaluation number ${evaluationNumber}`,
      )
    }
  }

  if (
    candidates.length !== summary.submittedCandidates ||
    evaluations !== summary.evaluations ||
    refusals !== summary.refusals
  ) {
    throw new Error(
      `external optimizer observation artifact counts disagree at '${summary.path}': ` +
        `expected ${summary.submittedCandidates}/${summary.evaluations}/${summary.refusals}, ` +
        `got ${candidates.length}/${evaluations}/${refusals}`,
    )
  }

  return deepFreezeCanonicalJson({
    summary: structuredClone(summary),
    observations,
    candidates,
  })
}

/** Append-only observation log for one external-optimizer attempt. */
export function openExternalOptimizerObservationLog(input: {
  storage: CampaignStorage
  path: string
}): {
  observe: (observation: ExternalOptimizerEvaluationObservation) => void
  summary: () => ExternalOptimizerObservationSummary
} {
  const existing = input.storage.read(input.path)
  if (existing !== undefined || input.storage.exists(input.path)) {
    throw new Error(`external optimizer observation log already exists at '${input.path}'`)
  }
  input.storage.write(input.path, '')
  let revision = 0
  const counts = { submittedCandidates: 0, evaluations: 0, refusals: 0 }

  return {
    observe(observation) {
      const expectedSequence = counts.submittedCandidates + counts.evaluations + counts.refusals + 1
      if (observation.sequence !== expectedSequence) {
        throw new Error(
          `external optimizer observation log expected sequence ${expectedSequence}, got ${observation.sequence}`,
        )
      }
      const line = `${canonicalJson(observation)}\n`
      const next = input.storage.append(input.path, line, revision)
      if (next === undefined) {
        throw new Error(
          `external optimizer observation log changed concurrently at '${input.path}'`,
        )
      }
      revision = next
      if (observation.kind === 'proposal') counts.submittedCandidates += 1
      else if (observation.kind === 'evaluation') counts.evaluations += 1
      else counts.refusals += 1
    },
    summary() {
      const contents = input.storage.read(input.path) ?? ''
      const bytes = new TextEncoder().encode(contents)
      if (bytes.byteLength !== revision) {
        throw new Error(`external optimizer observation log revision changed at '${input.path}'`)
      }
      return {
        scope: 'callback-submitted-candidates',
        path: input.path,
        sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
        ...counts,
      }
    },
  }
}

function assertObservationSummary(summary: ExternalOptimizerObservationSummary): void {
  if (summary.scope !== 'callback-submitted-candidates') {
    throw new Error('external optimizer observation summary has an invalid scope')
  }
  if (typeof summary.path !== 'string' || summary.path.trim().length === 0) {
    throw new Error('external optimizer observation summary has an invalid path')
  }
  if (!/^sha256:[a-f0-9]{64}$/u.test(summary.sha256)) {
    throw new Error('external optimizer observation summary has an invalid SHA-256')
  }
  for (const [field, value] of [
    ['submittedCandidates', summary.submittedCandidates],
    ['evaluations', summary.evaluations],
    ['refusals', summary.refusals],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(
        `external optimizer observation summary ${field} must be a non-negative integer`,
      )
    }
  }
}

function parseObservationLines(
  contents: string,
  path: string,
): ExternalOptimizerEvaluationObservation[] {
  return contents
    .slice(0, -1)
    .split('\n')
    .map((line, index) => {
      let observation: unknown
      try {
        observation = JSON.parse(line)
      } catch (cause) {
        throw new Error(
          `external optimizer observation artifact has invalid JSON at '${path}' line ${index + 1}`,
          { cause },
        )
      }
      assertObservationShape(observation, index + 1)
      if (canonicalJson(observation) !== line) {
        throw new Error(
          `external optimizer observation artifact is not canonical at '${path}' line ${index + 1}`,
        )
      }
      return observation
    })
}

function assertObservationShape(
  value: unknown,
  line: number,
): asserts value is ExternalOptimizerEvaluationObservation {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`external optimizer observation artifact line ${line} must be an object`)
  }
  const observation = value as Record<string, unknown>
  if (!Number.isSafeInteger(observation.sequence) || Number(observation.sequence) <= 0) {
    throw new Error(`external optimizer observation artifact line ${line} has an invalid sequence`)
  }
  if (observation.kind === 'proposal') {
    assertExactKeys(observation, ['candidate', 'candidateHash', 'kind', 'sequence'], line)
    assertCandidateFields(observation, line)
    return
  }
  if (observation.kind === 'evaluation') {
    assertExactKeys(
      observation,
      [
        'candidate',
        'candidateHash',
        'evaluationNumber',
        'exampleId',
        'kind',
        'response',
        'sequence',
      ],
      line,
    )
    assertCandidateFields(observation, line)
    if (typeof observation.exampleId !== 'string') {
      throw new Error(
        `external optimizer observation artifact line ${line} has an invalid exampleId`,
      )
    }
    if (
      !Number.isSafeInteger(observation.evaluationNumber) ||
      Number(observation.evaluationNumber) <= 0
    ) {
      throw new Error(
        `external optimizer observation artifact line ${line} has an invalid evaluationNumber`,
      )
    }
    assertJsonValue(observation.response, `external optimizer observation artifact line ${line}`)
    return
  }
  if (observation.kind === 'refusal') {
    const allowed = ['candidate', 'candidateHash', 'exampleId', 'kind', 'reason', 'sequence']
    assertAllowedKeys(observation, allowed, line)
    if (typeof observation.reason !== 'string') {
      throw new Error(`external optimizer observation artifact line ${line} has an invalid reason`)
    }
    if (observation.candidate !== undefined || observation.candidateHash !== undefined) {
      assertCandidateFields(observation, line)
    }
    if (observation.exampleId !== undefined && typeof observation.exampleId !== 'string') {
      throw new Error(
        `external optimizer observation artifact line ${line} has an invalid exampleId`,
      )
    }
    return
  }
  throw new Error(`external optimizer observation artifact line ${line} has an invalid kind`)
}

function assertCandidateFields(observation: Record<string, unknown>, line: number): void {
  if (!isExternalTextCandidate(observation.candidate)) {
    throw new Error(`external optimizer observation artifact line ${line} has an invalid candidate`)
  }
  if (
    typeof observation.candidateHash !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(observation.candidateHash)
  ) {
    throw new Error(
      `external optimizer observation artifact line ${line} has an invalid candidateHash`,
    )
  }
}

function assertExactKeys(value: Record<string, unknown>, expected: string[], line: number): void {
  assertAllowedKeys(value, expected, line)
  for (const key of expected) {
    if (!(key in value)) {
      throw new Error(`external optimizer observation artifact line ${line} is missing ${key}`)
    }
  }
}

function assertAllowedKeys(value: Record<string, unknown>, allowed: string[], line: number): void {
  const extras = Object.keys(value).filter((key) => !allowed.includes(key))
  if (extras.length > 0) {
    throw new Error(
      `external optimizer observation artifact line ${line} has unexpected field ${extras[0]}`,
    )
  }
}

function assertCandidateIdentity(
  candidate: unknown,
  candidateHash: string,
  sequence: number,
): void {
  const expected = createHash('sha256')
    .update(canonicalJson({ kind: 'external-text-candidate', candidate }))
    .digest('hex')
  if (candidateHash !== expected) {
    throw new Error(
      `external optimizer observation artifact candidate hash mismatch at sequence ${sequence}`,
    )
  }
}

function assertObservedCandidate(
  observation:
    | Extract<ExternalOptimizerEvaluationObservation, { kind: 'evaluation' }>
    | {
        candidate: NonNullable<
          Extract<ExternalOptimizerEvaluationObservation, { kind: 'refusal' }>['candidate']
        >
        candidateHash: string
        sequence: number
      },
  proposed: Map<string, ExternalOptimizerSubmittedCandidate>,
): void {
  assertCandidateIdentity(observation.candidate, observation.candidateHash, observation.sequence)
  const candidate = proposed.get(observation.candidateHash)
  if (!candidate) {
    throw new Error(
      `external optimizer observation artifact references an unproposed candidate at sequence ${observation.sequence}`,
    )
  }
  if (!isDeepStrictEqual(observation.candidate, candidate.candidate)) {
    throw new Error(
      `external optimizer observation artifact changes candidate bytes at sequence ${observation.sequence}`,
    )
  }
}

/** Append-only opaque Runtime execution records for one optimizer attempt. */
export function openExternalOptimizerExecutionLog(input: {
  storage: CampaignStorage
  path: string
}): {
  observe: (observation: ExternalOptimizerModelExecutionObservation) => void
  summary: () => ExternalOptimizerExecutionSummary
} {
  const existing = input.storage.read(input.path)
  if (existing !== undefined || input.storage.exists(input.path)) {
    throw new Error(`external optimizer execution log already exists at '${input.path}'`)
  }
  input.storage.write(input.path, '')
  let revision = 0
  const counts = { calls: 0, succeeded: 0, failed: 0 }

  return {
    observe(observation) {
      if (observation.sequence !== counts.calls + 1) {
        throw new Error(
          `external optimizer execution log expected sequence ${counts.calls + 1}, got ${observation.sequence}`,
        )
      }
      const line = `${canonicalJson(observation)}\n`
      const next = input.storage.append(input.path, line, revision)
      if (next === undefined) {
        throw new Error(`external optimizer execution log changed concurrently at '${input.path}'`)
      }
      revision = next
      counts.calls += 1
      if (observation.succeeded) counts.succeeded += 1
      else counts.failed += 1
    },
    summary() {
      const contents = input.storage.read(input.path) ?? ''
      const bytes = new TextEncoder().encode(contents)
      if (bytes.byteLength !== revision) {
        throw new Error(`external optimizer execution log revision changed at '${input.path}'`)
      }
      if (counts.calls !== counts.succeeded + counts.failed) {
        throw new Error(`external optimizer execution log counts disagree at '${input.path}'`)
      }
      return {
        scope: 'runtime-model-calls',
        path: input.path,
        sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
        ...counts,
      }
    },
  }
}
