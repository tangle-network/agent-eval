/**
 * The boundaries the repair grader runs across.
 *
 * The grader decides what is admissible, what is executed, and what counts.
 * It never owns a container runtime, a model provider, or a test suite. Every
 * one of those arrives as an injected port, so the same funnel runs against
 * docker, a sandbox platform, or a fake built for a test.
 *
 * Three ports, one job each:
 *
 *   RepairSessionFactory   a fresh environment at the trajectory's own image
 *   TestOracle             the held-out suite, injected from outside the box
 *   RepairContinuationRunner   the pinned policy that runs the scaffold forward
 */

import type { RecordedTrajectoryStep } from '../trajectory-replay/steps'

/**
 * Which arm a session serves. The arm names the container state under test,
 * never a different policy: `Delta-repair` only measures the intervention when
 * every arm is continued the same way.
 */
export type RepairArm =
  | 'reproduce'
  | 'local-flip'
  | 'intervention'
  | 'no-fix-control'
  | 'no-op-control'
  | 'end-state'

export interface RepairExecResult {
  exitCode: number
  stdout: string
  stderr: string
  /** True when the environment killed the command at its wall-clock limit. */
  timedOut: boolean
}

export interface RepairSession {
  /** Container id or equivalent handle, recorded for provenance. */
  readonly ref: string
  exec(command: string, timeoutMs: number): Promise<RepairExecResult>
  close(): Promise<void>
}

export interface RepairSessionRequest {
  rowId: string
  /** Image the trajectory was recorded against. Never a locally rebuilt one:
   *  unpinned apt and pip installs drift a rebuild away from the recording. */
  image: string
  arm: RepairArm
  /** 0-based index within the arm. Every rollout gets its own environment. */
  rolloutIndex: number
}

export interface RepairSessionFactory {
  /** One fresh environment per call; the grader closes it. */
  open(request: RepairSessionRequest): Promise<RepairSession>
}

export interface TestOracleContext {
  rowId: string
  arm: RepairArm
  rolloutIndex: number
}

export interface TestOracleOutcome {
  /** True only when the suite command exited 0. Never defaulted. */
  passed: boolean
  exitCode: number
  output: string
  /** Digest of the suite as read back from inside the container after upload. */
  suiteDigest: string
  timedOut: boolean
}

/**
 * The held-out suite.
 *
 * A conforming oracle uploads the suite from outside the session at grade
 * time and verifies what it reads back, so a trajectory that plants its own
 * passing suite is overwritten rather than believed. `injectedTestOracle`
 * implements that; see `test-oracle.ts`.
 */
export interface TestOracle {
  grade(session: RepairSession, context: TestOracleContext): Promise<TestOracleOutcome>
}

export interface RepairContinuationRequest {
  rowId: string
  arm: RepairArm
  rolloutIndex: number
  /** Environment already restored to the state this arm continues from. */
  session: RepairSession
  /** Recorded steps the continuation must treat as already taken. */
  steps: readonly RecordedTrajectoryStep[]
  /** 1-based step the injected action replaced; null for a control that
   *  continues from the recorded end state. */
  k: number | null
  /**
   * The action that ran in place of step k and the raw result it produced.
   * Null for the no-fix control, which injects nothing. The runner renders it
   * into the scaffold's own observation grammar, so the grader never emits a
   * second copy of that format.
   */
  injected: InjectedAction | null
  taskStatement: string
}

export interface InjectedAction {
  action: string
  returncode: number
  output: string
  timedOut: boolean
}

export interface RepairContinuationOutcome {
  /** Frozen configuration the rollout ran under. */
  policyId: string
  /** Hash over the policy and its scaffold templates. Equal across arms by
   *  construction; the grader rejects a row whose arms disagree. */
  policyDigest: string
  /** Model calls the rollout made. */
  steps: number
  /** Why the rollout stopped, in the continuation layer's own vocabulary. */
  exitStatus: string
  submitted: boolean
}

/** Runs the pinned continuation policy forward from a prepared session. */
export type RepairContinuationRunner = (
  request: RepairContinuationRequest,
) => Promise<RepairContinuationOutcome>
