/**
 * Verification-strategy family — the shared vocabulary for "what certified
 * this result", covering tasks with an answer key and tasks without one.
 *
 * Charter Wave 5 (docs/charter.md): an unsolved problem has no held-out
 * suite by definition, so the held-out suite must be ONE member of a
 * strategy family, not the family itself. This module carries the taxonomy
 * and the port shape only. A checker is an injected executable boundary
 * that returns a typed outcome, so a consumer binds its own kernel (a Lean
 * toolchain, a metamorphic harness, a replication runner) and this package
 * never chooses one. Instruments, never methods.
 *
 * Full family doc, per-member failure modes in prose, and the BCWW pilot
 * worked example: docs/verification-strategies.md.
 *
 * Leaf module: no imports from this package. `src/verdict.ts` and
 * `src/rl/verifiable-reward.ts` both build on these types.
 */

/**
 * One member of the verification-strategy family.
 *
 * Every member has a documented failure mode — the specific way it can
 * certify a wrong result. A consumer that reads a certification must weigh
 * the member's failure mode, not treat "certified" as one bit.
 *
 * - `'compile'` — typecheck / build / lint passed. Deterministic.
 *   Failure mode: code that compiles is not code that is correct; the
 *   weakest deterministic member.
 * - `'test'` — unit / integration / held-out suite pass-rate. Deterministic.
 *   Failure mode: assumes an answer key exists; certifies nothing outside
 *   the suite's coverage, and a stubbed integration reports green.
 * - `'schema'` — structured output validates. Deterministic.
 *   Failure mode: shape is not meaning; a well-formed wrong answer passes.
 * - `'sandbox'` — sandbox execution exit code. Deterministic.
 *   Failure mode: an exit code compresses the whole run to one bit; a
 *   faked success exits 0.
 * - `'judge'` — LLM judge score. Probabilistic.
 *   Failure mode: drifts across model versions and is Goodhart-gameable by
 *   the graded policy.
 * - `'composite'` — weighted blend across members. Determinism inherited
 *   from its members.
 *   Failure mode: scalar collapse — the blend hides which member carried
 *   the score and which failed.
 * - `'proof-kernel'` — a proof assistant's kernel accepted a formal proof.
 *   Deterministic.
 *   Failure mode: the formalization gap. The kernel certifies the formal
 *   statement, never that the formal statement matches the informal claim;
 *   a proved theorem about the wrong statement is a wrong result with a
 *   valid certificate. Discharge it with the blind statement-equivalence
 *   protocol (`src/equivalence-check.ts`).
 * - `'invariant'` — invariant / metamorphic properties held on the result.
 *   Deterministic.
 *   Failure mode: weak invariants pass everything. An invariant set earns
 *   weight only through seeded-bug calibration — a mutation the set
 *   provably rejects; an uncalibrated set is a rubber stamp.
 * - `'replication'` — an independent re-execution reproduced the result
 *   from pinned inputs. Deterministic given the pins.
 *   Failure mode: replication re-runs the method, so it catches
 *   nondeterminism and environment drift, never a methodological error the
 *   method itself carries.
 * - `'agreement'` — independently-derived results agree. Probabilistic.
 *   Failure mode: the shared blind spot. Derivers that share training
 *   corpora, priors, or the same misread of the source agree for the same
 *   wrong reason; the blindness provenance of each arm is what the
 *   certificate rests on.
 */
export type VerificationStrategySource =
  | 'compile'
  | 'test'
  | 'schema'
  | 'sandbox'
  | 'judge'
  | 'composite'
  | 'proof-kernel'
  | 'invariant'
  | 'replication'
  | 'agreement'

/**
 * What a strategy member can honestly claim about its outcomes.
 *
 * `determinism: 'inherited'` exists only for `'composite'`: a blend takes
 * the class of its members. The reward axis stays binary
 * (`VerifiableReward.determinism`); this registry describes the family,
 * it never scores a run.
 */
export interface VerificationStrategyProfile {
  /** Determinism class a well-formed checker of this member can claim. */
  determinism: 'deterministic' | 'probabilistic' | 'inherited'
  /** The documented way this member certifies a wrong result. */
  failureMode: string
}

/**
 * The family registry. `Record` over the union keeps it exhaustive: adding
 * a member to `VerificationStrategySource` without a profile here fails to
 * compile. The failure mode travels with the taxonomy so a reader of a
 * certification can surface it without this package's docs at hand.
 */
export const VERIFICATION_STRATEGIES: Record<
  VerificationStrategySource,
  VerificationStrategyProfile
> = {
  compile: {
    determinism: 'deterministic',
    failureMode: 'code that compiles is not code that is correct',
  },
  test: {
    determinism: 'deterministic',
    failureMode:
      'assumes an answer key; certifies nothing outside suite coverage, and a stubbed integration reports green',
  },
  schema: {
    determinism: 'deterministic',
    failureMode: 'shape is not meaning; a well-formed wrong answer passes',
  },
  sandbox: {
    determinism: 'deterministic',
    failureMode: 'an exit code compresses the run to one bit; a faked success exits 0',
  },
  judge: {
    determinism: 'probabilistic',
    failureMode: 'drifts across model versions and is Goodhart-gameable by the graded policy',
  },
  composite: {
    determinism: 'inherited',
    failureMode: 'scalar collapse: the blend hides which member carried the score',
  },
  'proof-kernel': {
    determinism: 'deterministic',
    failureMode:
      'the formalization gap: the kernel certifies the formal statement, never that it matches the informal claim',
  },
  invariant: {
    determinism: 'deterministic',
    failureMode:
      'weak invariants pass everything; a set uncalibrated by seeded bugs is a rubber stamp',
  },
  replication: {
    determinism: 'deterministic',
    failureMode:
      're-runs the method, so it catches drift and nondeterminism, never an error the method itself carries',
  },
  agreement: {
    determinism: 'probabilistic',
    failureMode:
      'the shared blind spot: derivers with common corpora or priors agree for the same wrong reason',
  },
}

/** Every family member, derived from the registry so it cannot drift. */
export const VERIFICATION_STRATEGY_SOURCES = Object.keys(
  VERIFICATION_STRATEGIES,
) as readonly VerificationStrategySource[]

/**
 * Exact identity of the thing that checked. "lean4 4.33.0 with Mathlib
 * db584cd6d46c" and "lean4, some version" are different certificates: the
 * first is re-runnable, the second is a story.
 */
export interface CheckerIdentity {
  /** Toolchain or model name, e.g. `'lean4'` or a judge model id. */
  name: string
  /** Exact version or snapshot, e.g. `'4.33.0'` or a model snapshot id. */
  version: string
  /**
   * Content pins the version alone does not capture, e.g.
   * `{ mathlib: 'db584cd6d46c' }`. Keyed by dependency name.
   */
  pins?: Record<string, string>
}

/**
 * Typed outcome of an external checker call. Callers MUST inspect
 * `succeeded` before touching `value`; a failed check keeps its full error
 * text instead of collapsing to null.
 */
export type CheckerOutcome<Result> =
  | { succeeded: true; value: Result }
  | { succeeded: false; error: string }

/**
 * The port shape every strategy binds through: an injected executable
 * boundary. This package defines the port and refuses to ship any
 * implementation behind it — the consumer binds its own kernel, invariant
 * harness, replication runner, or judge, and the binding carries its own
 * identity and determinism claim.
 *
 * A checker that ran but could not decide returns
 * `{ succeeded: false, error }` with the reason; `succeeded: true` is
 * reserved for a discharged check.
 */
export interface StrategyChecker<Input, Result> {
  /** Which family member this checker discharges obligations for. */
  strategy: VerificationStrategySource
  identity: CheckerIdentity
  /** Determinism class this checker claims for its outcomes. */
  determinism: 'deterministic' | 'probabilistic'
  check(input: Input): Promise<CheckerOutcome<Result>>
}
