import { mkdtemp, readFile, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { TraceAnalysisStore } from '../trace-analyst/store'
import { codeTraceFixture, codeTraceRow } from './benchmark-command.test-support'
import type { CodeTraceBenchRow } from './benchmark-datasets'
import { preparePublicAnalystBenchmark } from './benchmark-public-data'
import {
  adaptPublicBenchmarkFindings,
  CODE_TRACE_BENCH_ANALYST_PROMPT,
  loadPublicBenchmarkRows,
  MAX_INCORRECT_BLOCK_STEPS,
  MAX_INCORRECT_BLOCKS,
  publicBenchmarkRlmInstructions,
  publicBenchmarkSelectionReport,
  publicBenchmarkSystemPrompt,
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
  it('expands a subject-encoded failure block into one incorrect-step finding per member', async () => {
    const { findings, diagnostics } = await adaptPublicBenchmarkFindings({
      dataset: 'codetracebench',
      trajectoryId: 'run/1',
      findings: [
        makeFinding({
          analyst_id: 'model-raw',
          area: 'model-output',
          subject: 'incorrect-steps-2-4-unescaped-consequence-6',
          claim: 'The block wrote and deployed an invalid configuration.',
          severity: 'high',
          confidence: 0.8,
          evidence_refs: [
            { kind: 'span', uri: 'trace://run%2F1/span/step-2', excerpt: adapterAction(2) },
            { kind: 'span', uri: 'trace://run%2F1/span/step-4', excerpt: adapterAction(4) },
          ],
        }),
      ],
      analystId: 'model',
      store: adapterTraceStore('run/1', [2, 3, 4, 6]),
    })

    expect(findings.map((finding) => finding.area)).toEqual(['incorrect', 'incorrect', 'incorrect'])
    expect(findings.map((finding) => finding.evidence_refs[0]?.uri)).toEqual([
      'trace://run%2F1/span/step-2',
      'trace://run%2F1/span/step-3',
      'trace://run%2F1/span/step-4',
    ])
    expect(findings[0]?.metadata).toMatchObject({
      block_first_step: 2,
      block_last_step: 4,
      block_consequence_step: 6,
      escape_status: 'unescaped',
    })
    expect(diagnostics).toMatchObject({ reportedBlocks: 1, escapedBlocks: 0 })
  })

  it('scores an escaped block exactly like an unescaped one and records the decision', async () => {
    const { findings, diagnostics } = await adaptPublicBenchmarkFindings({
      dataset: 'codetracebench',
      trajectoryId: 'run-2',
      findings: [
        makeFinding({
          analyst_id: 'model-raw',
          area: 'model-output',
          subject: 'incorrect-steps-2-2-escaped-consequence-3',
          claim: 'The failed install was rerun successfully.',
          severity: 'medium',
          confidence: 0.8,
          evidence_refs: [
            { kind: 'span', uri: 'trace://run-2/span/step-2', excerpt: adapterAction(2) },
          ],
        }),
      ],
      analystId: 'model',
      store: adapterTraceStore('run-2', [2, 3]),
    })

    expect(findings.map((finding) => finding.subject)).toEqual(['incorrect-step-2'])
    expect(findings[0]?.metadata).toMatchObject({ escape_status: 'escaped' })
    expect(diagnostics).toMatchObject({ reportedBlocks: 1, escapedBlocks: 1 })
  })

  it('drops a block whose consequence step is not a real assistant step', async () => {
    const { findings, diagnostics } = await adaptPublicBenchmarkFindings({
      dataset: 'codetracebench',
      trajectoryId: 'run-3',
      findings: [
        makeFinding({
          analyst_id: 'model-raw',
          area: 'model-output',
          subject: 'incorrect-steps-2-2-unescaped-consequence-99',
          claim: 'An accusation with no downstream evidence.',
          severity: 'high',
          confidence: 0.8,
          evidence_refs: [
            { kind: 'span', uri: 'trace://run-3/span/step-2', excerpt: adapterAction(2) },
          ],
        }),
      ],
      analystId: 'model',
      store: adapterTraceStore('run-3', [2, 3]),
    })

    expect(findings).toEqual([])
    expect(diagnostics?.blocksWithoutConsequenceEvidence).toHaveLength(1)
  })

  it('refuses a CodeTraceBench finding whose subject is not a failure block', async () => {
    await expect(
      adaptPublicBenchmarkFindings({
        dataset: 'codetracebench',
        trajectoryId: 'run-4',
        findings: [
          makeFinding({
            analyst_id: 'model-raw',
            area: 'model-output',
            subject: 'incorrect-step-2',
            claim: 'Legacy per-step subject.',
            severity: 'high',
            confidence: 0.8,
            evidence_refs: [
              { kind: 'span', uri: 'trace://run-4/span/step-2', excerpt: adapterAction(2) },
            ],
          }),
        ],
        analystId: 'model',
        store: adapterTraceStore('run-4', [2, 3]),
      }),
    ).rejects.toThrow(/incorrect-steps-<first>-<last>-<escaped\|unescaped>-consequence-<step>/)
  })

  it('refuses a block whose own citation excerpt is not in the cited action', async () => {
    await expect(
      adaptPublicBenchmarkFindings({
        dataset: 'codetracebench',
        trajectoryId: 'run-8',
        findings: [
          makeFinding({
            analyst_id: 'model-raw',
            area: 'model-output',
            subject: 'incorrect-steps-2-2-unescaped-consequence-3',
            claim: 'Quotes an action the span does not contain.',
            severity: 'high',
            confidence: 0.8,
            evidence_refs: [
              { kind: 'span', uri: 'trace://run-8/span/step-2', excerpt: 'rm -rf /invented' },
            ],
          }),
        ],
        analystId: 'model',
        store: adapterTraceStore('run-8', [2, 3]),
      }),
    ).rejects.toThrow(/excerpt is not present/)
  })

  it('refuses a block citation outside the block it declares', async () => {
    await expect(
      adaptPublicBenchmarkFindings({
        dataset: 'codetracebench',
        trajectoryId: 'run-5',
        findings: [
          makeFinding({
            analyst_id: 'model-raw',
            area: 'model-output',
            subject: 'incorrect-steps-2-3-unescaped-consequence-6',
            claim: 'Cites a step the block does not cover.',
            severity: 'high',
            confidence: 0.8,
            evidence_refs: [
              { kind: 'span', uri: 'trace://run-5/span/step-5', excerpt: adapterAction(5) },
            ],
          }),
        ],
        analystId: 'model',
        store: adapterTraceStore('run-5', [2, 3, 5, 6]),
      }),
    ).rejects.toThrow(/cites step 5 outside its block 2-3/)
  })

  it('refuses more blocks than the per-case maximum', async () => {
    await expect(
      adaptPublicBenchmarkFindings({
        dataset: 'codetracebench',
        trajectoryId: 'run-6',
        findings: Array.from({ length: MAX_INCORRECT_BLOCKS + 1 }, (_, index) =>
          makeFinding({
            analyst_id: 'model-raw',
            area: 'model-output',
            subject: `incorrect-steps-${index + 1}-${index + 1}-unescaped-consequence-${index + 2}`,
            claim: 'Carpet bombing.',
            severity: 'high',
            confidence: 0.8,
            evidence_refs: [
              {
                kind: 'span',
                uri: `trace://run-6/span/step-${index + 1}`,
                excerpt: adapterAction(index + 1),
              },
            ],
          }),
        ),
        analystId: 'model',
        store: adapterTraceStore(
          'run-6',
          Array.from({ length: MAX_INCORRECT_BLOCKS + 2 }, (_, index) => index + 1),
        ),
      }),
    ).rejects.toThrow(
      `model reported ${MAX_INCORRECT_BLOCKS + 1} failure blocks; the maximum is ${MAX_INCORRECT_BLOCKS}`,
    )
  })

  it('refuses a block wider than the per-block maximum', async () => {
    const last = MAX_INCORRECT_BLOCK_STEPS + 1
    await expect(
      adaptPublicBenchmarkFindings({
        dataset: 'codetracebench',
        trajectoryId: 'run-7',
        findings: [
          makeFinding({
            analyst_id: 'model-raw',
            area: 'model-output',
            subject: `incorrect-steps-1-${last}-unescaped-consequence-${last + 1}`,
            claim: 'One block swallowing the trajectory.',
            severity: 'high',
            confidence: 0.8,
            evidence_refs: [
              { kind: 'span', uri: 'trace://run-7/span/step-1', excerpt: adapterAction(1) },
            ],
          }),
        ],
        analystId: 'model',
        store: adapterTraceStore(
          'run-7',
          Array.from({ length: last + 1 }, (_, index) => index + 1),
        ),
      }),
    ).rejects.toThrow(
      `failure block spans ${last} steps; the maximum is ${MAX_INCORRECT_BLOCK_STEPS}`,
    )
  })

  it('maps the explicit CodeTraceBench clean sentinel to no findings', async () => {
    const { findings } = await adaptPublicBenchmarkFindings({
      dataset: 'codetracebench',
      trajectoryId: 'clean-run',
      findings: [
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
      analystId: 'model',
      store: adapterTraceStore('clean-run', [1]),
    })

    expect(findings).toEqual([])
  })

  it('uses the maintained AgentRx prediction adapter for taxonomy and root step', async () => {
    const { findings } = await adaptPublicBenchmarkFindings({
      dataset: 'agentrx',
      trajectoryId: 'rx-1',
      findings: [
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
      analystId: 'model',
      store: adapterTraceStore('rx-1', [3]),
    })

    expect(findings[0]).toMatchObject({
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
      'A passing final verification never makes a block escaped',
    )
    expect(CODE_TRACE_BENCH_ANALYST_PROMPT).not.toContain('only unescaped')
    expect(CODE_TRACE_BENCH_ANALYST_PROMPT).toContain(
      'CodeTraceBench scores unuseful steps separately',
    )
    expect(CODE_TRACE_BENCH_ANALYST_PROMPT).toContain(
      'Use the final-verification outcome as evidence about the final state',
    )
    expect(CODE_TRACE_BENCH_ANALYST_PROMPT).toContain('Never select an EVALUATOR, TOOL, CHAIN')
    expect(CODE_TRACE_BENCH_ANALYST_PROMPT).toContain(
      'Every step in a reported block MUST be the positive integer n from an existing assistant LLM span',
    )
    expect(CODE_TRACE_BENCH_ANALYST_PROMPT).toContain('return an empty findings array')
  })

  it('binds both runner contracts to the same protocol digest', () => {
    expect(publicBenchmarkSystemPrompt('codetracebench')).toContain(CODE_TRACE_BENCH_ANALYST_PROMPT)
    expect(publicBenchmarkRlmInstructions('codetracebench')).toContain(
      CODE_TRACE_BENCH_ANALYST_PROMPT,
    )
    expect(publicBenchmarkRlmInstructions('codetracebench')).toContain(
      'incorrect-steps-<first_step>-<last_step>-<escape_status>-consequence-<consequence_step>',
    )
    expect(publicBenchmarkSystemPrompt('codetracebench')).toContain('"consequence_step"')
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

function adapterAction(step: number | string): string {
  return `runCommand("attempt ${step}")`
}

function adapterTraceStore(traceId: string, steps: readonly number[]): TraceAnalysisStore {
  const spans = steps.map((step) => ({
    trace_id: traceId,
    span_id: `step-${step}`,
    parent_span_id: 'root',
    name: 'message.assistant',
    kind: 'LLM',
    start_time: '2026-01-01T00:00:00.000Z',
    end_time: '2026-01-01T00:00:01.000Z',
    duration_ms: 1_000,
    status: 'OK',
    service_name: null,
    agent_name: 'assistant',
    model_name: null,
    tool_name: null,
    attributes: { content: adapterAction(step) },
  }))
  return {
    async viewSpans(input: { span_ids: readonly string[] }) {
      const requested = new Set(input.span_ids)
      const found = spans.filter((span) => requested.has(span.span_id))
      const foundIds = new Set(found.map((span) => span.span_id))
      return {
        trace_id: traceId,
        spans: found,
        missing_span_ids: input.span_ids.filter((id) => !foundIds.has(id)),
        omitted_span_ids: [],
        has_more: false,
        truncated_attribute_count: 0,
      }
    },
  } as unknown as TraceAnalysisStore
}
