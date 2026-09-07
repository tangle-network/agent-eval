/**
 * Invariants over the discovery-lab recursive smoke r1 directory (2026-09-06),
 * the run whose missing terminal record motivated Runtime's settle record.
 *
 * `runtime-run-r1-no-winner` holds byte-for-byte copies of the run's
 * `observer.jsonl` (14 records) and `spawn-journal.jsonl` (28 lines), plus
 * the two records Runtime now writes: `result.json`, the `no-winner`
 * `SupervisedResult` for that journal in Runtime's canonical byte form, and
 * `failure.json`, the first attempt's throw. The run really had both: the
 * first attempt threw on a caller input error at 05:58:29Z, and the corrected
 * attempt opened the journal at 06:14:44Z and settled `no-winner`.
 *
 * `runtime-run-r1-failed` is the same directory as it stood after that first
 * attempt: the observer's first two records and the failure record, and no
 * spawn journal yet.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { analyzeSupervisorRunSources } from './analyze'
import { analyzeSupervisorRun, findSupervisorRunDirs } from './loops-reader'
import { renderSupervisorRunHeadline } from './render'
import { supervisorRunRolloutLines } from './rollout-nodes'
import { isRuntimeSupervisorRunDir, readRuntimeSupervisorRun } from './runtime-reader'
import { isUnavailable } from './types'

const FIXTURES = join(process.cwd(), 'tests', 'fixtures', 'supervisor-run')
const NO_WINNER_DIR = join(FIXTURES, 'runtime-run-r1-no-winner')
const FAILED_DIR = join(FIXTURES, 'runtime-run-r1-failed')
const T0 = Date.parse('2026-09-06T07:00:00.000Z')
const ROOT = 'meta-operator-recursion-smoke-r1'
const FIRST_ATTEMPT_ERROR = 'supervise budget.deadlineMs must be a non-negative finite number'
const FIRST_ATTEMPT_AT = '2026-09-06T05:58:29.604Z'

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]),
    )
  }
  return value
}

describe('r1 settled no-winner: status comes from Runtime result.json kind', () => {
  it('reads the status, its source, and the reason from the settle record', async () => {
    const source = await readRuntimeSupervisorRun(NO_WINNER_DIR)
    const report = analyzeSupervisorRunSources(source, () => T0)

    expect(report.outcome.supStatus).toBe('no-winner')
    expect(report.outcome.supStatusSource).toBe('runtime-result')
    expect(report.outcome.supReason).toBe('all-children-down')
    expect(report.gaps.some((gap) => gap.startsWith('supStatus:'))).toBe(false)
    // The reader passes Runtime's records through as bytes and fabricates no
    // legacy status on the begin stamp.
    expect(JSON.parse(source.state as string)).toEqual({
      id: ROOT,
      startedAt: '2026-09-06T06:14:44.243Z',
    })
    expect(source.failure).not.toBeNull()
  })

  it('keeps the first attempt throw as an earlier-attempt failure, not the outcome', async () => {
    const report = await analyzeSupervisorRun(NO_WINNER_DIR)
    expect(report.outcome.failure).toEqual({
      source: 'runtime-failure',
      name: 'TypeError',
      message: FIRST_ATTEMPT_ERROR,
      at: FIRST_ATTEMPT_AT,
      earlierAttempt: true,
    })
    expect(renderSupervisorRunHeadline(report)).toContain(
      `status=no-winner source=runtime-result reason=all-children-down failure=TypeError: ${FIRST_ATTEMPT_ERROR} [runtime-failure at ${FIRST_ATTEMPT_AT}, earlier attempt]`,
    )
  })

  it('counts the four children the journal settled', async () => {
    const report = await analyzeSupervisorRun(NO_WINNER_DIR)
    expect(report.orchestration.workersSpawned).toBe(4)
    expect(report.orchestration.workersSettled).toBe(4)
    if (isUnavailable(report.economics.perWorker)) {
      throw new Error(report.economics.perWorker.unavailable)
    }
    expect(report.economics.perWorker.map((w) => [w.workerId, w.status])).toEqual([
      [`${ROOT}:s0`, 'done'],
      [`${ROOT}:s1`, 'done'],
      [`${ROOT}:s2`, 'done'],
      [`${ROOT}:s3`, 'down'],
    ])
    expect(report.economics.perWorker[3]?.failure).toBe(
      'auth bundle is not supported for profile harness cli-base',
    )
  })

  it('mints the root row from the same record', async () => {
    const source = await readRuntimeSupervisorRun(NO_WINNER_DIR)
    const tree = supervisorRunRolloutLines(source, { capturedAt: new Date(T0).toISOString() })
    const root = tree.nodes[0]
    expect(root?.outcome.metrics.sup_status).toBe('no-winner')
    expect(root?.outcome.is_completed).toBe(false)
    expect(root?.outcome.error).toBe('all-children-down')
  })

  it('holds the records in the byte forms Runtime writes', () => {
    const resultText = readFileSync(join(NO_WINNER_DIR, 'result.json'), 'utf8')
    const result = JSON.parse(resultText) as { kind: string; tree: { root: string } }
    // Runtime writes the settle record as RFC 8785 canonical JSON: sorted keys, no whitespace.
    expect(JSON.stringify(sortKeys(result))).toBe(resultText)
    expect(result.kind).toBe('no-winner')
    expect(result.tree.root).toBe(ROOT)

    const failureText = readFileSync(join(NO_WINNER_DIR, 'failure.json'), 'utf8')
    const failure = JSON.parse(failureText) as Record<string, unknown>
    expect(`${JSON.stringify(failure, null, 2)}\n`).toBe(failureText)
    expect(Object.keys(failure)).toEqual(['runId', 'pursuitId', 'at', 'error'])
  })
})

describe('r1 after its first attempt: failure.json without a result is a terminal failure', () => {
  it('is recognized as a Runtime run directory without a spawn journal', async () => {
    expect(await isRuntimeSupervisorRunDir(FAILED_DIR)).toBe(true)
    expect(await findSupervisorRunDirs(FIXTURES)).toEqual(
      expect.arrayContaining([FAILED_DIR, NO_WINNER_DIR]),
    )
  })

  it('reports the recorded throw instead of an unavailable status', async () => {
    const report = await analyzeSupervisorRun(FAILED_DIR)
    // The failure record names the run, so the report does too.
    expect(report.instanceId).toBe(ROOT)
    expect(report.outcome.supStatus).toBe('failed')
    expect(report.outcome.supStatusSource).toBe('runtime-failure')
    expect(report.outcome.supReason).toBeNull()
    expect(report.outcome.failure).toEqual({
      source: 'runtime-failure',
      name: 'TypeError',
      message: FIRST_ATTEMPT_ERROR,
      at: FIRST_ATTEMPT_AT,
      earlierAttempt: false,
    })
    expect(report.gaps.some((gap) => gap.startsWith('supStatus:'))).toBe(false)
    // No journal was opened before the throw, so every journal metric is a
    // named absence, never a zero.
    expect(report.orchestration.workersSpawned).toEqual({
      unavailable: `no Runtime spawn journal (spawn-journal.jsonl) under ${FAILED_DIR}`,
    })
    expect(isUnavailable(report.economics.totalUsd)).toBe(true)
  })

  it('mints no root row and names the missing spawn', async () => {
    // A rollout row is keyed on the journal's root spawn id. The throw landed
    // before any spawn, so the minter reports the absence instead of inventing
    // an identity for a row; the throw itself is on the report above.
    const source = await readRuntimeSupervisorRun(FAILED_DIR)
    const tree = supervisorRunRolloutLines(source, { capturedAt: new Date(T0).toISOString() })
    expect(tree.nodes).toEqual([])
    expect(tree.gaps).toEqual([
      { code: 'journal-unavailable', message: 'no supervisor run dir; no nodes recoverable' },
    ])
  })
})

describe('the observer copies are unmodified prefixes of the real journal', () => {
  it.each([
    ['runtime-run-r1-no-winner', 14],
    ['runtime-run-r1-failed', 2],
  ])('%s chains %i records by digest', (dir, records) => {
    const lines = readFileSync(join(FIXTURES, dir, 'observer.jsonl'), 'utf8')
      .split('\n')
      .filter((line) => line.length > 0)
      .map(
        (line) => JSON.parse(line) as { sequence: number; digest: string; previousDigest?: string },
      )
    expect(lines).toHaveLength(records)
    lines.forEach((record, index) => {
      expect(record.sequence).toBe(index + 1)
      expect(record.previousDigest).toBe(index === 0 ? undefined : lines[index - 1]?.digest)
    })
  })

  it('the first-attempt copy ends on the recorded throw', () => {
    const lines = readFileSync(join(FAILED_DIR, 'observer.jsonl'), 'utf8')
      .split('\n')
      .filter((line) => line.length > 0)
    const last = JSON.parse(lines[lines.length - 1] as string) as {
      event: { phase: string; timestamp: number; payload: { error: string } }
    }
    expect(last.event.phase).toBe('error')
    expect(last.event.payload.error).toBe(FIRST_ATTEMPT_ERROR)
    expect(new Date(last.event.timestamp).toISOString()).toBe(FIRST_ATTEMPT_AT)
  })
})
