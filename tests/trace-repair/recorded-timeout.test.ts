/**
 * A step the recording killed carries no returncode, so no replay can agree or
 * disagree with it. The grader bounds such a step separately: that must change
 * what the prefix costs and nothing about what it counts.
 */

import { describe, expect, it } from 'vitest'
import { gradeRepairRow } from '../../src/trace-repair/grade'
import {
  isRecordedTimeout,
  renderTimeoutObservation,
} from '../../src/trace-repair/mini-swe-scaffold'
import type {
  RepairContinuationOutcome,
  RepairSession,
  RepairSessionFactory,
  TestOracle,
} from '../../src/trace-repair/ports'
import type { RecordedTrajectoryStep } from '../../src/trajectory-replay/steps'
import { admitted, POLICY_DIGEST, SUITE_DIGEST, step } from './fixtures'

interface ExecCall {
  command: string
  timeoutMs: number
}

/** Records the bound every exec was given; the box itself does nothing. */
function recordingSessions(calls: ExecCall[]): RepairSessionFactory {
  return {
    async open(): Promise<RepairSession> {
      return {
        ref: 'recording',
        async exec(command: string, timeoutMs: number) {
          calls.push({ command, timeoutMs })
          return { exitCode: 0, stdout: '', stderr: '', timedOut: false }
        },
        async close() {},
      }
    },
  }
}

const passingOracle: TestOracle = {
  async grade() {
    return {
      passed: true,
      exitCode: 0,
      output: '',
      suiteDigest: SUITE_DIGEST,
      timedOut: false,
    }
  },
}

const continuation = async (): Promise<RepairContinuationOutcome> => ({
  policyId: 'zero-step',
  policyDigest: POLICY_DIGEST,
  steps: 0,
  exitStatus: 'step-budget-exhausted',
  submitted: false,
})

const TIMED_OUT_STEP: RecordedTrajectoryStep = {
  step_id: 1,
  action: 'sleep 999',
  observation: renderTimeoutObservation('sleep 999', ''),
}

const STEPS: readonly RecordedTrajectoryStep[] = [
  TIMED_OUT_STEP,
  step(2, 'echo two', { returncode: 0, output: 'two' }),
  step(3, 'echo three', { returncode: 0, output: 'three' }),
]

async function boundsFor(recordedTimeoutStepMs?: number): Promise<ExecCall[]> {
  const calls: ExecCall[] = []
  await gradeRepairRow({
    row: admitted({ steps: STEPS }),
    response: {
      kind: 'finding',
      k: 3,
      failureClaim: 'the run never produced the artifact',
      intervention: { kind: 'shell', action: 'echo repaired > /app/out.txt' },
    },
    sessions: recordingSessions(calls),
    oracle: passingOracle,
    continuation,
    repairRollouts: 1,
    stepTimeoutMs: 300_000,
    ...(recordedTimeoutStepMs === undefined ? {} : { recordedTimeoutStepMs }),
  })
  return calls
}

describe('isRecordedTimeout', () => {
  it('recognises the observation the scaffold writes for a killed command', () => {
    expect(isRecordedTimeout(renderTimeoutObservation('sleep 999', ''))).toBe(true)
  })

  it('is false for a step that recorded a returncode', () => {
    expect(isRecordedTimeout('<returncode>1</returncode>\n<output>\nboom\n</output>')).toBe(false)
  })

  it('is false when the step recorded no observation at all', () => {
    expect(isRecordedTimeout(null)).toBe(false)
  })
})

describe('recordedTimeoutStepMs', () => {
  it('bounds a recorded timeout separately and leaves every other step alone', async () => {
    const calls = await boundsFor(1_000)
    const timedOut = calls.filter((call) => call.command.includes(encode('sleep 999')))
    const normal = calls.filter((call) => call.command.includes(encode('echo two')))
    expect(timedOut.length).toBeGreaterThan(0)
    expect(normal.length).toBeGreaterThan(0)
    expect(new Set(timedOut.map((call) => call.timeoutMs))).toEqual(new Set([1_000]))
    expect(new Set(normal.map((call) => call.timeoutMs))).toEqual(new Set([300_000]))
  })

  it('falls back to the step timeout when no separate bound is given', async () => {
    const calls = await boundsFor()
    const timedOut = calls.filter((call) => call.command.includes(encode('sleep 999')))
    expect(timedOut.length).toBeGreaterThan(0)
    expect(new Set(timedOut.map((call) => call.timeoutMs))).toEqual(new Set([300_000]))
  })
})

/** The grader base64-encodes each action, so a test matches on the encoding. */
function encode(action: string): string {
  return Buffer.from(action, 'utf8').toString('base64')
}
