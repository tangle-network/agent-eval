import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  type GepaCandidatePopulationSummary,
  readGepaCandidatePopulationArtifact,
} from '../../src/campaign/gepa-candidate-population'
import { inMemoryCampaignStorage } from '../../src/campaign/storage'

const path = 'run/gepa-population.json'

describe('GEPA candidate population artifacts', () => {
  it('returns every immutable candidate with exact parents, scores, and identity', () => {
    const storage = inMemoryCampaignStorage()
    const artifact = {
      schemaVersion: 1,
      scope: 'gepa-candidate-population',
      runId: 'run-one',
      bestIndex: 1,
      candidates: [
        {
          index: 0,
          candidate: 'baseline',
          parentIndices: [null],
          aggregateScore: 0.25,
          selectionScores: [{ scenarioId: 'selection', score: 0.25 }],
          discoveryEvaluationCount: 0,
        },
        {
          index: 1,
          candidate: 'candidate',
          parentIndices: [0],
          aggregateScore: 0.75,
          selectionScores: [{ scenarioId: 'selection', score: 0.75 }],
          discoveryEvaluationCount: 1,
        },
      ],
    }
    const contents = `${JSON.stringify(artifact, null, 2)}\n`
    storage.write(path, contents)
    const summary = candidateSummary(contents)

    const result = readGepaCandidatePopulationArtifact({
      summary,
      maxCandidates: 2,
      maxCandidateChars: 100,
      scenarioIds: ['train', 'selection'],
      expectsComponents: false,
      storage,
    })

    expect(result).toMatchObject({
      summary,
      runId: 'run-one',
      bestIndex: 1,
      candidates: [
        {
          index: 0,
          candidate: 'baseline',
          parentIndices: [null],
          aggregateScore: 0.25,
          discoveryEvaluationCount: 0,
        },
        {
          index: 1,
          candidate: 'candidate',
          parentIndices: [0],
          aggregateScore: 0.75,
          discoveryEvaluationCount: 1,
        },
      ],
    })
    expect(result.candidates[0]?.candidateDigest).toMatch(/^sha256:[a-f0-9]{64}$/u)
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.summary)).toBe(true)
    expect(Object.isFrozen(result.candidates)).toBe(true)
    expect(Object.isFrozen(result.candidates[1]?.selectionScores)).toBe(true)
    expect(Reflect.set(result.summary, 'path', 'changed')).toBe(false)
    expect(() => Reflect.apply(Array.prototype.push, result.candidates, [{}])).toThrow(TypeError)
  })

  it('refuses changed bytes, false bounds, invalid parents, and unknown score cases', () => {
    const storage = inMemoryCampaignStorage()
    const artifact = {
      schemaVersion: 1,
      scope: 'gepa-candidate-population',
      runId: 'run-one',
      bestIndex: 0,
      candidates: [
        {
          index: 0,
          candidate: 'baseline',
          parentIndices: [null],
          aggregateScore: 0.25,
          selectionScores: [{ scenarioId: 'selection', score: 0.25 }],
          discoveryEvaluationCount: 0,
        },
      ],
    }
    const contents = `${JSON.stringify(artifact)}\n`
    storage.write(path, contents)
    const summary = candidateSummary(contents, 1, 0)
    const read = (overrides: Partial<Parameters<typeof readGepaCandidatePopulationArtifact>[0]>) =>
      readGepaCandidatePopulationArtifact({
        summary,
        maxCandidates: 1,
        maxCandidateChars: 100,
        scenarioIds: ['selection'],
        expectsComponents: false,
        storage,
        ...overrides,
      })

    storage.write(path, `${contents} `)
    expect(() => read({})).toThrow(/byte count mismatch/u)
    storage.write(path, contents)
    expect(() => read({ maxCandidates: 0 })).toThrow(/positive safe integer/u)

    const badParent = structuredClone(artifact)
    badParent.candidates[0]!.parentIndices = [0]
    const badParentContents = `${JSON.stringify(badParent)}\n`
    storage.write(path, badParentContents)
    expect(() => read({ summary: candidateSummary(badParentContents, 1, 0) })).toThrow(
      /invalid parent/u,
    )

    const unknownScore = structuredClone(artifact)
    unknownScore.candidates[0]!.selectionScores[0]!.scenarioId = 'final'
    const unknownScoreContents = `${JSON.stringify(unknownScore)}\n`
    storage.write(path, unknownScoreContents)
    expect(() => read({ summary: candidateSummary(unknownScoreContents, 1, 0) })).toThrow(
      /score identity/u,
    )
  })
})

function candidateSummary(
  contents: string,
  candidates = 2,
  bestIndex = 1,
): GepaCandidatePopulationSummary {
  return {
    scope: 'gepa-candidate-population',
    path,
    sha256: `sha256:${createHash('sha256').update(contents).digest('hex')}`,
    bytes: new TextEncoder().encode(contents).byteLength,
    runId: 'run-one',
    candidates,
    bestIndex,
  }
}
