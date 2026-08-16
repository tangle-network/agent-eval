import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { withCellSpend } from '../../matrix'
import { runMultishotMatrix } from '../matrix'
import { runMultishot } from '../multishot'
import type { MultishotResult } from '../types'
import { compareJson } from './compare'
import type { MultishotGoldenEngine } from './engine'
import {
  assertMultishotGoldenScenario,
  checkMultishotGoldenScenario,
  checkMultishotMatrixGoldenScenario,
  MultishotGoldenMismatchError,
} from './harness'
import { multishotMatrixGoldenScenarios } from './matrix-scenarios'
import { goldenRecords } from './records'
import { multishotGoldenScenarios } from './scenarios'
import type { MultishotGoldenRecord, MultishotRecordedMessage } from './types'

const records = goldenRecords()

describe('multishot golden record set', () => {
  it('holds one record per catalog scenario, with no duplicates', () => {
    const scenarioIds = multishotGoldenScenarios().map((s) => s.id)
    const recordIds = records.scenarios.map((r) => r.id)
    expect(recordIds).toEqual(scenarioIds)
    expect(new Set(recordIds).size).toBe(recordIds.length)

    const matrixIds = multishotMatrixGoldenScenarios().map((s) => s.id)
    expect(records.matrixScenarios.map((r) => r.id)).toEqual(matrixIds)
  })

  it('names the engine and the package version it was captured from', () => {
    expect(records.version).toBe('v1')
    expect(records.recordedFrom).toContain('#')
    expect(records.recordedFromPackageVersion).toMatch(/^\d+\.\d+\.\d+/)
  })

  it('covers both outcome kinds and every observable field', () => {
    const outcomes = records.scenarios.map((r) => r.outcome.kind)
    expect(outcomes).toContain('result')
    expect(outcomes).toContain('error')

    const results = records.scenarios.flatMap((r) =>
      r.outcome.kind === 'result' ? [r.outcome.result] : [],
    )
    expect(results.some((r) => r.transcript.some((m) => m.role === 'tool'))).toBe(true)
    expect(
      results.some((r) => r.transcript.some((m) => m.role === 'assistant' && m.toolCalls)),
    ).toBe(true)
    expect(results.some((r) => r.artifacts.length >= 2)).toBe(true)
    expect(results.some((r) => r.costProvenance?.kind === 'uncaptured')).toBe(true)
    expect(results.some((r) => r.costProvenance?.kind === 'estimated')).toBe(true)

    const errors = records.scenarios.flatMap((r) =>
      r.outcome.kind === 'error' ? [r.outcome.error] : [],
    )
    expect(errors.map((e) => e.name)).toContain('MultishotFatalToolError')
    expect(errors.map((e) => e.name)).toContain('MultishotDriverEmptyError')
    expect(errors.some((e) => /tool dispatch cap exceeded/.test(e.message))).toBe(true)
    expect(errors.every((e) => e.cellSpend !== null)).toBe(true)

    // Both legs are exercised, and at least one scenario rotates models.
    const legs = new Set(records.scenarios.flatMap((r) => r.requests.map((q) => q.leg)))
    expect([...legs].sort()).toEqual(['agent', 'driver'])
    const rotation = records.scenarios.find((r) => r.id === 'delegation-driver-rotation')
    const driverModels = new Set(
      rotation?.requests.filter((q) => q.leg === 'driver').map((q) => q.model),
    )
    expect(driverModels.size).toBeGreaterThan(1)
  })
})

describe('the reference loop reproduces the golden records', () => {
  for (const scenario of multishotGoldenScenarios()) {
    it(`${scenario.id}: ${scenario.description}`, async () => {
      await assertMultishotGoldenScenario({ engine: runMultishot, scenario })
    })
  }

  describe('matrix', () => {
    let runDir: string
    beforeEach(() => {
      runDir = mkdtempSync(join(tmpdir(), 'multishot-golden-test-'))
    })
    afterEach(() => {
      rmSync(runDir, { recursive: true, force: true })
    })

    for (const scenario of multishotMatrixGoldenScenarios()) {
      it(`${scenario.id}: ${scenario.description}`, async () => {
        const report = await checkMultishotMatrixGoldenScenario({
          engine: runMultishotMatrix,
          scenario,
          runDir,
        })
        expect(report.mismatches).toEqual([])
      })
    }
  })
})

// ---------------------------------------------------------------------------
// The records only earn their place if a change to any recorded field FAILS the
// check. Two proofs: a replay engine that reproduces a record exactly must
// pass, and every single-field perturbation of it must be named as a mismatch.
// ---------------------------------------------------------------------------

function toWireMessage(message: MultishotRecordedMessage): Record<string, unknown> {
  const row: Record<string, unknown> = { role: message.role, content: message.content }
  if (message.toolCallId !== undefined) row.tool_call_id = message.toolCallId
  if (message.toolCalls !== undefined) {
    row.tool_calls = message.toolCalls.map((call) => ({
      id: call.id,
      type: 'function',
      function: { name: call.name, arguments: call.arguments },
    }))
  }
  return row
}

function materializeError(name: string, message: string, costUsd: number, kind: string): unknown {
  const err = new Error(message)
  err.name = name
  return withCellSpend(err, {
    costUsd,
    durationMs: 0,
    kind: kind as 'observed' | 'estimated' | 'uncaptured',
  })
}

/** An engine that re-issues a record's requests through the scenario's own
 *  transports and then reproduces its outcome. It is the smallest thing that
 *  passes the check, so a perturbation of it isolates exactly one field. */
function replayEngine(record: MultishotGoldenRecord): MultishotGoldenEngine {
  return async (opts) => {
    for (const request of record.requests) {
      const transport = request.leg === 'agent' ? opts.agentTransport : opts.driverTransport
      if (!transport) throw new Error(`replay engine: scenario has no ${request.leg} transport`)
      await transport({
        model: request.model,
        messages: request.messages.map(toWireMessage),
        ...(request.tools === null ? {} : { tools: request.tools }),
        ...(request.temperature === null ? {} : { temperature: request.temperature }),
        ...(request.maxTokens === null ? {} : { maxTokens: request.maxTokens }),
      })
    }
    if (record.outcome.kind === 'error') {
      const { name, message, cellSpend } = record.outcome.error
      throw materializeError(name, message, cellSpend?.costUsd ?? 0, cellSpend?.kind ?? 'estimated')
    }
    return { ...record.outcome.result, durationMs: 1 } as MultishotResult
  }
}

type Leaf = { path: Array<string | number>; value: unknown }

function leaves(value: unknown, path: Array<string | number> = []): Leaf[] {
  if (Array.isArray(value)) return value.flatMap((entry, i) => leaves(entry, [...path, i]))
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, entry]) =>
      leaves(entry, [...path, key]),
    )
  }
  return [{ path, value }]
}

function perturbed(value: unknown): unknown {
  if (typeof value === 'string') return `${value}~perturbed`
  if (typeof value === 'number') return value + 1
  if (typeof value === 'boolean') return !value
  return '~perturbed'
}

function withLeafChanged(root: unknown, path: Array<string | number>): unknown {
  const last = path.at(-1)
  if (last === undefined) throw new Error('withLeafChanged: empty path')
  const clone = structuredClone(root)
  let cursor = clone as Record<string | number, unknown>
  for (const key of path.slice(0, -1)) {
    cursor = cursor[key] as Record<string | number, unknown>
  }
  cursor[last] = perturbed(cursor[last])
  return clone
}

/** Fails loud instead of handing a possibly-absent entry to a test body. */
function first<T>(items: readonly T[], label: string): T {
  const value = items[0]
  if (value === undefined) throw new Error(`${label}: nothing to read`)
  return value
}

/** Reports every leaf of `subject` that a mutation leaves undetected. */
function uncomparedLeaves(subject: unknown): string[] {
  const missed: string[] = []
  for (const leaf of leaves(subject)) {
    const mutated = withLeafChanged(subject, leaf.path)
    if (compareJson(subject, mutated, '').length === 0) missed.push(leaf.path.join('.'))
  }
  return missed
}

describe('the golden records are load-bearing', () => {
  for (const scenario of multishotGoldenScenarios()) {
    const record = records.scenarios.find((r) => r.id === scenario.id)
    if (!record) throw new Error(`no record for ${scenario.id}`)

    it(`${scenario.id}: an exact replay passes`, async () => {
      const report = await checkMultishotGoldenScenario({
        engine: replayEngine(record),
        scenario,
      })
      expect(report.mismatches).toEqual([])
    })

    it(`${scenario.id}: every recorded field is compared`, () => {
      expect(uncomparedLeaves({ outcome: record.outcome, requests: record.requests })).toEqual([])
    })
  }

  it('reports a perturbed engine result as a named mismatch', async () => {
    const scenario = first(multishotGoldenScenarios(), 'scenarios')
    const record = first(records.scenarios, 'records')
    const engine: MultishotGoldenEngine = async (opts) => {
      const result = await replayEngine(record)(opts)
      return { ...result, toolCalls: result.toolCalls + 1 }
    }
    const report = await checkMultishotGoldenScenario({ engine, scenario })
    expect(report.ok).toBe(false)
    expect(report.mismatches).toEqual(['outcome.result.toolCalls: expected 3, received 4'])
  })

  it('reports a perturbed request ledger as a named mismatch', async () => {
    const scenario = first(multishotGoldenScenarios(), 'scenarios')
    const engine: MultishotGoldenEngine = async (opts) =>
      runMultishot({ ...opts, agentMaxTokens: 4321 })
    const report = await checkMultishotGoldenScenario({ engine, scenario })
    expect(report.ok).toBe(false)
    expect(report.mismatches.some((line) => /requests\[0\]\.maxTokens/.test(line))).toBe(true)
  })

  it('throws MultishotGoldenMismatchError naming the scenario and the version', async () => {
    const scenario = first(multishotGoldenScenarios(), 'scenarios')
    const engine: MultishotGoldenEngine = async () => {
      throw new Error('engine exploded')
    }
    await expect(assertMultishotGoldenScenario({ engine, scenario })).rejects.toThrow(
      MultishotGoldenMismatchError,
    )
    await expect(assertMultishotGoldenScenario({ engine, scenario })).rejects.toThrow(
      /multishot golden v1 — scenario "delegation-three-turns" diverged/,
    )
  })

  it('compares every recorded field of the matrix record', () => {
    const record = first(records.matrixScenarios, 'matrix records')
    expect(
      uncomparedLeaves({
        matrix: record.matrix,
        requests: record.requests,
        judgeRequests: record.judgeRequests,
        files: record.files,
      }),
    ).toEqual([])
  })

  it('fails a matrix engine that writes nothing', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'multishot-golden-empty-'))
    try {
      const report = await checkMultishotMatrixGoldenScenario({
        engine: async () => ({
          matrix: {
            cells: [],
            byAxis: {},
            summary: {
              totalCells: 0,
              runsExecuted: 0,
              cellsSkipped: 0,
              overallPassRate: 0,
              overallMeanScore: 0,
              totalCostUsd: 0,
              costUncapturedCells: 0,
              ceilingChargedUsd: 0,
              durationMs: 0,
            },
            matrixId: 'empty',
          },
        }),
        scenario: first(multishotMatrixGoldenScenarios(), 'matrix scenarios'),
        runDir,
      })
      expect(report.ok).toBe(false)
      expect(report.mismatches.length).toBeGreaterThan(0)
    } finally {
      rmSync(runDir, { recursive: true, force: true })
    }
  })

  it('refuses a second matrix judge wire in the same process', () => {
    const scenario = first(multishotMatrixGoldenScenarios(), 'matrix scenarios')
    const held = scenario.build('/unused/golden-wire-a')
    const restore = held.installJudgeWire()
    try {
      expect(() => scenario.build('/unused/golden-wire-b').installJudgeWire()).toThrow(
        /run matrix checks serially within one process/,
      )
    } finally {
      restore()
    }
    // Released again after the first check finishes.
    scenario.build('/unused/golden-wire-c').installJudgeWire()()
  })

  it('refuses a scenario the record set does not hold', async () => {
    await expect(
      checkMultishotGoldenScenario({
        engine: runMultishot,
        scenario: {
          id: 'not-recorded',
          description: 'x',
          build: first(multishotGoldenScenarios(), 'scenarios').build,
        },
      }),
    ).rejects.toThrow(/holds no record for scenario "not-recorded"/)
  })
})
