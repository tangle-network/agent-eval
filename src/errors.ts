/**
 * Error taxonomy for `@tangle-network/agent-eval`.
 *
 * Every error this package throws as part of its *public contract* extends
 * `AgentEvalError`. Consumers can pattern-match by `instanceof <Subclass>` or
 * by the stable string `code` carried on the base class.
 *
 * The codes are stable across minor versions; new codes can be added, but
 * existing codes never change meaning. New subclasses are non-breaking.
 *
 * Internal invariant guards (`throw new Error('this should never happen')`)
 * remain plain `Error`s on purpose — they're programmer-mistake assertions,
 * not consumer-catchable contract failures.
 */

export type AgentEvalErrorCode =
  | 'validation'
  | 'not_found'
  | 'config'
  | 'capture_integrity'
  | 'judge'
  | 'verification'
  | 'replay'
  | 'backend_integrity'
  | 'profile_matrix'

/**
 * Base class for every contract error this package throws — carries the stable
 * string `code` taxonomy so consumers can `instanceof`-match or switch on `code`.
 */
export class AgentEvalError extends Error {
  /** Stable string code. Survives minification; safe to switch on. */
  readonly code: AgentEvalErrorCode

  constructor(code: AgentEvalErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = this.constructor.name
    this.code = code
  }
}

/** Caller passed invalid arguments (out of range, mutually-exclusive options, bad shape). */
export class ValidationError extends AgentEvalError {
  constructor(message: string, options?: { cause?: unknown }) {
    super('validation', message, options)
  }
}

/** A named resource (run, span, rubric, scenario, dataset row, route) does not exist. */
export class NotFoundError extends AgentEvalError {
  constructor(message: string, options?: { cause?: unknown }) {
    super('not_found', message, options)
  }
}

/** Configuration missing or malformed (`HOME` unset, required image not supplied, env var absent). */
export class ConfigError extends AgentEvalError {
  constructor(message: string, options?: { cause?: unknown }) {
    super('config', message, options)
  }
}

/**
 * A run is missing the artifacts a launch-grade check requires:
 * raw HTTP capture absent, no LLM spans, route assertion failed, run-end
 * assertion tripped. Block ship on this; do not catch and move on.
 */
export class CaptureIntegrityError extends AgentEvalError {
  constructor(message: string, options?: { cause?: unknown }) {
    super('capture_integrity', message, options)
  }
}

/** A judge call failed in a way that's not retryable: schema parse failure, bad rubric, conflicting dimensions. */
export class JudgeError extends AgentEvalError {
  constructor(message: string, options?: { cause?: unknown }) {
    super('judge', message, options)
  }
}

/** A verifier signalled a hard failure (compile, test, schema) — distinct from a low judge score. */
export class VerificationError extends AgentEvalError {
  constructor(message: string, options?: { cause?: unknown }) {
    super('verification', message, options)
  }
}

/** Replay cache cannot satisfy a request: miss with no fallback, sink lacks list(), unsupported URL. */
export class ReplayError extends AgentEvalError {
  constructor(message: string, options?: { cause?: unknown }) {
    super('replay', message, options)
  }
}
