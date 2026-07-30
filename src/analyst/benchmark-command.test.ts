import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { AnalystBenchmarkRunner } from './benchmark'
import { runAnalystBenchmarkCommand } from './benchmark-command'
import type { CodeTraceBenchRow } from './benchmark-datasets'
import {
  adaptPublicBenchmarkFindings,
  CODE_TRACE_BENCH_ANALYST_PROMPT,
  loadPublicBenchmarkRows,
  publicBenchmarkSelectionReport,
  selectPublicBenchmarkRows,
} from './benchmark-real-model'
import {
  appendVerificationArtifactsToOtlp,
  loadCodeTraceVerificationArtifacts,
} from './benchmark-verification-artifacts'
import type { AnalystRunInputs, AnalystUsageReceipt } from './types'
import { makeFinding } from './types'

const UNKNOWN_USAGE: AnalystUsageReceipt = {
  calls: 1,
  tokens: null,
  cost: { kind: 'uncaptured', usd: null },
}

describe('public analyst benchmark input', () => {
  it('loads public dataset arrays and JSONL without changing row fields', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'analyst-benchmark-input-'))
    const arrayPath = join(dir, 'rows.json')
    const jsonlPath = join(dir, 'rows.jsonl')
    const rows = [{ traj_id: 'a', extra: { retained: true } }, { traj_id: 'b' }]
    await writeFile(arrayPath, JSON.stringify(rows))
    await writeFile(jsonlPath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`)

    await expect(loadPublicBenchmarkRows(arrayPath)).resolves.toEqual(rows)
    await expect(loadPublicBenchmarkRows(jsonlPath)).resolves.toEqual(rows)
  })

  it('selects the same cases for the same seed independent of input order', () => {
    const rows = Array.from({ length: 12 }, (_, index) => ({ traj_id: `trace-${index}` }))
    const first = selectPublicBenchmarkRows('codetracebench', rows, { limit: 5, seed: 19 })
    const repeated = selectPublicBenchmarkRows('codetracebench', [...rows].reverse(), {
      limit: 5,
      seed: 19,
    })
    const changed = selectPublicBenchmarkRows('codetracebench', rows, { limit: 5, seed: 20 })

    expect(repeated.map((row) => row.traj_id)).toEqual(first.map((row) => row.traj_id))
    expect(changed.map((row) => row.traj_id)).not.toEqual(first.map((row) => row.traj_id))
  })

  it('marks limited hash samples non-representative and reports every requested distribution', () => {
    const rows = [
      codeTraceRow('bad-a', {
        agent: 'mini',
        model: 'model-a',
        difficulty: 'hard',
        solved: false,
        incorrect: [2],
      }),
      codeTraceRow('bad-b', {
        agent: 'mini',
        model: 'model-b',
        difficulty: 'easy',
        solved: false,
        incorrect: [1],
      }),
      codeTraceRow('clean-a', {
        agent: 'swe',
        model: 'model-a',
        difficulty: 'easy',
        solved: true,
        incorrect: [],
      }),
    ]

    const report = publicBenchmarkSelectionReport('codetracebench', rows, [rows[0]!], 11)

    expect(report).toEqual({
      method: 'deterministic-hash',
      seed: 11,
      sourceCount: 3,
      selectedCount: 1,
      stratified: false,
      representativeOfInput: false,
      source: {
        class: { total: 3, missing: 0, counts: { clean: 1, incorrect: 2 } },
        agent: { total: 3, missing: 0, counts: { mini: 2, swe: 1 } },
        model: { total: 3, missing: 0, counts: { 'model-a': 2, 'model-b': 1 } },
        difficulty: { total: 3, missing: 0, counts: { easy: 2, hard: 1 } },
        solved: { total: 3, missing: 0, counts: { false: 2, true: 1 } },
      },
      selected: {
        class: { total: 1, missing: 0, counts: { incorrect: 1 } },
        agent: { total: 1, missing: 0, counts: { mini: 1 } },
        model: { total: 1, missing: 0, counts: { 'model-a': 1 } },
        difficulty: { total: 1, missing: 0, counts: { hard: 1 } },
        solved: { total: 1, missing: 0, counts: { false: 1 } },
      },
    })
  })
})

describe('public analyst benchmark output adapters', () => {
  it('splits CodeTraceBench citations into one incorrect-step finding per label', () => {
    const findings = adaptPublicBenchmarkFindings(
      'codetracebench',
      'run/1',
      [
        makeFinding({
          analyst_id: 'model-raw',
          area: 'model-output',
          claim: 'Two actions are incorrect.',
          severity: 'high',
          confidence: 0.8,
          evidence_refs: [
            { kind: 'span', uri: 'trace://run%2F1/span/step-2' },
            { kind: 'span', uri: 'trace://run%2F1/span/step-4' },
          ],
        }),
      ],
      'model',
    )

    expect(findings.map((finding) => finding.area)).toEqual(['incorrect', 'incorrect'])
    expect(findings.map((finding) => finding.evidence_refs[0]?.uri)).toEqual([
      'trace://run%2F1/span/step-2',
      'trace://run%2F1/span/step-4',
    ])
  })

  it('maps the explicit CodeTraceBench clean sentinel to no findings', () => {
    const findings = adaptPublicBenchmarkFindings(
      'codetracebench',
      'clean-run',
      [
        makeFinding({
          analyst_id: 'model-raw',
          area: 'model-output',
          subject: 'clean',
          claim: 'No incorrect steps were found.',
          severity: 'info',
          confidence: 0.8,
          evidence_refs: [{ kind: 'span', uri: 'trace://clean-run/span/step-1' }],
        }),
      ],
      'model',
    )

    expect(findings).toEqual([])
  })

  it('uses the maintained AgentRx prediction adapter for taxonomy and root step', () => {
    const [finding] = adaptPublicBenchmarkFindings(
      'agentrx',
      'rx-1',
      [
        makeFinding({
          analyst_id: 'model-raw',
          area: 'model-output',
          subject: 'system-failure',
          claim: 'The provider became unavailable.',
          rationale: 'The first unrecoverable error occurs at step 3.',
          severity: 'high',
          confidence: 0.9,
          evidence_refs: [{ kind: 'span', uri: 'trace://rx-1/span/step-3' }],
        }),
      ],
      'model',
    )

    expect(finding).toMatchObject({
      analyst_id: 'model',
      area: 'system-failure',
      evidence_refs: [{ kind: 'span', uri: 'trace://rx-1/span/step-3' }],
    })
  })

  it('defines incorrect steps by task causality rather than recovered local errors', () => {
    expect(CODE_TRACE_BENCH_ANALYST_PROMPT).toContain(
      'A command, tool, or inspection error is not an incorrect step when the agent recovers',
    )
    expect(CODE_TRACE_BENCH_ANALYST_PROMPT).toContain(
      'Inspect every final-verification EVALUATOR span',
    )
  })
})

describe('public benchmark verification evidence', () => {
  it('refuses empty or cross-case evidence attachment', async () => {
    const presentFixture = await codeTraceFixture()
    const [presentRow] = await loadPublicBenchmarkRows(presentFixture.labelsPath)
    const present = await loadCodeTraceVerificationArtifacts({
      artifactDir: presentFixture.artifactDir,
      row: presentRow as unknown as CodeTraceBenchRow,
    })
    expect(() => appendVerificationArtifactsToOtlp('{}', 'another-trace', present)).toThrow(
      /cannot be attached/,
    )
    await expect(
      loadCodeTraceVerificationArtifacts({
        artifactDir: join(presentFixture.artifactDir, 'trace-1'),
        row: presentRow as unknown as CodeTraceBenchRow,
      }),
    ).resolves.toMatchObject({ manifest: { status: 'present' } })

    const missingFixture = await codeTraceFixture({ withVerificationArtifacts: false })
    const [missingRow] = await loadPublicBenchmarkRows(missingFixture.labelsPath)
    const missing = await loadCodeTraceVerificationArtifacts({
      artifactDir: missingFixture.artifactDir,
      row: missingRow as unknown as CodeTraceBenchRow,
    })
    expect(() => appendVerificationArtifactsToOtlp('{}', 'trace-1', missing)).toThrow(
      /no final verification artifacts/,
    )
  })
})

describe('runAnalystBenchmarkCommand', () => {
  it('writes complete paired results and preserves unknown model cost', async () => {
    const fixture = await codeTraceFixture()
    const modelRunner: AnalystBenchmarkRunner<AnalystRunInputs> = {
      id: 'model',
      async analyze(input, context) {
        const trace = await input.traceStore?.viewTrace({ trace_id: 'trace-1' })
        const verificationSpans = trace?.spans?.filter((span) => span.kind === 'EVALUATOR') ?? []
        expect(verificationSpans.map((span) => span.name)).toEqual([
          'final verification: panes/post-test.txt',
          'final verification: task-1_result.json',
        ])
        await expect(
          input.traceStore?.searchTrace({
            trace_id: 'trace-1',
            regex_pattern: 'hidden assertion failed',
          }),
        ).resolves.toMatchObject({
          hits: [expect.objectContaining({ span_id: verificationSpans[0]?.span_id })],
        })
        return {
          findings: [
            makeFinding({
              analyst_id: 'model',
              area: 'incorrect',
              claim: 'Step 2 changes the wrong file.',
              severity: 'high',
              confidence: 0.9,
              evidence_refs: [{ kind: 'span', uri: 'trace://trace-1/span/step-2' }],
            }),
          ],
          usage: UNKNOWN_USAGE,
          metadata: { caseId: context.caseId },
        }
      },
    }

    const code = await runAnalystBenchmarkCommand(
      commandArgs(fixture),
      { TEST_ANALYST_KEY: 'do-not-persist-this-key' },
      { createModelRunner: () => modelRunner },
    )

    expect(code).toBe(0)
    const artifact = JSON.parse(
      await readFile(join(fixture.outDir, 'result.json'), 'utf8'),
    ) as Record<string, any>
    expect(artifact.result.provenance).toMatchObject({
      caseCount: 1,
      runnerIds: ['empty', 'model'],
      runnerOrderSeed: 7,
    })
    expect(artifact.result.summaries).toEqual([
      expect.objectContaining({ runnerId: 'empty', issueRecall: 0, knownCostUsd: 0 }),
      expect.objectContaining({
        runnerId: 'model',
        issueRecall: 1,
        costUnknownRuns: 1,
        knownCostUsd: 0,
      }),
    ])
    expect(artifact.result.observations[1].usage).toEqual(UNKNOWN_USAGE)
    expect(artifact.inputs.verificationArtifacts).toEqual([
      expect.objectContaining({
        traceId: 'trace-1',
        status: 'present',
        caseDirectoriesSearched: expect.arrayContaining([
          expect.stringContaining('/trace-1/cases/trace-1'),
        ]),
        totalBytes: expect.any(Number),
        missingRoles: ['final-metrics'],
        files: [
          expect.objectContaining({
            role: 'final-test-output',
            relativePath: 'panes/post-test.txt',
            sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
            spanId: expect.stringMatching(/^benchmark-verification-/),
          }),
          expect.objectContaining({
            role: 'final-result',
            relativePath: 'task-1_result.json',
            sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
            spanId: expect.stringMatching(/^benchmark-verification-/),
          }),
        ],
      }),
    ])
    expect(artifact.result.observations[1].caseMetadata.verificationArtifacts).toMatchObject({
      status: 'present',
      missingRoles: ['final-metrics'],
    })
    expect(artifact.inputs.selection.report).toMatchObject({
      method: 'census',
      representativeOfInput: true,
      source: {
        class: { total: 1, missing: 0, counts: { incorrect: 1 } },
        agent: { total: 1, missing: 0, counts: { 'mini-SWE-agent': 1 } },
        model: { total: 1, missing: 0, counts: { 'test-worker': 1 } },
        difficulty: { total: 1, missing: 1, counts: {} },
        solved: { total: 1, missing: 1, counts: {} },
      },
    })
    expect(artifact.comparisons[0]).toMatchObject({
      baselineRunnerId: 'empty',
      candidateRunnerId: 'model',
    })
    expect(JSON.stringify(artifact)).not.toContain('do-not-persist-this-key')
    await expect(readFile(join(fixture.outDir, 'report.md'), 'utf8')).resolves.toContain(
      'This is a census of the supplied input.',
    )
  })

  it('rejects missing labeled spans before constructing or calling a model runner', async () => {
    const fixture = await codeTraceFixture({ labeledStep: 3 })
    const createModelRunner = vi.fn()

    await expect(
      runAnalystBenchmarkCommand(
        commandArgs(fixture),
        { TEST_ANALYST_KEY: 'unused' },
        { createModelRunner },
      ),
    ).rejects.toThrow(/missing labeled span step-3/)
    expect(createModelRunner).not.toHaveBeenCalled()
  })

  it('refuses a trajectory-only CodeTraceBench run before constructing the model runner', async () => {
    const fixture = await codeTraceFixture({ withVerificationArtifacts: false })
    const createModelRunner = vi.fn()

    await expect(
      runAnalystBenchmarkCommand(
        commandArgs(fixture),
        { TEST_ANALYST_KEY: 'unused' },
        { createModelRunner },
      ),
    ).rejects.toThrow(/no final verification artifact/)
    expect(createModelRunner).not.toHaveBeenCalled()
  })

  it('refuses credential-bearing base URLs before constructing the model runner', async () => {
    const fixture = await codeTraceFixture()
    const args = commandArgs(fixture)
    args[args.indexOf('--base-url') + 1] = 'http://secret@127.0.0.1:3355/v1'
    const createModelRunner = vi.fn()

    await expect(
      runAnalystBenchmarkCommand(args, { TEST_ANALYST_KEY: 'unused' }, { createModelRunner }),
    ).rejects.toThrow(/without credentials/)
    expect(createModelRunner).not.toHaveBeenCalled()
  })

  it('runs AgentRx without imposing CodeTraceBench artifact requirements', async () => {
    const fixture = await agentRxFixture()
    const modelRunner: AnalystBenchmarkRunner<AnalystRunInputs> = {
      id: 'model',
      analyze() {
        return {
          findings: [
            makeFinding({
              analyst_id: 'model',
              area: 'system-failure',
              claim: 'The worker lost its provider at the root step.',
              severity: 'high',
              confidence: 0.9,
              evidence_refs: [{ kind: 'span', uri: 'trace://rx-1/span/step-1' }],
            }),
          ],
          usage: UNKNOWN_USAGE,
        }
      },
    }

    await expect(
      runAnalystBenchmarkCommand(
        agentRxCommandArgs(fixture),
        { TEST_ANALYST_KEY: 'unused' },
        { createModelRunner: () => modelRunner },
      ),
    ).resolves.toBe(0)

    const artifact = JSON.parse(
      await readFile(join(fixture.outDir, 'result.json'), 'utf8'),
    ) as Record<string, any>
    expect(artifact.inputs.verificationArtifacts).toEqual([])
    expect(artifact.inputs.artifactDir).toBeUndefined()
    expect(artifact.inputs.selection.report.source).toMatchObject({
      class: { total: 1, missing: 0, counts: { 'system-failure': 1 } },
      agent: { total: 1, missing: 0, counts: { worker: 1 } },
      model: { total: 1, missing: 1, counts: {} },
    })
    expect(
      artifact.result.summaries.map((summary: { runnerId: string }) => summary.runnerId),
    ).toEqual(['empty', 'model'])
  })
})

async function codeTraceFixture(
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
      `${JSON.stringify({ resolved: false, tests: { passed: 4, failed: 1 } })}\n`,
    )
  }
  return { labelsPath, traceDir, artifactDir, outDir }
}

async function agentRxFixture() {
  const root = await mkdtemp(join(tmpdir(), 'analyst-benchmark-agentrx-'))
  const traceDir = join(root, 'traces')
  const outDir = join(root, 'out')
  const labelsPath = join(root, 'labels.json')
  await mkdir(traceDir)
  await writeFile(
    labelsPath,
    JSON.stringify({
      trajectory_id: 'rx-1',
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
    }),
  )
  await writeFile(
    join(traceDir, 'trace.otlp.jsonl'),
    `${otlpSpan('rx-1', 'step-1', 'The provider request failed permanently.')}\n`,
  )
  return { labelsPath, traceDir, outDir }
}

function commandArgs(fixture: {
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

function agentRxCommandArgs(fixture: {
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
    'contact-gated-fixture',
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

function codeTraceRow(
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
