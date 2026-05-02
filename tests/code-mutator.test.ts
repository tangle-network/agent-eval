/**
 * createSandboxCodeMutator — verifies the boilerplate the primitive
 * absorbs: pool checkout/release, telemetry write-through, lineage,
 * failure capture, child id generation.
 */

import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSandboxCodeMutator } from '../src/code-mutator'
import { createSandboxPool } from '../src/sandbox-pool'
import {
  CostLedger,
  LineageRecorder,
  MutationTelemetry,
} from '../src/evolution-telemetry'
import { resetLockedAppendersForTesting } from '../src/locked-jsonl-appender'
import type { EvolvableVariant, VariantAggregate } from '../src/prompt-evolution'

interface DummyResource {
  id: string
}

interface DummyPayload {
  text: string
  diff?: string
}

function fixtureDir(): string {
  return mkdtempSync(join(tmpdir(), 'code-mutator-test-'))
}

function makeParent(): EvolvableVariant<DummyPayload> {
  return {
    id: 'seed',
    payload: { text: 'baseline' },
    generation: 0,
    label: 'seed',
  }
}

function makeAggregate(): VariantAggregate {
  return {
    variantId: 'seed',
    meanScore: 0.5,
    meanCost: 0,
    meanDurationMs: 0,
    okRate: 0.5,
    scenarios: [],
    metrics: {},
  }
}

describe('createSandboxCodeMutator', () => {
  it('produces children from successful runner outcomes', async () => {
    resetLockedAppendersForTesting()
    const pool = createSandboxPool<DummyResource>({
      size: 1,
      factory: {
        async create(id) { return { id } },
        async destroy() {},
      },
    })

    const mutator = createSandboxCodeMutator<DummyResource, DummyPayload>({
      pool,
      runner: async ({ slot, childCount }) => {
        return Array.from({ length: childCount }, (_, i) => ({
          ok: true,
          description: `change ${i} on ${slot.id}`,
          artifact: { branch: `mut/${slot.id}/${i}`, diffText: `--- ${i} ---` },
          latencyMs: 10,
          diffBytes: 100 + i,
          filesTouched: 1,
        }))
      },
      toVariantPayload: (outcome, parent) => ({
        text: parent.payload.text,
        diff: (outcome.artifact as { diffText: string }).diffText,
      }),
    })

    const variants = await mutator.mutate({
      parent: makeParent(),
      parentAggregate: makeAggregate(),
      topTrials: [],
      bottomTrials: [],
      childCount: 2,
      generation: 1,
    })

    expect(variants).toHaveLength(2)
    expect(variants[0].generation).toBe(1)
    expect(variants[0].parentId).toBe('seed')
    expect(variants[0].id).toBe('seed.g1.code.0')
    expect(variants[1].id).toBe('seed.g1.code.1')
    expect(variants[0].payload.diff).toBe('--- 0 ---')
    expect(variants[0].label).toContain('change 0')

    await pool.drain()
  })

  it('drops failed outcomes from variants but records them in telemetry', async () => {
    resetLockedAppendersForTesting()
    const dir = fixtureDir()
    try {
      const pool = createSandboxPool<DummyResource>({
        size: 1,
        factory: {
          async create(id) { return { id } },
          async destroy() {},
        },
      })

      const mutationTelemetry = new MutationTelemetry(join(dir, 'mutations.jsonl'))
      const mutator = createSandboxCodeMutator<DummyResource, DummyPayload>({
        pool,
        runner: async () => [
          { ok: true, description: 'good', latencyMs: 5, artifact: {} },
          { ok: false, failureReason: 'no_changes', latencyMs: 3 },
          { ok: true, description: 'also good', latencyMs: 8, artifact: {} },
        ],
        toVariantPayload: () => ({ text: 'mutated' }),
        mutationTelemetry,
      })

      const variants = await mutator.mutate({
        parent: makeParent(),
        parentAggregate: makeAggregate(),
        topTrials: [],
        bottomTrials: [],
        childCount: 3,
        generation: 1,
      })

      expect(variants).toHaveLength(2)

      // Wait for fire-and-forget telemetry writes to land.
      await new Promise((r) => setTimeout(r, 30))
      const lines = readFileSync(join(dir, 'mutations.jsonl'), 'utf-8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l))
      expect(lines).toHaveLength(3)
      expect(lines.filter((l) => l.ok)).toHaveLength(2)
      expect(lines.find((l) => !l.ok)?.failureReason).toBe('no_changes')

      await pool.drain()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('captures runner exceptions as failure attempts (no silent drops)', async () => {
    resetLockedAppendersForTesting()
    const dir = fixtureDir()
    try {
      const pool = createSandboxPool<DummyResource>({
        size: 1,
        factory: {
          async create(id) { return { id } },
          async destroy() {},
        },
      })

      const mutationTelemetry = new MutationTelemetry(join(dir, 'mutations.jsonl'))
      const mutator = createSandboxCodeMutator<DummyResource, DummyPayload>({
        pool,
        runner: async () => {
          throw new Error('agent crashed')
        },
        toVariantPayload: () => ({ text: 'mutated' }),
        mutationTelemetry,
      })

      const variants = await mutator.mutate({
        parent: makeParent(),
        parentAggregate: makeAggregate(),
        topTrials: [],
        bottomTrials: [],
        childCount: 1,
        generation: 1,
      })

      expect(variants).toHaveLength(0)

      await new Promise((r) => setTimeout(r, 30))
      const line = JSON.parse(readFileSync(join(dir, 'mutations.jsonl'), 'utf-8').trim())
      expect(line.ok).toBe(false)
      expect(line.failureReason).toBe('runner_error')
      expect(line.description).toContain('agent crashed')

      await pool.drain()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('writes to lineage + cost ledger when sinks are passed', async () => {
    resetLockedAppendersForTesting()
    const dir = fixtureDir()
    try {
      const pool = createSandboxPool<DummyResource>({
        size: 1,
        factory: {
          async create(id) { return { id } },
          async destroy() {},
        },
      })

      const lineage = new LineageRecorder<DummyPayload>(join(dir, 'lineage.jsonl'))
      const costLedger = new CostLedger(join(dir, 'cost.json'))

      const mutator = createSandboxCodeMutator<DummyResource, DummyPayload>({
        pool,
        runner: async () => [
          { ok: true, description: 'change', latencyMs: 10, costUsd: 0.05 },
        ],
        toVariantPayload: () => ({ text: 'mutated' }),
        lineage,
        costLedger,
      })

      const [variant] = await mutator.mutate({
        parent: makeParent(),
        parentAggregate: makeAggregate(),
        topTrials: [],
        bottomTrials: [],
        childCount: 1,
        generation: 2,
      })

      expect(variant).toBeDefined()
      const nodes = lineage.snapshot()
      expect(nodes.find((n) => n.id === variant.id)).toBeDefined()
      expect(nodes.find((n) => n.id === variant.id)?.kind).toBe('code')

      const ledger = costLedger.snapshot()
      expect(ledger.mutatorCodeUsd).toBeCloseTo(0.05)
      expect(ledger.byGeneration).toHaveLength(1)
      expect(ledger.byGeneration[0].generation).toBe(2)
      expect(ledger.byGeneration[0].mutatorCodeUsd).toBeCloseTo(0.05)
      expect(ledger.poolBusyMs).toBeGreaterThanOrEqual(0)

      await pool.drain()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('respects custom childIdFor and labelFor', async () => {
    resetLockedAppendersForTesting()
    const pool = createSandboxPool<DummyResource>({
      size: 1,
      factory: {
        async create(id) { return { id } },
        async destroy() {},
      },
    })

    const mutator = createSandboxCodeMutator<DummyResource, DummyPayload>({
      pool,
      runner: async () => [{ ok: true, latencyMs: 1, artifact: {} }],
      toVariantPayload: () => ({ text: 'x' }),
      childIdFor: (parent, gen, i) => `custom-${parent.id}-${gen}-${i}`,
      labelFor: () => 'static-label',
    })

    const [variant] = await mutator.mutate({
      parent: makeParent(),
      parentAggregate: makeAggregate(),
      topTrials: [],
      bottomTrials: [],
      childCount: 1,
      generation: 7,
    })

    expect(variant.id).toBe('custom-seed-7-0')
    expect(variant.label).toBe('static-label')

    await pool.drain()
  })
})
