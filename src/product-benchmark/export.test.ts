import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ValidationError } from '../errors'
import type { RunRecord } from '../run-record'
import {
  assertProductBenchmarkRun,
  exportProductBenchmark,
  exportProductBenchmarkRuns,
  findProductBenchmarkArtifacts,
  productBenchmarkMutableSurfaces,
  readProductBenchmarkManifest,
  readProductBenchmarkRecords,
  validateProductBenchmarkRun,
} from './index'

function fixtureRunRecord(overrides: Partial<RunRecord> = {}): RunRecord {
  const record: RunRecord = {
    runId: 'run-1',
    experimentId: 'exp-1',
    candidateId: 'production-profile',
    seed: 0,
    model: 'deepseek-v4-flash',
    promptHash: 'sha256:prompt',
    configHash: 'sha256:config',
    commitSha: 'abc123',
    wallMs: 1200,
    costUsd: 0.002,
    tokenUsage: { input: 100, output: 20 },
    outcome: { searchScore: 0.9, raw: { composite: 0.9 } },
    splitTag: 'dev',
    scenarioId: 'scenario-1',
    agentProfile: {
      schemaVersion: 'agent-profile-cell/v1',
      cellId: 'agent-profile-cell:sha256:deadbeef',
      profileId: 'production-profile',
      sourceProfile: { kind: 'agent-interface-profile', hash: 'sha256:source' },
      harness: { id: 'tax-agent-canonical-eval' },
      model: 'deepseek-v4-flash',
      dimensions: { backend: 'sandbox' },
    },
    ...overrides,
  }
  return record
}

function writeRunDir(records: readonly RunRecord[], traceName = 'traces.jsonl'): string {
  const runDir = mkdtempSync(join(tmpdir(), 'agent-eval-pb-run-'))
  writeFileSync(
    join(runDir, 'records.jsonl'),
    `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
  )
  if (traceName.endsWith('.jsonl')) {
    writeFileSync(join(runDir, traceName), `${JSON.stringify({ span: 'llm' })}\n`)
  } else {
    mkdirSync(join(runDir, traceName), { recursive: true })
    writeFileSync(join(runDir, traceName, 'span-1.json'), `${JSON.stringify({ span: 'llm' })}\n`)
  }
  writeFileSync(join(runDir, 'raws.jsonl'), `${JSON.stringify({ raw: true })}\n`)
  writeFileSync(join(runDir, 'scores.json'), `${JSON.stringify({ composite: 0.9 })}\n`)
  mkdirSync(join(runDir, 'workspace'), { recursive: true })
  return runDir
}

function outDirFixture(): string {
  return mkdtempSync(join(tmpdir(), 'agent-eval-pb-out-'))
}

const baseOptions = {
  projectId: 'tax-agent',
  benchmarkId: 'tax-canonical',
  agentProfilePath: 'apps/web/src/lib/.server/tax/agent-profile.ts',
  // agent-runtime and sandbox are not installed in this repo (layering:
  // agent-eval sits below both), so the fixtures inject real-looking versions
  // through the explicit override — the validator refuses 'unknown'.
  substrate: { agentRuntime: '0.79.4', sandbox: '0.9.5' },
} as const

describe('exportProductBenchmarkRuns', () => {
  it('round-trips a materialized bundle through the contract validators', () => {
    const runDir = writeRunDir([
      fixtureRunRecord(),
      fixtureRunRecord({
        runId: 'run-2',
        scenarioId: 'scenario-2',
        splitTag: 'holdout',
        outcome: { holdoutScore: 0.4, raw: { composite: 0.4 } },
      }),
    ])
    const outDir = outDirFixture()

    const result = exportProductBenchmarkRuns({ ...baseOptions, runDirs: [runDir], outDir })

    expect(result.records).toBe(2)
    expect(findProductBenchmarkArtifacts(outDir)).toEqual({
      manifestPath: result.manifestPath,
      recordsPath: result.recordsPath,
    })
    const manifest = readProductBenchmarkManifest(result.manifestPath)
    const records = readProductBenchmarkRecords(result.recordsPath)
    expect(manifest.projectId).toBe('tax-agent')
    expect(manifest.scenarios.map((scenario) => scenario.tags[0])).toEqual(['tax', 'tax'])
    expect(manifest.arms[0]?.mutableSurfaces).toEqual([...productBenchmarkMutableSurfaces])
    expect(records.map((record) => record.split)).toEqual(['dev', 'holdout'])
    // Materialized artifacts are bundle-relative and copied under source-runs/.
    expect(records[0]?.artifacts.records.startsWith('source-runs/')).toBe(true)

    const report = assertProductBenchmarkRun(outDir)
    expect(report.records).toBe(2)
    expect(report.integrityFailures).toEqual([])
    expect(report.missingArtifacts).toEqual([])
    expect(report.repoFailures).toEqual([])
    // The failed holdout row carries a synthesized failure mode, not a silent null.
    expect(records[1]?.outcome.pass).toBe(false)
    expect(records[1]?.outcome.failureMode).toMatch(/quality-below-threshold/)
  })

  it('covers the tax drift: dimensions.variant arm, raw.safety split, trace-store dir', () => {
    const runDir = writeRunDir(
      [
        fixtureRunRecord({
          candidateId: '',
          outcome: { searchScore: 0.8, raw: { composite: 0.8, safety: 1 } },
          agentProfile: {
            ...fixtureRunRecord().agentProfile!,
            dimensions: { backend: 'sandbox', variant: 'policy-resource-long' },
          },
        }),
      ],
      'trace-store',
    )
    const outDir = outDirFixture()

    const result = exportProductBenchmarkRuns({ ...baseOptions, runDirs: [runDir], outDir })
    const records = readProductBenchmarkRecords(result.recordsPath)
    const manifest = readProductBenchmarkManifest(result.manifestPath)

    expect(records[0]?.armId).toBe('policy-resource-long')
    expect(records[0]?.split).toBe('safety')
    expect(records[0]?.artifacts.traces.endsWith('trace-store')).toBe(true)
    expect(records[0]?.integrity.traceCapture).toBe(true)
    expect(manifest.arms[0]?.policyAxes.carrier).toBe('resource-file')
    expect(assertProductBenchmarkRun(outDir).records).toBe(1)
  })

  it('covers the legal drift: raw.pass verdicts, tool-call fallback, injected tool_calls dimension', () => {
    const runDir = writeRunDir([
      fixtureRunRecord({
        outcome: { searchScore: 0.9, raw: { composite: 0.9, pass: 0 } },
      }),
    ])
    const outDir = outDirFixture()

    const result = exportProductBenchmarkRuns({
      ...baseOptions,
      projectId: 'legal-agent',
      benchmarkId: 'legal-canonical',
      runDirs: [runDir],
      outDir,
      toolCallFallback: () => 3,
    })
    const records = readProductBenchmarkRecords(result.recordsPath)

    // raw.pass=0 beats the score threshold: failed, with the explicit reason.
    expect(records[0]?.outcome.pass).toBe(false)
    expect(records[0]?.outcome.failureMode).toBe('product-pass-failed')
    expect(records[0]?.usage.toolCalls).toBe(3)
    expect(records[0]?.outcome.dimensions.tool_calls).toBe(3)
    expect(readProductBenchmarkManifest(result.manifestPath).scenarios[0]?.tags[0]).toBe('legal')
  })

  it('covers the creative drift: absolute artifacts, split hook, variantId arm, reasoning effort, profile fallback', () => {
    const runDir = writeRunDir([
      fixtureRunRecord({
        candidateId: '',
        outcome: {
          searchScore: 0.9,
          raw: { composite: 0.9, generation_approval_signal: 0, tool_call_count: 2 },
        },
        agentProfile: {
          ...fixtureRunRecord().agentProfile!,
          profileId: undefined as unknown as string,
          dimensions: {
            backend: 'cli-bridge',
            variantId: 'policy-resource-small-creative-v1',
            reasoningLevel: 'high',
          },
        },
      }),
    ])
    const outDir = outDirFixture()

    const result = exportProductBenchmarkRuns({
      ...baseOptions,
      projectId: 'creative-agent',
      benchmarkId: 'creative-canonical',
      runDirs: [runDir],
      outDir,
      materializeSourceRuns: false,
      fallbackProfileId: 'creative-director',
      classifySplit: (record) =>
        record.outcome.raw.generation_approval_signal === 0 ? 'safety' : undefined,
    })
    const records = readProductBenchmarkRecords(result.recordsPath)
    const manifest = readProductBenchmarkManifest(result.manifestPath)

    expect(records[0]?.split).toBe('safety')
    expect(records[0]?.armId).toBe('policy-resource-small-creative-v1')
    expect(records[0]?.agentProfile.id).toBe(
      'creative-director:policy-resource-small-creative-v1:deepseek-v4-flash',
    )
    expect(records[0]?.agentProfile.resolved.reasoningEffort).toBe('high')
    expect(records[0]?.usage.toolCalls).toBe(2)
    expect(records[0]?.model.provider).toBe('cli-bridge')
    expect(isAbsolute(records[0]!.artifacts.records)).toBe(true)
    expect(manifest.arms[0]?.policyAxes.reasoningEffort).toBe('high')
    // Absolute artifacts still validate: paths point into the source run dir.
    expect(assertProductBenchmarkRun(outDir).missingArtifacts).toEqual([])
  })

  it('merges multiple run dirs into one bundle', () => {
    const runDirA = writeRunDir([fixtureRunRecord()])
    const runDirB = writeRunDir([
      fixtureRunRecord({
        runId: 'run-2',
        scenarioId: 'scenario-2',
        candidateId: 'baseline-generic',
      }),
    ])
    const outDir = outDirFixture()

    const result = exportProductBenchmarkRuns({
      ...baseOptions,
      runDirs: [runDirA, runDirB],
      outDir,
    })
    const manifest = readProductBenchmarkManifest(result.manifestPath)

    expect(result.records).toBe(2)
    expect(manifest.arms.map((arm) => arm.id).sort()).toEqual([
      'baseline-generic',
      'production-profile',
    ])
    expect(assertProductBenchmarkRun(outDir).records).toBe(2)
  })

  it('exposes the single-run wrapper', () => {
    const runDir = writeRunDir([fixtureRunRecord()])
    const outDir = outDirFixture()

    const result = exportProductBenchmark({ ...baseOptions, runDir, outDir })

    expect(result.records).toBe(1)
    expect(assertProductBenchmarkRun(outDir).records).toBe(1)
  })

  it('fails loud on empty inputs and nested out dirs', () => {
    const runDir = writeRunDir([fixtureRunRecord()])

    expect(() =>
      exportProductBenchmarkRuns({ ...baseOptions, runDirs: [], outDir: outDirFixture() }),
    ).toThrow(ValidationError)
    expect(() =>
      exportProductBenchmarkRuns({
        ...baseOptions,
        runDirs: [runDir],
        outDir: join(runDir, 'bundle'),
      }),
    ).toThrow(/must not be nested inside runDir/)
    expect(() =>
      exportProductBenchmarkRuns({
        ...baseOptions,
        runDirs: [mkdtempSync(join(tmpdir(), 'agent-eval-pb-empty-'))],
        outDir: outDirFixture(),
      }),
    ).toThrow(/missing .*records\.jsonl/)
  })

  it('reports unknown repo identity through validateProductBenchmarkRun', () => {
    const runDir = writeRunDir([fixtureRunRecord()])
    const outDir = outDirFixture()
    const result = exportProductBenchmarkRuns({ ...baseOptions, runDirs: [runDir], outDir })

    const manifest = JSON.parse(
      JSON.stringify(readProductBenchmarkManifest(result.manifestPath)),
    ) as { repo: { commit: string } }
    manifest.repo.commit = 'unknown'
    writeFileSync(result.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

    const report = validateProductBenchmarkRun({
      manifestPath: result.manifestPath,
      recordsPath: result.recordsPath,
      artifactRoot: outDir,
    })
    expect(report.repoFailures).toEqual(['manifest.repo.commit'])
    expect(() => assertProductBenchmarkRun(outDir)).toThrow(/manifest\.repo\.commit/)
  })

  it('reports unknown substrate versions and assertProductBenchmarkRun fails on them', () => {
    const runDir = writeRunDir([fixtureRunRecord()])
    const outDir = outDirFixture()
    const result = exportProductBenchmarkRuns({ ...baseOptions, runDirs: [runDir], outDir })

    const manifest = JSON.parse(
      JSON.stringify(readProductBenchmarkManifest(result.manifestPath)),
    ) as { substrate: { agentEval: string } }
    manifest.substrate.agentEval = 'unknown'
    writeFileSync(result.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

    const report = validateProductBenchmarkRun({
      manifestPath: result.manifestPath,
      recordsPath: result.recordsPath,
      artifactRoot: outDir,
    })
    expect(report.substrateFailures).toEqual(['manifest.substrate.agentEval'])
    expect(() => assertProductBenchmarkRun(outDir)).toThrow(/manifest\.substrate\.agentEval/)
  })

  it('fails loud when records sharing an arm id disagree on a policy axis', () => {
    const runDir = writeRunDir([
      fixtureRunRecord(),
      fixtureRunRecord({
        runId: 'run-2',
        scenarioId: 'scenario-2',
        model: 'glm-5.2',
        agentProfile: {
          schemaVersion: 'agent-profile-cell/v1',
          cellId: 'agent-profile-cell:sha256:beefdead',
          profileId: 'production-profile',
          sourceProfile: { kind: 'agent-interface-profile', hash: 'sha256:source' },
          harness: { id: 'tax-agent-canonical-eval' },
          model: 'glm-5.2',
          dimensions: { backend: 'sandbox' },
        },
      }),
    ])
    expect(() =>
      exportProductBenchmarkRuns({ ...baseOptions, runDirs: [runDir], outDir: outDirFixture() }),
    ).toThrow(/arm 'production-profile' disagree on profileId/)
  })

  it('fails loud when records sharing a scenario id disagree on split', () => {
    const runDir = writeRunDir([
      fixtureRunRecord(),
      fixtureRunRecord({ runId: 'run-2', splitTag: 'holdout' }),
    ])
    expect(() =>
      exportProductBenchmarkRuns({ ...baseOptions, runDirs: [runDir], outDir: outDirFixture() }),
    ).toThrow(/scenario 'scenario-1' disagree on split/)
  })
})
