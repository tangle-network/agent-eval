import { createHash } from 'node:crypto'
import { canonicalJson } from '../verdict-cache'
import type {
  ExternalOptimizerEvaluationObservation,
  ExternalOptimizerModelExecutionObservation,
} from './external-optimizer-contracts'
import type { CampaignStorage } from './storage'

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
