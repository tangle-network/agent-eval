import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ValidationError } from '../errors'
import {
  findProductBenchmarkArtifacts,
  type ProductBenchmarkManifest,
  type ProductBenchmarkRecord,
  productBenchmarkIntegrityFailures,
  readProductBenchmarkManifest,
  readProductBenchmarkRecords,
  validateProductBenchmarkManifest,
  validateProductBenchmarkRecord,
  validateProductBenchmarkRun,
} from './index'

function fixtureManifest(): ProductBenchmarkManifest {
  return {
    schemaVersion: 1,
    projectId: 'tax-agent',
    benchmarkId: 'tax-calc-bench',
    repo: {
      url: 'https://github.com/tangle-network/tax-agent.git',
      commit: 'abc123',
      branch: 'research/product-policy-r176',
    },
    substrate: {
      agentEval: '^0.100.0',
      agentRuntime: '^0.79.0',
      agentInterface: '^0.10.0',
      sandbox: '^0.9.0',
      agentBench: '^0.5.0',
    },
    profiles: [
      {
        id: 'tax-agent@1',
        profileHash: 'sha256:profile',
        agentProfilePath: 'src/agent-profile.ts',
      },
    ],
    arms: [
      {
        id: 'baseline',
        profileId: 'tax-agent@1',
        mutableSurfaces: ['prompt', 'resources.files'],
        policyAxes: {
          carrier: 'profile',
          model: 'opencode/kimi-for-coding/k2p7',
          backend: 'cli-bridge',
        },
      },
    ],
    scenarios: [
      {
        id: 'scenario-1',
        split: 'dev',
        tags: ['tax'],
        sourceAllowedForSynthesis: false,
      },
    ],
    budgets: {
      maxUsd: 0.02,
      maxCells: 1,
      maxWallMs: 30000,
    },
    expectedArtifactDir: 'artifacts',
  }
}

function fixtureRecord(overrides: Partial<ProductBenchmarkRecord> = {}): ProductBenchmarkRecord {
  const record: ProductBenchmarkRecord = {
    schemaVersion: 1,
    projectId: 'tax-agent',
    benchmarkId: 'tax-calc-bench',
    runId: 'run-1',
    scenarioId: 'scenario-1',
    split: 'dev',
    armId: 'baseline',
    rep: 1,
    agentProfile: {
      id: 'tax-agent@1',
      hash: 'sha256:profile',
      path: 'src/agent-profile.ts',
      declared: {
        model: 'opencode/kimi-for-coding/k2p7',
        harness: 'tax-calc-bench',
        backend: 'cli-bridge',
        reasoningEffort: 'none',
      },
      resolved: {
        model: 'opencode/kimi-for-coding/k2p7',
        harness: 'tax-calc-bench',
        backend: 'cli-bridge',
        reasoningEffort: 'none',
      },
    },
    model: {
      provider: 'cli-bridge',
      id: 'opencode/kimi-for-coding/k2p7',
    },
    backend: {
      kind: 'cli-bridge',
      version: '^0.9.5',
    },
    outcome: {
      pass: true,
      score: 0.88,
      dimensions: {
        exact: 1,
      },
      failureMode: null,
    },
    usage: {
      inputTokens: 100,
      outputTokens: 20,
      costUsd: 0.002,
      wallMs: 1200,
      toolCalls: 1,
    },
    integrity: {
      realBackend: true,
      rawCapture: true,
      traceCapture: true,
      noStubRows: true,
      priced: true,
      profileMaterialized: true,
    },
    artifacts: {
      records: 'records.jsonl',
      traces: 'traces.jsonl',
      raws: 'raws.jsonl',
      scores: 'scores.json',
      workspace: 'workspace',
    },
  }
  return { ...record, ...overrides }
}

function fixtureDir(): string {
  return mkdtempSync(join(tmpdir(), 'agent-eval-product-benchmark-'))
}

function writeBundle(
  dir: string,
  manifest: ProductBenchmarkManifest,
  records: readonly ProductBenchmarkRecord[],
): void {
  writeFileSync(
    join(dir, 'product-benchmark-manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  )
  writeFileSync(
    join(dir, 'product-benchmark-records.jsonl'),
    `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
  )
}

function writeArtifacts(dir: string, record: ProductBenchmarkRecord): void {
  writeFileSync(join(dir, record.artifacts.records), `${JSON.stringify(record)}\n`)
  writeFileSync(join(dir, record.artifacts.traces), `${JSON.stringify({ span: 'llm' })}\n`)
  writeFileSync(join(dir, record.artifacts.raws), `${JSON.stringify({ raw: true })}\n`)
  writeFileSync(join(dir, record.artifacts.scores), `${JSON.stringify(record.outcome)}\n`)
  mkdirSync(join(dir, record.artifacts.workspace), { recursive: true })
}

describe('product benchmark contract', () => {
  it('validates the manifest and AgentProfile runtime receipt', () => {
    const manifest = validateProductBenchmarkManifest(fixtureManifest())
    const record = validateProductBenchmarkRecord(fixtureRecord())

    expect(manifest.arms).toHaveLength(1)
    expect(record.agentProfile.declared).toEqual(record.agentProfile.resolved)
  })

  it('rejects rows claiming a real backend without token usage', () => {
    const badRecord = fixtureRecord({
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        wallMs: 1,
        toolCalls: 0,
      },
    })

    expect(() => validateProductBenchmarkRecord(badRecord)).toThrow(ValidationError)
    expect(() => validateProductBenchmarkRecord(badRecord)).toThrow(
      /realBackend rows must carry non-zero token usage/,
    )
  })

  it('reports integrity failures and missing artifacts without hiding the row', () => {
    const dir = fixtureDir()
    const record = fixtureRecord({
      integrity: {
        ...fixtureRecord().integrity,
        priced: false,
      },
    })
    writeBundle(dir, fixtureManifest(), [record])

    const report = validateProductBenchmarkRun({
      manifestPath: join(dir, 'product-benchmark-manifest.json'),
      recordsPath: join(dir, 'product-benchmark-records.jsonl'),
      artifactRoot: dir,
    })

    expect(report.records).toBe(1)
    expect(report.integrityFailures).toEqual(['run-1:priced=false'])
    expect(report.missingArtifacts).toEqual([
      'run-1:records:records.jsonl',
      'run-1:traces:traces.jsonl',
      'run-1:raws:raws.jsonl',
      'run-1:scores:scores.json',
      'run-1:workspace:workspace',
    ])
  })

  it('finds and reads a product benchmark bundle from disk', () => {
    const dir = fixtureDir()
    const manifest = fixtureManifest()
    const record = fixtureRecord()
    writeBundle(dir, manifest, [record])
    writeArtifacts(dir, record)

    expect(findProductBenchmarkArtifacts(dir)).toEqual({
      manifestPath: join(dir, 'product-benchmark-manifest.json'),
      recordsPath: join(dir, 'product-benchmark-records.jsonl'),
    })
    expect(readProductBenchmarkManifest(join(dir, 'product-benchmark-manifest.json'))).toEqual(
      manifest,
    )
    expect(readProductBenchmarkRecords(join(dir, 'product-benchmark-records.jsonl'))).toEqual([
      record,
    ])
    expect(productBenchmarkIntegrityFailures(record)).toEqual([])

    expect(
      validateProductBenchmarkRun({
        manifestPath: join(dir, 'product-benchmark-manifest.json'),
        recordsPath: join(dir, 'product-benchmark-records.jsonl'),
        artifactRoot: dir,
      }),
    ).toMatchObject({
      records: 1,
      projects: ['tax-agent'],
      benchmarks: ['tax-calc-bench'],
      arms: ['baseline'],
      scenarios: ['scenario-1'],
      passed: 1,
      failed: 0,
      inputTokens: 100,
      outputTokens: 20,
      costUsd: 0.002,
      wallMs: 1200,
      integrityFailures: [],
      missingArtifacts: [],
    })
  })
})
