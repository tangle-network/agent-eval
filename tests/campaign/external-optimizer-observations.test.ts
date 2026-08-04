import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  openExternalOptimizerExecutionLog,
  openExternalOptimizerObservationLog,
} from '../../src/campaign/external-optimizer-observations'
import { inMemoryCampaignStorage } from '../../src/campaign/storage'

describe('external optimizer observation artifacts', () => {
  it('retains callback-submitted candidates, per-case scores, and refusals with a digest', () => {
    const storage = inMemoryCampaignStorage()
    const path = 'run/callback-observations.jsonl'
    const log = openExternalOptimizerObservationLog({ storage, path })

    log.observe({
      kind: 'proposal',
      sequence: 1,
      candidate: 'candidate',
      candidateHash: 'hash',
    })
    log.observe({
      kind: 'evaluation',
      sequence: 2,
      candidate: 'candidate',
      candidateHash: 'hash',
      exampleId: 'case-a',
      evaluationNumber: 1,
      response: { score: 0.75 },
    })
    log.observe({
      kind: 'refusal',
      sequence: 3,
      reason: 'evaluation-limit',
      candidate: 'candidate',
      candidateHash: 'hash',
      exampleId: 'case-b',
    })

    const contents = storage.read(path)!
    expect(log.summary()).toEqual({
      scope: 'callback-submitted-candidates',
      path,
      sha256: `sha256:${createHash('sha256').update(contents).digest('hex')}`,
      submittedCandidates: 1,
      evaluations: 1,
      refusals: 1,
    })
  })

  it('retains one immutable opaque Runtime record for every success and failure', () => {
    const storage = inMemoryCampaignStorage()
    const path = 'run/model-executions.jsonl'
    const log = openExternalOptimizerExecutionLog({ storage, path })
    const evidence = { profileDigest: 'sha256:profile', nested: { attempt: 1 } }

    log.observe({
      sequence: 1,
      callId: 'optimizer-call-1',
      callRef: 'runtime:profile',
      path: '/v1/chat/completions',
      model: 'deepseek-v4-flash',
      succeeded: true,
      responseStatus: 200,
      execution: evidence,
    })
    evidence.nested.attempt = 99
    log.observe({
      sequence: 2,
      callId: 'optimizer-call-2',
      callRef: 'runtime:profile',
      path: '/v1/chat/completions',
      model: 'deepseek-v4-flash',
      succeeded: false,
      error: 'runtime failed',
      execution: { profileDigest: 'sha256:profile', attempt: 2 },
    })

    const contents = storage.read(path)!
    const rows = contents
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(rows[0]).toMatchObject({ execution: { nested: { attempt: 1 } } })
    expect(log.summary()).toEqual({
      scope: 'runtime-model-calls',
      path,
      sha256: `sha256:${createHash('sha256').update(contents).digest('hex')}`,
      calls: 2,
      succeeded: 1,
      failed: 1,
    })
  })
})
