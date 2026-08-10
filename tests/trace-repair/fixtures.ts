/**
 * Injected fakes for the repair grader.
 *
 * The fake box models a filesystem and the exact command shapes the grader
 * emits, so a test that asserts "the planted suite was overwritten" is
 * asserting about files rather than about a stub that was told to say no. No
 * test in this directory calls a model or opens a container.
 */

import { expect } from 'vitest'
import {
  type AdmissionEvidence,
  admitRow,
  type AdmittedRow,
} from '../../src/trace-repair/admission-contract'
import { type ControlPolicy, defineControlPolicy } from '../../src/trace-repair/control-policy'
import {
  type OracleDeterminismVerdict,
  type OracleLoad,
  type OracleStateLabel,
  oracleDeterminism,
} from '../../src/trace-repair/oracle-determinism'
import type { RepairRowResult } from '../../src/trace-repair/grade'
import { testSuiteDigest } from '../../src/trace-repair/test-oracle'
import type { RecordedTrajectoryStep } from '../../src/trajectory-replay/steps'
import type {
  RepairArm,
  RepairContinuationOutcome,
  RepairContinuationRequest,
  RepairContinuationRunner,
  RepairExecResult,
  RepairSession,
  RepairSessionFactory,
  RepairSessionRequest,
} from '../../src/trace-repair/ports'

export const CWD = '/app'
export const SUITE_PATH = '/tests/run-tests.sh'
export const SUITE_COMMAND = 'bash /tests/run-tests.sh'

/** A control that can act, which is what admission screening requires. */
export const CONTROL_POLICY: ControlPolicy = defineControlPolicy({
  id: 'test-control-v1',
  stepBudget: 20,
  scaffold: 'mini-swe-agent',
  model: 'pinned/model-id',
  commandTimeoutSeconds: 30,
})

/** A control pinned to zero model calls: it grades the bytes it was handed. */
export const INERT_CONTROL_POLICY: ControlPolicy = defineControlPolicy({
  id: 'zero-step-control-v1',
  stepBudget: 0,
  scaffold: 'mini-swe-agent',
  model: null,
  commandTimeoutSeconds: 30,
})

export const POLICY_DIGEST = CONTROL_POLICY.digest

/** Replicates that all agreed, on both states and both loads. */
export function stableOracle(taskName = 'test-task'): OracleDeterminismVerdict {
  return oracleDeterminism({
    taskName,
    image: 'registry.example/task@sha256:pinned',
    suiteDigest: SUITE_DIGEST,
    measuredAt: '2026-08-10T00:00:00.000Z',
    groups: (['idle', 'contended'] as OracleLoad[]).flatMap((load) =>
      (['unsolved', 'solved'] as OracleStateLabel[]).map((state) => ({
        state,
        load,
        replicates: Array.from({ length: 3 }, (_, index) => ({
          index,
          reward: state === 'solved' ? '1' : '0',
          passed: state === 'solved',
          wallMs: 100,
          assertions: [{ id: 'suite.py::test_it', passed: state === 'solved' }],
        })),
      })),
    ),
  })
}

/**
 * Replicates whose whole-suite reward never moved while one assertion did —
 * the shape a suite with a wall-clock assertion produces at a state that sits
 * far from its threshold.
 */
export function flakyOracle(taskName = 'flaky-task'): OracleDeterminismVerdict {
  return oracleDeterminism({
    taskName,
    image: 'registry.example/task@sha256:pinned',
    suiteDigest: SUITE_DIGEST,
    measuredAt: '2026-08-10T00:00:00.000Z',
    groups: [
      {
        state: 'unsolved',
        load: 'idle',
        replicates: Array.from({ length: 3 }, (_, index) => ({
          index,
          reward: '0',
          passed: false,
          wallMs: 100,
          assertions: [
            { id: 'suite.py::test_correct', passed: true },
            { id: 'suite.py::test_speedup[6]', passed: index === 0 },
          ],
        })),
      },
    ],
  })
}

/** Held-out suite: passes only when the repair marker exists. */
export const HELD_OUT_SUITE = JSON.stringify({ passIf: { exists: '/app/fixed' } })
/** What a trajectory plants when it grades itself. */
export const PLANTED_SUITE = JSON.stringify({ passIf: 'always' })

export interface ActionSpec {
  readonly exit?: number
  readonly stdout?: string
  readonly stderr?: string
  readonly timedOut?: boolean
  /** Paths the action writes, absolute. */
  readonly writes?: Record<string, string>
  readonly deletes?: readonly string[]
  /** Paths that must exist, or the action exits 1 without writing anything. */
  readonly requires?: readonly string[]
}

export interface FakeWorldOptions {
  readonly image?: Record<string, string>
  readonly actions: Record<string, ActionSpec>
  /** Writes under these prefixes are silently dropped, which models a box that
   *  refuses the oracle's upload. */
  readonly dropWritesUnder?: readonly string[]
  readonly cwd?: string
}

export class FakeBox {
  readonly files = new Map<string, string>()
  readonly commands: string[] = []

  constructor(
    readonly ref: string,
    private readonly world: FakeWorldOptions,
  ) {
    for (const [path, contents] of Object.entries(world.image ?? {})) {
      this.files.set(path, contents)
    }
  }

  private dropped(path: string): boolean {
    return (this.world.dropWritesUnder ?? []).some((prefix) => path.startsWith(prefix))
  }

  write(path: string, contents: string): void {
    if (this.dropped(path)) return
    this.files.set(path, contents)
  }

  removeTree(root: string): void {
    if (this.dropped(root)) return
    for (const path of [...this.files.keys()]) {
      if (path === root || path.startsWith(`${root}/`)) this.files.delete(path)
    }
  }

  exec(command: string): RepairExecResult {
    this.commands.push(command)

    const wrapped = /^cd '(.*)' && printf %s ([A-Za-z0-9+/=]+) \| base64 -d \| sh$/.exec(command)
    if (wrapped) {
      const action = Buffer.from(wrapped[2]!, 'base64').toString('utf8')
      return this.runAction(action)
    }

    const remove = /^rm -rf '(.*)'$/.exec(command)
    if (remove) {
      this.removeTree(remove[1]!)
      return ok()
    }

    if (/^mkdir -p '(.*)'$/.test(command)) return ok()

    const upload = /^printf %s '([A-Za-z0-9+/=]*)' \| base64 -d > '(.*)'$/.exec(command)
    if (upload) {
      this.write(upload[2]!, Buffer.from(upload[1]!, 'base64').toString('utf8'))
      return ok()
    }

    const chmod = /^chmod (\S+) '(.*)'$/.exec(command)
    if (chmod) {
      return this.files.has(chmod[2]!) ? ok() : fail(1, '', 'chmod: no such file')
    }

    const readBack = /^base64 < '(.*)' \| tr -d '\\n'$/.exec(command)
    if (readBack) {
      const contents = this.files.get(readBack[1]!)
      if (contents === undefined) return fail(1, '', 'base64: no such file')
      return ok(Buffer.from(contents, 'utf8').toString('base64'))
    }

    if (command === SUITE_COMMAND) return this.runSuite()

    return fail(127, '', `fake box: unmodelled command ${command}`)
  }

  /** Runs the suite file that is on disk right now, whoever put it there. */
  runSuite(): RepairExecResult {
    const contents = this.files.get(SUITE_PATH)
    if (contents === undefined) return fail(2, '', 'no suite on disk')
    const directive = JSON.parse(contents) as { passIf: 'always' | { exists: string } }
    if (directive.passIf === 'always') return ok('suite: pass')
    return this.files.has(directive.passIf.exists)
      ? ok('suite: pass')
      : fail(1, 'suite: fail', '')
  }

  private runAction(action: string): RepairExecResult {
    const spec = this.world.actions[action]
    if (!spec) return fail(127, '', `fake box: unscripted action ${JSON.stringify(action)}`)
    for (const required of spec.requires ?? []) {
      if (!this.files.has(required)) {
        return fail(1, '', `missing prerequisite ${required}`)
      }
    }
    for (const path of spec.deletes ?? []) this.removeTree(path)
    for (const [path, contents] of Object.entries(spec.writes ?? {})) this.write(path, contents)
    return {
      exitCode: spec.exit ?? 0,
      stdout: spec.stdout ?? '',
      stderr: spec.stderr ?? '',
      timedOut: spec.timedOut ?? false,
    }
  }
}

function ok(stdout = ''): RepairExecResult {
  return { exitCode: 0, stdout, stderr: '', timedOut: false }
}

function fail(exitCode: number, stdout: string, stderr: string): RepairExecResult {
  return { exitCode, stdout, stderr, timedOut: false }
}

export interface OpenedSession {
  readonly request: RepairSessionRequest
  readonly box: FakeBox
}

export class FakeSessionFactory implements RepairSessionFactory {
  readonly opened: OpenedSession[] = []
  private counter = 0

  constructor(private readonly world: FakeWorldOptions) {}

  async open(request: RepairSessionRequest): Promise<RepairSession> {
    const box = new FakeBox(`box-${(this.counter += 1)}`, this.world)
    this.opened.push({ request, box })
    return {
      ref: box.ref,
      async exec(command: string): Promise<RepairExecResult> {
        return box.exec(command)
      },
      async close(): Promise<void> {},
    }
  }

  armsOpened(): RepairArm[] {
    return this.opened.map((entry) => entry.request.arm)
  }
}

export interface FakeContinuationOptions {
  /** Actions the continuation runs, per rollout index. Defaults to none. */
  readonly actionsByRollout?: Record<number, readonly string[]>
  readonly policyDigest?: string
  readonly policyId?: string
}

export function fakeContinuation(
  options: FakeContinuationOptions = {},
): RepairContinuationRunner & { calls: RepairContinuationRequest[] } {
  const calls: RepairContinuationRequest[] = []
  const runner = async (
    request: RepairContinuationRequest,
  ): Promise<RepairContinuationOutcome> => {
    calls.push(request)
    const actions = options.actionsByRollout?.[request.rolloutIndex] ?? []
    for (const action of actions) {
      await request.session.exec(wrapForFake(action))
    }
    return {
      policyId: options.policyId ?? 'tb-repair-continuation-v1',
      policyDigest: options.policyDigest ?? POLICY_DIGEST,
      steps: actions.length,
      exitStatus: actions.length > 0 ? 'submitted' : 'step-budget-exhausted',
      submitted: actions.length > 0,
    }
  }
  return Object.assign(runner, { calls })
}

/** Wrap an action the way the grader wraps one, so the fake box decodes it. */
export function wrapForFake(action: string, cwd = CWD): string {
  const b64 = Buffer.from(action, 'utf8').toString('base64')
  return `cd '${cwd}' && printf %s ${b64} | base64 -d | sh`
}

export function step(
  stepId: number,
  action: string,
  observation: { returncode: number; output: string } | null,
): RecordedTrajectoryStep {
  return {
    step_id: stepId,
    action,
    observation:
      observation === null
        ? null
        : `<returncode>${observation.returncode}</returncode>\n<output>\n${observation.output}\n</output>`,
  }
}

export const SUITE_FILES = [{ path: SUITE_PATH, contents: HELD_OUT_SUITE, mode: '0755' }]
export const SUITE_DIGEST = testSuiteDigest(SUITE_FILES)

export function admissionEvidence(
  overrides: Partial<AdmissionEvidence> & { rowId?: string; steps: readonly RecordedTrajectoryStep[] },
): AdmissionEvidence {
  const steps = overrides.steps
  return {
    rowId: overrides.rowId ?? 'row-1',
    taskName: overrides.taskName ?? overrides.oracleDeterminism?.taskName ?? 'test-task',
    image: overrides.image ?? 'registry.example/task@sha256:pinned',
    cwd: overrides.cwd ?? CWD,
    taskStatement: overrides.taskStatement ?? 'make the suite pass',
    steps,
    oracleDeterminism: overrides.oracleDeterminism ?? stableOracle(),
    controlPolicy: overrides.controlPolicy ?? CONTROL_POLICY,
    prefixFidelity: overrides.prefixFidelity ?? { stepsReplayed: steps.length, divergences: 0 },
    endStatePassed: overrides.endStatePassed ?? false,
    suiteDigest: overrides.suiteDigest ?? SUITE_DIGEST,
    noFixControl: overrides.noFixControl ?? {
      rollouts: 3,
      passes: 0,
      policyDigest: overrides.controlPolicy?.digest ?? POLICY_DIGEST,
    },
    noOpControl: overrides.noOpControl ?? {
      rollouts: 3,
      passes: 0,
      policyDigest: overrides.controlPolicy?.digest ?? POLICY_DIGEST,
    },
  }
}

/** An admitted row, or a thrown error naming the check that refused it. */
export function admitted(
  overrides: Partial<AdmissionEvidence> & { steps: readonly RecordedTrajectoryStep[] },
): AdmittedRow {
  const outcome = admitRow(admissionEvidence(overrides))
  if (!outcome.admitted) {
    throw new Error(`fixture row was not admitted: ${outcome.rejection} — ${outcome.detail}`)
  }
  return outcome.row
}

/** A graded row whose intervention ran and passed `repairRate` of 3 rollouts. */
export function measuredRowResult(rowId: string, repairRate: number): RepairRowResult {
  return {
    rowId,
    grade: {
      outcome: 'measured',
      k: 2,
      reproduction: { basis: 'no-recorded-observation', reproduced: true },
      execution: {
        command: 'touch /app/fixed',
        exitCode: 0,
        timedOut: false,
        wallMs: 1,
        output: '',
        prefix: { stepsReplayed: 1, divergences: 0, wallMs: 1 },
      },
      localFlip: {
        passed: repairRate === 1,
        exitCode: repairRate === 1 ? 0 : 1,
        timedOut: false,
        suiteDigest: SUITE_DIGEST,
      },
      repair: {
        rollouts: 3,
        passes: repairRate * 3,
        interventionFailures: 0,
        policyDigest: POLICY_DIGEST,
        rolloutEvidence: [],
      },
    },
    credit: { executes: 1, localFlip: repairRate === 1 ? 1 : 0, repairRate },
    interventionRate: repairRate,
    controlRate: 0,
    controlRollouts: 3,
    controlScreening: 'enforced',
    controlPolicyDigest: POLICY_DIGEST,
    repairRollouts: 3,
    delta: repairRate,
    wallMs: 1,
  }
}

export function declinedRowResult(rowId: string): RepairRowResult {
  return {
    rowId,
    grade: { outcome: 'declined' },
    credit: { executes: 0, localFlip: 0, repairRate: 0 },
    interventionRate: 0,
    controlRate: 0,
    controlRollouts: 3,
    controlScreening: 'enforced',
    controlPolicyDigest: POLICY_DIGEST,
    repairRollouts: 0,
    delta: 0,
    wallMs: 1,
  }
}

export function rejectedRowResult(rowId: string): RepairRowResult {
  return {
    rowId,
    grade: {
      outcome: 'rejected',
      rejection: { source: 'target', reason: 'k-out-of-range', detail: 'k=99 is outside [1, 3]' },
    },
    credit: { executes: 0, localFlip: 0, repairRate: 0 },
    interventionRate: 0,
    controlRate: 0,
    controlRollouts: 3,
    controlScreening: 'enforced',
    controlPolicyDigest: POLICY_DIGEST,
    repairRollouts: 0,
    delta: 0,
    wallMs: 1,
  }
}

export function expectZeroCredit(credit: {
  executes: number
  localFlip: number
  repairRate: number
}): void {
  expect(credit).toEqual({ executes: 0, localFlip: 0, repairRate: 0 })
}
