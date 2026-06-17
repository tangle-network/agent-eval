/**
 * Streaming detectors — the canonical, online failure-mode kernel.
 *
 * A `StreamingDetector` is a pure incremental reducer: fold one normalized step, get a signal the
 * moment a threshold trips (else null). The SAME kernel runs in two places, so the logic lives once:
 *   - ONLINE, over a live agent pipe (a worker's tool-call stream) → raise a finding mid-run.
 *   - INSIDE the control loop (`control-runtime`) → its `stopOn*` policies fold these detectors.
 *
 * Detectors are stateful but self-contained; `streak` is exposed for telemetry and `reset` clears it.
 * Fingerprinting is the CALLER's job — the control loop hashes state/action with `stableFingerprint`,
 * a tool-call pipe hashes args with `argHash` — so a detector stays agnostic to what it's watching.
 */

import type { FailureClass } from '../trace/schema'

export type DetectorSeverity = 'info' | 'warn' | 'critical'

/** A normalized step a detector folds over. Fields are optional; each detector reads only what it
 *  needs (repeated-action → `actionFingerprint`; no-progress → `stateFingerprint` + `score`;
 *  error-streak → `status`). */
export interface DetectorEvent {
  /** Fingerprint of the action/tool-call this step took (caller pre-hashes). */
  readonly actionFingerprint?: string
  /** Fingerprint of observable state AFTER this step. */
  readonly stateFingerprint?: string
  /** Score after this step (the score-flat half of no-progress). */
  readonly score?: number
  /** Whether this step errored. */
  readonly status?: 'ok' | 'error'
  /** Free-form label carried into the signal evidence (e.g. the tool name). */
  readonly label?: string
}

export interface DetectorSignal {
  readonly detector: string
  readonly severity: DetectorSeverity
  readonly failureClass?: FailureClass
  readonly reason: string
  /** Consecutive matching steps at the moment the signal fired. */
  readonly streak: number
  readonly evidence?: Record<string, unknown>
}

export interface StreamingDetector {
  readonly id: string
  /** Current streak (consecutive matching steps) — for telemetry/introspection between observes. */
  readonly streak: number
  /** Fold one event; return a signal when the threshold trips, else null. */
  observe(event: DetectorEvent): DetectorSignal | null
  /** Clear all state. */
  reset(): void
}

export interface RepeatedActionOptions {
  /** Signal once the same action fingerprint repeats this many CONSECUTIVE steps (default 3).
   *  `<= 0` disables the signal (the streak is still tracked, for telemetry). */
  readonly maxRepeated?: number
  readonly severity?: DetectorSeverity
  /** Failure class to stamp on the signal (default `tool_recovery_failure`). */
  readonly failureClass?: FailureClass
}

/** Same action fingerprint N consecutive steps = a stuck loop (the #1 long-horizon failure mode). */
export function repeatedActionDetector(opts: RepeatedActionOptions = {}): StreamingDetector {
  const max = opts.maxRepeated ?? 3
  const severity = opts.severity ?? 'warn'
  const failureClass: FailureClass = opts.failureClass ?? 'tool_recovery_failure'
  let last: string | undefined
  let streak = 0
  return {
    id: 'repeated-action',
    get streak() {
      return streak
    },
    observe(event) {
      const fp = event.actionFingerprint
      if (fp === undefined) return null
      streak = fp === last ? streak + 1 : 1
      last = fp
      if (max <= 0 || streak < max) return null
      return {
        detector: 'repeated-action',
        severity,
        failureClass,
        reason: `stuck: repeated same action for ${streak} step(s)`,
        streak,
        ...(event.label ? { evidence: { action: event.label } } : {}),
      }
    },
    reset() {
      last = undefined
      streak = 0
    },
  }
}

export interface NoProgressOptions {
  /** Signal once state is unchanged AND score is flat for this many CONSECUTIVE steps (default 3).
   *  `<= 0` disables the signal. */
  readonly maxNoProgress?: number
  /** Minimum |score change| that counts as progress (default 0.001). */
  readonly minScoreDelta?: number
  readonly severity?: DetectorSeverity
  readonly failureClass?: FailureClass
}

/** State + score unchanged across N steps = spinning wheels. Compares each step to the previous one,
 *  so prime with the initial state (observe it once before the first real step) to detect on step 1. */
export function noProgressDetector(opts: NoProgressOptions = {}): StreamingDetector {
  const max = opts.maxNoProgress ?? 3
  const minScoreDelta = opts.minScoreDelta ?? 0.001
  const severity = opts.severity ?? 'warn'
  const failureClass: FailureClass = opts.failureClass ?? 'tool_recovery_failure'
  let lastState: string | undefined
  let lastScore: number | undefined
  let streak = 0
  return {
    id: 'no-progress',
    get streak() {
      return streak
    },
    observe(event) {
      const stateUnchanged = lastState !== undefined && lastState === event.stateFingerprint
      const scoreFlat = Math.abs((event.score ?? 0) - (lastScore ?? 0)) < minScoreDelta
      streak = stateUnchanged && scoreFlat ? streak + 1 : 0
      lastState = event.stateFingerprint
      lastScore = event.score
      if (max <= 0 || streak < max) return null
      return {
        detector: 'no-progress',
        severity,
        failureClass,
        reason: `stuck: no state/score progress for ${streak} step(s)`,
        streak,
        ...(event.label ? { evidence: { state: event.label } } : {}),
      }
    },
    reset() {
      lastState = undefined
      lastScore = undefined
      streak = 0
    },
  }
}

export interface ErrorStreakOptions {
  /** Signal once this many CONSECUTIVE steps errored (default 3). `<= 0` disables. */
  readonly maxErrors?: number
  readonly severity?: DetectorSeverity
  readonly failureClass?: FailureClass
}

/** N consecutive tool errors = the worker is hammering a broken approach. */
export function errorStreakDetector(opts: ErrorStreakOptions = {}): StreamingDetector {
  const max = opts.maxErrors ?? 3
  const severity = opts.severity ?? 'warn'
  const failureClass: FailureClass = opts.failureClass ?? 'tool_recovery_failure'
  let streak = 0
  return {
    id: 'error-streak',
    get streak() {
      return streak
    },
    observe(event) {
      if (event.status === undefined) return null
      streak = event.status === 'error' ? streak + 1 : 0
      if (max <= 0 || streak < max) return null
      return {
        detector: 'error-streak',
        severity,
        failureClass,
        reason: `stuck: ${streak} consecutive errored step(s)`,
        streak,
        ...(event.label ? { evidence: { lastError: event.label } } : {}),
      }
    },
    reset() {
      streak = 0
    },
  }
}

/** Fold one event through many detectors at once; returns every signal that fired this step. The
 *  natural shape for an online pipe watching with a whole panel of detectors. */
export function observeAll(
  detectors: ReadonlyArray<StreamingDetector>,
  event: DetectorEvent,
): DetectorSignal[] {
  const signals: DetectorSignal[] = []
  for (const d of detectors) {
    const s = d.observe(event)
    if (s) signals.push(s)
  }
  return signals
}
