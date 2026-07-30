import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ANALYST_BENCHMARK_OBSERVATIONS_FILE } from './benchmark-command'
import type { AnalystUsageReceipt } from './types'

export const UNKNOWN_USAGE: AnalystUsageReceipt = {
  calls: 1,
  tokens: null,
  cost: { kind: 'uncaptured', usd: null },
}

export const AGENT_RX_TEST_REVISION = 'abcdef0123456789abcdef0123456789abcdef01'

export async function progressRows(outDir: string): Promise<
  Array<{
    sequence: number
    observation: {
      runnerId: string
      caseId: string
      repetition: number
    }
  }>
> {
  const text = await readFile(join(outDir, ANALYST_BENCHMARK_OBSERVATIONS_FILE), 'utf8')
  return text
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

export async function codeTraceFixture(
  options: { labeledStep?: number; withVerificationArtifacts?: boolean } = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'analyst-benchmark-command-'))
  const traceDir = join(root, 'traces')
  const artifactDir = join(root, 'artifacts')
  const caseArtifactDir = join(artifactDir, 'trace-1', 'cases', 'trace-1')
  const outDir = join(root, 'out')
  const labelsPath = join(root, 'labels.jsonl')
  await mkdir(traceDir)
  await mkdir(caseArtifactDir, { recursive: true })
  const labeledStep = options.labeledStep ?? 2
  await writeFile(
    labelsPath,
    `${JSON.stringify({
      traj_id: 'trace-1',
      agent: 'mini-SWE-agent',
      model: 'test-worker',
      task_name: 'task-1',
      source_relpath: 'cases/trace-1',
      step_count: Math.max(2, labeledStep),
      incorrect_stages: [{ stage_id: 1, incorrect_step_ids: [labeledStep] }],
    })}\n`,
  )
  await writeFile(
    join(traceDir, 'trace.otlp.jsonl'),
    `${[
      otlpSpan('trace-1', 'step-1', 'Read the repository.'),
      otlpSpan('trace-1', 'step-2', 'Changed the wrong file.'),
    ].join('\n')}\n`,
  )
  if (options.withVerificationArtifacts !== false) {
    await mkdir(join(caseArtifactDir, 'panes'))
    await writeFile(
      join(caseArtifactDir, 'panes', 'post-test.txt'),
      'FAILED: hidden assertion failed after the agent finished\n',
    )
    await writeFile(
      join(caseArtifactDir, 'task-1_result.json'),
      `${JSON.stringify({
        resolved: false,
        passed_tests: ['test-a', 'test-b', 'test-c', 'test-d'],
        failed_tests: ['hidden assertion'],
      })}\n`,
    )
  }
  return { root, labelsPath, traceDir, artifactDir, outDir }
}

export async function agentRxFixture(options: { caseCount?: number } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'analyst-benchmark-agentrx-'))
  const traceDir = join(root, 'traces')
  const outDir = join(root, 'out')
  const labelsPath = join(root, 'labels.json')
  const caseCount = options.caseCount ?? 1
  const labels = Array.from({ length: caseCount }, (_, index) => ({
    trajectory_id: `rx-${index + 1}`,
    failures: [
      {
        failure_id: 'root',
        step_number: 1,
        step_reason: 'Provider unavailable.',
        failure_category: 'System Failure',
        failed_agent: 'worker',
      },
    ],
    root_cause_failure_id: 'root',
    num_failures: 1,
  }))
  await mkdir(traceDir)
  await writeFile(labelsPath, JSON.stringify(caseCount === 1 ? labels[0] : labels))
  for (const label of labels) {
    await writeFile(
      join(traceDir, `${label.trajectory_id}.otlp.jsonl`),
      `${otlpSpan(label.trajectory_id, 'step-1', 'The provider request failed permanently.')}\n`,
    )
  }
  return { root, labelsPath, traceDir, outDir }
}

export function commandArgs(fixture: {
  labelsPath: string
  traceDir: string
  artifactDir: string
  outDir: string
}): string[] {
  return [
    '--dataset',
    'codetracebench',
    '--labels',
    fixture.labelsPath,
    '--trace-dir',
    fixture.traceDir,
    '--artifact-dir',
    fixture.artifactDir,
    '--out',
    fixture.outDir,
    '--revision',
    'ae5926b496f2f7f4c3f6337c0ad6150311d3650c5f3bd00660556b3e41739505',
    '--split',
    'verified',
    '--base-url',
    'http://127.0.0.1:3355/v1',
    '--api-key-env',
    'TEST_ANALYST_KEY',
    '--model',
    'opencode/zai-coding-plan/glm-5.2',
    '--limit',
    '1',
    '--seed',
    '7',
    '--concurrency',
    '2',
  ]
}

export function agentRxCommandArgs(fixture: {
  labelsPath: string
  traceDir: string
  outDir: string
}): string[] {
  return [
    '--dataset',
    'agentrx',
    '--labels',
    fixture.labelsPath,
    '--trace-dir',
    fixture.traceDir,
    '--out',
    fixture.outDir,
    '--revision',
    AGENT_RX_TEST_REVISION.toUpperCase(),
    '--split',
    'test',
    '--base-url',
    'http://127.0.0.1:3355/v1',
    '--api-key-env',
    'TEST_ANALYST_KEY',
    '--model',
    'opencode/kimi-for-coding/k3',
    '--limit',
    '1',
  ]
}

export function codeTraceRow(
  id: string,
  options: {
    agent: string
    model: string
    difficulty: string
    solved: boolean
    incorrect: number[]
  },
): Record<string, unknown> {
  return {
    traj_id: id,
    agent: options.agent,
    model: options.model,
    task_name: id,
    difficulty: options.difficulty,
    solved: options.solved,
    step_count: 2,
    incorrect_stages: [{ stage_id: 1, incorrect_step_ids: options.incorrect }],
  }
}

function otlpSpan(traceId: string, spanId: string, output: string): string {
  return JSON.stringify({
    trace_id: traceId,
    span_id: spanId,
    parent_span_id: null,
    name: `assistant ${spanId}`,
    kind: 'LLM',
    start_time: '2026-07-30T00:00:00.000Z',
    end_time: '2026-07-30T00:00:01.000Z',
    status: 'OK',
    attributes: {
      'llm.output_messages': JSON.stringify([{ role: 'assistant', content: output }]),
    },
  })
}
