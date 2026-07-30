import { readFile, symlink, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readAnalystBenchmarkArtifact, runAnalystBenchmarkCommand } from './benchmark-command'
import {
  agentRxCommandArgs,
  agentRxFixture,
  codeTraceFixture,
  commandArgs,
  UNKNOWN_USAGE,
} from './benchmark-command.test-support'

describe('analyst benchmark artifact reader', () => {
  it('rejects unknown fields in a completed result', async () => {
    const fixture = await agentRxFixture()
    await runAnalystBenchmarkCommand(
      agentRxCommandArgs(fixture),
      { TEST_ANALYST_KEY: 'unused' },
      {
        createModelRunner: () => ({
          id: 'model',
          analyze: () => ({ findings: [], usage: UNKNOWN_USAGE }),
        }),
      },
    )
    const path = join(fixture.outDir, 'result.json')
    const artifact = JSON.parse(await readFile(path, 'utf8'))
    artifact.unexpected = true
    await writeFile(path, `${JSON.stringify(artifact)}\n`)

    await expect(readAnalystBenchmarkArtifact(path)).rejects.toThrow(
      /contains unknown field 'unexpected'/,
    )
  })

  it.each([
    {
      name: 'fabricated summary metric types',
      dataset: 'agentrx',
      mutate: (artifact: Record<string, unknown>) => {
        const summary = firstRecord(object(artifact, 'result'), 'summaries')
        summary.issueRecall = 'fabricated'
      },
      error: /summaries\.0\.issueRecall/,
    },
    {
      name: 'malformed comparison rows',
      dataset: 'agentrx',
      mutate: (artifact: Record<string, unknown>) => {
        array(artifact, 'comparisons')[0] = {}
      },
      error: /comparisons\.0\.baselineRunnerId/,
    },
    {
      name: 'finding {}',
      dataset: 'agentrx',
      mutate: (artifact: Record<string, unknown>) => {
        const observation = firstRecord(object(artifact, 'result'), 'observations')
        observation.findings = [{}]
      },
      error: /findings\.0\.schema_version/,
    },
    {
      name: 'score {}',
      dataset: 'agentrx',
      mutate: (artifact: Record<string, unknown>) => {
        const observation = firstRecord(object(artifact, 'result'), 'observations')
        observation.score = {}
      },
      error: /score\.expectedIssueCount/,
    },
    {
      name: 'unknown evidence fields',
      dataset: 'agentrx',
      mutate: (artifact: Record<string, unknown>) => {
        const observation = firstRecord(object(artifact, 'result'), 'observations')
        observation.findings = [
          {
            schema_version: '1.0.0',
            finding_id: 'finding-1',
            analyst_id: 'model',
            produced_at: '2026-07-30T00:00:00.000Z',
            severity: 'high',
            area: 'tool-use',
            claim: 'The tool call failed.',
            evidence_refs: [
              {
                kind: 'span',
                uri: 'trace://rx-1/span/step-1',
                unexpected: true,
              },
            ],
            confidence: 0.9,
          },
        ]
      },
      error: /evidence_refs\.0 contains unknown field 'unexpected'/,
    },
    {
      name: 'unknown nested input fields',
      dataset: 'agentrx',
      mutate: (artifact: Record<string, unknown>) => {
        object(object(artifact, 'inputs'), 'execution').unexpected = true
      },
      error: /inputs\.execution contains unknown field 'unexpected'/,
    },
    {
      name: 'fabricated provenance types',
      dataset: 'agentrx',
      mutate: (artifact: Record<string, unknown>) => {
        object(object(artifact, 'result'), 'provenance').runnerOrderSeed = 'fabricated'
      },
      error: /provenance\.runnerOrderSeed/,
    },
    {
      name: 'invalid provider status',
      dataset: 'agentrx',
      mutate: (artifact: Record<string, unknown>) => {
        const observation = firstRecord(object(artifact, 'result'), 'observations')
        observation.error = {
          class: 'LlmCallError',
          message: 'Provider request failed.',
          status: 99,
        }
      },
      error: /observations\.0\.error\.status/,
    },
    {
      name: 'fabricated AgentRx calibration types',
      dataset: 'agentrx',
      mutate: (artifact: Record<string, unknown>) => {
        const runner = firstRecord(object(artifact, 'agentRxCalibration'), 'runners')
        runner.exactStepAccuracy = 'fabricated'
      },
      error: /agentRxCalibration\.runners\.0\.exactStepAccuracy/,
    },
    {
      name: 'fabricated CodeTraceBench calibration types',
      dataset: 'codetracebench',
      mutate: (artifact: Record<string, unknown>) => {
        const runner = firstRecord(object(artifact, 'codeTraceCalibration'), 'runners')
        runner.precision = 'fabricated'
      },
      error: /codeTraceCalibration\.runners\.0\.precision/,
    },
  ] satisfies Array<{
    name: string
    dataset: 'agentrx' | 'codetracebench'
    mutate: (artifact: Record<string, unknown>) => void
    error: RegExp
  }>)('rejects $name', async ({ dataset, mutate, error }) => {
    const path = await completedResultPath(dataset)
    const artifact = record(JSON.parse(await readFile(path, 'utf8')))
    mutate(artifact)
    await writeFile(path, `${JSON.stringify(artifact)}\n`)

    await expect(readAnalystBenchmarkArtifact(path)).rejects.toThrow(error)
  })

  it('rejects a symbolic-link result file', async () => {
    const fixture = await agentRxFixture()
    await runAnalystBenchmarkCommand(
      agentRxCommandArgs(fixture),
      { TEST_ANALYST_KEY: 'unused' },
      {
        createModelRunner: () => ({
          id: 'model',
          analyze: () => ({ findings: [], usage: UNKNOWN_USAGE }),
        }),
      },
    )
    const path = join(fixture.outDir, 'result.json')
    const target = join(fixture.root, 'attacker-result.json')
    await writeFile(target, await readFile(path, 'utf8'))
    await unlink(path)
    await symlink(target, path)

    await expect(readAnalystBenchmarkArtifact(path)).rejects.toThrow(/must be a real file/)
  })
})

async function completedResultPath(dataset: 'agentrx' | 'codetracebench'): Promise<string> {
  const fixture = dataset === 'agentrx' ? await agentRxFixture() : await codeTraceFixture()
  const args =
    dataset === 'agentrx'
      ? agentRxCommandArgs(fixture)
      : commandArgs(fixture as Awaited<ReturnType<typeof codeTraceFixture>>)
  await runAnalystBenchmarkCommand(
    args,
    { TEST_ANALYST_KEY: 'unused' },
    {
      createModelRunner: () => ({
        id: 'model',
        analyze: () => ({ findings: [], usage: UNKNOWN_USAGE }),
      }),
    },
  )
  return join(fixture.outDir, 'result.json')
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('test fixture value must be an object')
  }
  return value as Record<string, unknown>
}

function object(parent: Record<string, unknown>, key: string): Record<string, unknown> {
  return record(parent[key])
}

function array(parent: Record<string, unknown>, key: string): unknown[] {
  const value = parent[key]
  if (!Array.isArray(value)) throw new TypeError(`test fixture '${key}' must be an array`)
  return value
}

function firstRecord(parent: Record<string, unknown>, key: string): Record<string, unknown> {
  return record(array(parent, key)[0])
}
