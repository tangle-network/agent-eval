import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  openExternalOptimizerExecutionLog,
  openExternalOptimizerObservationLog,
  readExternalOptimizerObservationArtifact,
} from '../../src/campaign/external-optimizer-observations'
import { inMemoryCampaignStorage } from '../../src/campaign/storage'
import { canonicalJson, contentHash } from '../../src/verdict-cache'

describe('external optimizer observation artifacts', () => {
  it('retains callback-submitted candidates, per-case scores, and refusals with a digest', () => {
    const storage = inMemoryCampaignStorage()
    const path = 'run/callback-observations.jsonl'
    const log = openExternalOptimizerObservationLog({ storage, path })
    const firstCandidate = 'candidate'
    const firstHash = contentHash({ kind: 'external-text-candidate', candidate: firstCandidate })
    const secondCandidate = { policy: 'candidate two' }
    const secondHash = contentHash({ kind: 'external-text-candidate', candidate: secondCandidate })

    log.observe({
      kind: 'proposal',
      sequence: 1,
      candidate: firstCandidate,
      candidateHash: firstHash,
    })
    log.observe({
      kind: 'refusal',
      sequence: 2,
      candidate: firstCandidate,
      candidateHash: firstHash,
      exampleId: 'case-a',
      reason: 'evaluation-failed',
    })
    log.observe({
      kind: 'proposal',
      sequence: 3,
      candidate: secondCandidate,
      candidateHash: secondHash,
    })
    log.observe({
      kind: 'evaluation',
      sequence: 4,
      candidate: secondCandidate,
      candidateHash: secondHash,
      exampleId: 'case-a',
      evaluationNumber: 2,
      response: { score: 0.75 },
    })
    log.observe({
      kind: 'refusal',
      sequence: 5,
      reason: 'evaluation-limit',
      candidate: secondCandidate,
      candidateHash: secondHash,
      exampleId: 'case-b',
    })

    const contents = storage.read(path)!
    const summary = log.summary()
    expect(summary).toEqual({
      scope: 'callback-submitted-candidates',
      path,
      sha256: `sha256:${createHash('sha256').update(contents).digest('hex')}`,
      submittedCandidates: 2,
      evaluations: 1,
      refusals: 2,
    })
    const artifact = readExternalOptimizerObservationArtifact({ summary, storage })
    expect(artifact).toEqual({
      summary,
      observations: contents
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line)),
      candidates: [
        {
          candidate: firstCandidate,
          candidateHash: firstHash,
          candidateDigest: `sha256:${firstHash}`,
          proposalSequence: 1,
          provenance: { path, sha256: summary.sha256 },
        },
        {
          candidate: secondCandidate,
          candidateHash: secondHash,
          candidateDigest: `sha256:${secondHash}`,
          proposalSequence: 3,
          provenance: { path, sha256: summary.sha256 },
        },
      ],
    })
    expect(Object.isFrozen(artifact)).toBe(true)
    expect(Object.isFrozen(artifact.summary)).toBe(true)
    expect(Object.isFrozen(artifact.observations)).toBe(true)
    expect(Object.isFrozen(artifact.observations[0])).toBe(true)
    expect(Object.isFrozen(artifact.candidates)).toBe(true)
    expect(Object.isFrozen(artifact.candidates[1]?.candidate)).toBe(true)
    expect(Reflect.set(artifact.summary, 'path', 'changed')).toBe(false)
    expect(() => Reflect.apply(Array.prototype.push, artifact.candidates, [{}])).toThrow(TypeError)
    expect(Reflect.set(artifact.candidates[1]!.candidate as object, 'policy', 'changed')).toBe(
      false,
    )
  })

  it('refuses changed bytes, non-canonical rows, and false counts', () => {
    const storage = inMemoryCampaignStorage()
    const path = 'run/callback-observations.jsonl'
    const log = openExternalOptimizerObservationLog({ storage, path })
    const candidate = 'candidate'
    const candidateHash = contentHash({ kind: 'external-text-candidate', candidate })
    log.observe({ kind: 'proposal', sequence: 1, candidate, candidateHash })
    const summary = log.summary()

    storage.write(path, `${storage.read(path)} `)
    expect(() => readExternalOptimizerObservationArtifact({ summary, storage })).toThrow(
      /digest mismatch/u,
    )

    const nonCanonical = `${JSON.stringify({ sequence: 1, kind: 'proposal', candidate, candidateHash })}\n`
    storage.write(path, nonCanonical)
    const nonCanonicalSummary = {
      ...summary,
      sha256: `sha256:${createHash('sha256').update(nonCanonical).digest('hex')}` as const,
    }
    expect(() =>
      readExternalOptimizerObservationArtifact({ summary: nonCanonicalSummary, storage }),
    ).toThrow(/not canonical/u)

    const forged = `${canonicalJson({
      kind: 'proposal',
      sequence: 1,
      candidate,
      candidateHash: '0'.repeat(64),
    })}\n`
    storage.write(path, forged)
    const forgedSummary = {
      ...summary,
      sha256: `sha256:${createHash('sha256').update(forged).digest('hex')}` as const,
    }
    expect(() =>
      readExternalOptimizerObservationArtifact({ summary: forgedSummary, storage }),
    ).toThrow(/candidate hash mismatch/u)

    const canonical = `${canonicalJson({ kind: 'proposal', sequence: 1, candidate, candidateHash })}\n`
    storage.write(path, canonical)
    const falseCountSummary = {
      ...summary,
      submittedCandidates: 2,
      sha256: `sha256:${createHash('sha256').update(canonical).digest('hex')}` as const,
    }
    expect(() =>
      readExternalOptimizerObservationArtifact({ summary: falseCountSummary, storage }),
    ).toThrow(/counts disagree/u)
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
