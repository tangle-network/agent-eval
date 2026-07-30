import { mkdtemp, readFile, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { codeTraceFixture, codeTraceRow } from './benchmark-command.test-support'
import type { CodeTraceBenchRow } from './benchmark-datasets'
import { preparePublicAnalystBenchmark } from './benchmark-public-data'
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
  sha256Digest,
} from './benchmark-verification-artifacts'
import { makeFinding } from './types'

const inputOpenRace = vi.hoisted(() => ({
  openCounts: new Map<string, number>(),
  replacements: new Map<string, string>(),
}))

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  return {
    ...actual,
    open: async (path: string, flags: string | number, mode?: number) => {
      const handle = await actual.open(path, flags, mode)
      inputOpenRace.openCounts.set(path, (inputOpenRace.openCounts.get(path) ?? 0) + 1)
      const replacement = inputOpenRace.replacements.get(path)
      if (replacement) {
        inputOpenRace.replacements.delete(path)
        await actual.rename(replacement, path)
      }
      return handle
    },
  }
})

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

  it('loads prepared public benchmark case manifests', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'analyst-benchmark-manifest-'))
    const path = join(dir, 'manifest.json')
    const cases = [{ trajectory_id: 'rx-1' }, { trajectory_id: 'rx-2' }]
    await writeFile(path, JSON.stringify({ benchmark: 'AgentRx public', cases }))

    await expect(loadPublicBenchmarkRows(path)).resolves.toEqual(cases)
  })

  it.skipIf(process.platform === 'win32')(
    'uses one opened byte snapshot when label and trace paths are replaced',
    async () => {
      const fixture = await codeTraceFixture()
      const tracePath = join(fixture.traceDir, 'trace.otlp.jsonl')
      const originalLabels = await readFile(fixture.labelsPath)
      const originalTrace = await readFile(tracePath)
      const replacementLabels = join(fixture.root, 'replacement-labels.jsonl')
      const replacementTrace = join(fixture.root, 'replacement-trace.jsonl')
      await writeFile(
        replacementLabels,
        `${JSON.stringify({
          traj_id: 'replaced',
          agent: 7,
          model: 'replacement',
          task_name: 'replacement',
          step_count: 1,
          incorrect_stages: [],
        })}\n`,
      )
      await writeFile(
        replacementTrace,
        `${JSON.stringify({
          trace_id: 'trace-1',
          span_id: 'step-1',
          attributes: {
            content: JSON.stringify({ incorrect_step_ids: [1] }),
          },
        })}\n`,
      )
      inputOpenRace.openCounts.clear()
      inputOpenRace.replacements.set(fixture.labelsPath, replacementLabels)
      inputOpenRace.replacements.set(tracePath, replacementTrace)

      try {
        const prepared = await preparePublicAnalystBenchmark({
          dataset: 'codetracebench',
          labelsPath: fixture.labelsPath,
          traceDir: fixture.traceDir,
          artifactDir: fixture.artifactDir,
          limit: 1,
          seed: 0,
        })

        expect(inputOpenRace.openCounts.get(fixture.labelsPath)).toBe(1)
        expect(inputOpenRace.openCounts.get(tracePath)).toBe(1)
        expect(prepared.labelsSha256).toBe(sha256Digest(originalLabels))
        expect(prepared.traceFiles).toEqual([
          expect.objectContaining({ traceId: 'trace-1', sha256: sha256Digest(originalTrace) }),
        ])
        const trace = await prepared.cases[0]!.input.traceStore!.viewSpans({
          trace_id: 'trace-1',
          span_ids: ['step-1'],
        })
        expect(trace.spans[0]?.attributes['llm.output_messages']).toContain('Read the repository.')
        expect(await readFile(fixture.labelsPath, 'utf8')).toContain('"traj_id":"replaced"')
        expect(await readFile(tracePath, 'utf8')).toContain('incorrect_step_ids')
      } finally {
        inputOpenRace.replacements.clear()
        inputOpenRace.openCounts.clear()
      }
    },
  )

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
        class: {
          total: 3,
          missing: 0,
          counts: { positive: 2, 'trusted-negative': 1 },
        },
        agent: { total: 3, missing: 0, counts: { mini: 2, swe: 1 } },
        model: { total: 3, missing: 0, counts: { 'model-a': 2, 'model-b': 1 } },
        difficulty: { total: 3, missing: 0, counts: { easy: 2, hard: 1 } },
        solved: { total: 3, missing: 0, counts: { false: 2, true: 1 } },
      },
      selected: {
        class: { total: 1, missing: 0, counts: { positive: 1 } },
        agent: { total: 1, missing: 0, counts: { mini: 1 } },
        model: { total: 1, missing: 0, counts: { 'model-a': 1 } },
        difficulty: { total: 1, missing: 0, counts: { hard: 1 } },
        solved: { total: 1, missing: 0, counts: { false: 1 } },
      },
    })
  })

  it('does not present failed label-empty trajectories as trusted negatives', () => {
    const rows = [
      codeTraceRow('trusted-negative', {
        agent: 'mini',
        model: 'model',
        difficulty: 'easy',
        solved: true,
        incorrect: [],
      }),
      codeTraceRow('unlabeled-failure', {
        agent: 'mini',
        model: 'model',
        difficulty: 'hard',
        solved: false,
        incorrect: [],
      }),
      codeTraceRow('labeled', {
        agent: 'mini',
        model: 'model',
        difficulty: 'hard',
        solved: false,
        incorrect: [2],
      }),
    ]

    expect(publicBenchmarkSelectionReport('codetracebench', rows, rows, 0).source.class).toEqual({
      total: 3,
      missing: 0,
      counts: {
        positive: 1,
        'trusted-negative': 1,
        'unlabeled-failure': 1,
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

  it('matches the public incorrect-step task, including recovered errors', () => {
    expect(CODE_TRACE_BENCH_ANALYST_PROMPT).toContain(
      'An incorrect step remains incorrect when the agent later recovers',
    )
    expect(CODE_TRACE_BENCH_ANALYST_PROMPT).toContain(
      'CodeTraceBench scores unuseful steps separately',
    )
    expect(CODE_TRACE_BENCH_ANALYST_PROMPT).toContain(
      'Use the final-verification outcome as evidence about the final state',
    )
    expect(CODE_TRACE_BENCH_ANALYST_PROMPT).toContain('Never select an EVALUATOR, TOOL, CHAIN')
    expect(CODE_TRACE_BENCH_ANALYST_PROMPT).toContain(
      'step MUST be the positive integer n from an existing assistant LLM span',
    )
    expect(CODE_TRACE_BENCH_ANALYST_PROMPT).toContain('return an empty findings array')
  })
})

describe('public benchmark verification evidence', () => {
  it('refuses cross-case attachment and marks missing outcomes explicitly', async () => {
    const presentFixture = await codeTraceFixture()
    const [presentRow] = await loadPublicBenchmarkRows(presentFixture.labelsPath)
    const present = await loadCodeTraceVerificationArtifacts({
      artifactDir: presentFixture.artifactDir,
      row: presentRow as unknown as CodeTraceBenchRow,
    })
    expect(() =>
      appendVerificationArtifactsToOtlp('{}', 'another-trace', present, '2026-01-01T00:00:00.000Z'),
    ).toThrow(/cannot be attached/)
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
    const attached = appendVerificationArtifactsToOtlp(
      '{}',
      'trace-1',
      missing,
      '2026-01-01T00:00:00.000Z',
    )
    expect(attached).toContain('final verification outcome: unavailable')
    expect(missing).toMatchObject({
      manifest: { status: 'missing' },
      outcome: { status: 'unavailable', reason: 'missing-result' },
    })
  })

  it('orders final evidence after the source trace without inventing a distant timestamp', async () => {
    const fixture = await codeTraceFixture()
    const [row] = await loadPublicBenchmarkRows(fixture.labelsPath)
    const artifacts = await loadCodeTraceVerificationArtifacts({
      artifactDir: fixture.artifactDir,
      row: row as unknown as CodeTraceBenchRow,
    })

    const attached = appendVerificationArtifactsToOtlp(
      '{}',
      'trace-1',
      artifacts,
      '2026-01-01T00:00:00.000Z',
    )
    const spans = attached
      .trim()
      .split('\n')
      .slice(1)
      .map((line) => {
        const span = JSON.parse(line) as { start_time: string; end_time: string }
        return { start_time: span.start_time, end_time: span.end_time }
      })

    expect(spans).toEqual([
      {
        start_time: '2026-01-01T00:00:00.001Z',
        end_time: '2026-01-01T00:00:00.002Z',
      },
      {
        start_time: '2026-01-01T00:00:00.003Z',
        end_time: '2026-01-01T00:00:00.004Z',
      },
    ])
  })

  it('requires a structured final result and accepts it without a duplicate test log', async () => {
    const testOnlyFixture = await codeTraceFixture()
    await unlink(
      join(testOnlyFixture.artifactDir, 'trace-1', 'cases', 'trace-1', 'task-1_result.json'),
    )
    const [testOnlyRow] = await loadPublicBenchmarkRows(testOnlyFixture.labelsPath)

    await expect(
      loadCodeTraceVerificationArtifacts({
        artifactDir: testOnlyFixture.artifactDir,
        row: testOnlyRow as unknown as CodeTraceBenchRow,
      }),
    ).resolves.toMatchObject({
      manifest: {
        status: 'missing',
        outcome: { status: 'unavailable', reason: 'missing-result' },
        missingRoles: expect.arrayContaining(['final-result']),
      },
    })

    const resultOnlyFixture = await codeTraceFixture()
    await unlink(
      join(resultOnlyFixture.artifactDir, 'trace-1', 'cases', 'trace-1', 'panes', 'post-test.txt'),
    )
    const [resultOnlyRow] = await loadPublicBenchmarkRows(resultOnlyFixture.labelsPath)

    await expect(
      loadCodeTraceVerificationArtifacts({
        artifactDir: resultOnlyFixture.artifactDir,
        row: resultOnlyRow as unknown as CodeTraceBenchRow,
      }),
    ).resolves.toMatchObject({
      manifest: {
        status: 'present',
        outcome: { status: 'failed' },
        missingRoles: expect.arrayContaining(['final-test-output']),
      },
    })
  })
})
