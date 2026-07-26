import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { RunRecord } from '../../src/run-record'
import {
  collectTrajectoryText,
  parseArgs,
  readNdjson,
  type WithText,
} from './build-dataset'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

function record(
  runId: string,
  options: {
    splitTag?: RunRecord['splitTag']
    score?: number
    terminalOutcome?: RunRecord['terminalOutcome']
    prompt?: string
    completion?: string
  } = {},
): WithText {
  const splitTag = options.splitTag ?? 'search'
  const score = options.score ?? 1
  return {
    runId,
    experimentId: 'publication-test',
    candidateId: 'candidate',
    seed: 0,
    model: 'test-model@2026-07-01',
    promptHash: 'p'.repeat(64),
    configHash: 'c'.repeat(64),
    commitSha: 'abc1234',
    wallMs: 10,
    costUsd: 0.01,
    costProvenance: { kind: 'observed', usd: 0.01 },
    tokenUsage: { input: 10, output: 5 },
    terminalOutcome: options.terminalOutcome ?? 'succeeded',
    outcome:
      splitTag === 'holdout' ? { holdoutScore: score, raw: {} } : { searchScore: score, raw: {} },
    splitTag,
    scenarioId: `scenario-${runId}`,
    prompt: options.prompt ?? `prompt-${runId}`,
    completion: options.completion ?? `completion-${runId}`,
  }
}

describe('publish RL dataset CLI', () => {
  it('rejects DPO because the CLI has no preference input', () => {
    expect(() => parseArgs(['--formats', 'dpo'])).toThrow(/requires preference triples/)
  })

  it('validates every input line as a RunRecord', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'publish-rl-dataset-'))
    tempDirs.push(dir)
    const path = join(dir, 'runs.jsonl')
    await writeFile(
      path,
      `${JSON.stringify(record('valid'))}\n${JSON.stringify({ runId: 'bad' })}\n`,
    )

    await expect(readNdjson(path)).rejects.toThrow(/runs\.jsonl:2: missing mandatory field/)
  })

  it('rejects duplicate run IDs and duplicate trajectory text', () => {
    const duplicateId = [record('same'), record('same', { prompt: 'other' })]
    expect(() => collectTrajectoryText(duplicateId, 'prompt', 'completion')).toThrow(
      /duplicate runId/,
    )

    const duplicateText = [
      record('one', { prompt: 'same prompt', completion: 'same completion' }),
      record('two', { prompt: 'same prompt', completion: 'same completion' }),
    ]
    expect(() => collectTrajectoryText(duplicateText, 'prompt', 'completion')).toThrow(
      /duplicate prompt\/completion/,
    )
  })
})
