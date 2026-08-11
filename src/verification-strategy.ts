/**
 * Verification-strategy family — the shared vocabulary for "what certified
 * this result", covering tasks with an answer key and tasks without one.
 *
 * Charter Wave 5 (docs/charter.md): an unsolved problem has no held-out
 * suite by definition, so the held-out suite must be ONE member of a
 * strategy family, not the family itself. This module carries the taxonomy,
 * the port shape, and the one protocol built directly on that port: the
 * blind two-arm statement-equivalence check. A checker is an injected
 * executable boundary that returns a typed outcome, so a consumer binds its
 * own kernel (a Lean toolchain, a metamorphic harness, a replication
 * runner) and this package never chooses one. Instruments, never methods.
 *
 * Full family doc, per-member failure modes in prose, and the BCWW pilot
 * worked example: docs/verification-strategies.md. How every executed
 * verdict lands in `DefaultVerdict` with a certification: docs/verdicts.md.
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
 *   protocol (`runEquivalenceCheck` in this module).
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

// ── Blind statement-equivalence protocol ─────────────────────────────

/**
 * Statement-equivalence protocol — the blind two-arm design as a typed
 * primitive.
 *
 * The problem it closes is the proof-kernel failure mode (the
 * formalization gap): a kernel certifies a formal statement, never that
 * the formal statement matches the informal claim. The protocol makes the
 * gap measurable: two arms derive the formal statement independently and
 * blind to each other, then a checker discharges the obligation that the
 * two statements are equivalent. A statement mismatch is a successful
 * outcome — it is the formalization gap made visible with a separating
 * witness in hand.
 *
 * The protocol is pure contract + record types + the asymmetry refusals.
 * Execution binds through the same `StrategyChecker` port as every other
 * strategy: the consumer injects its own kernel. The pilot record this
 * shape reproduces was assembled by hand for the BCWW (4.6) inequality;
 * docs/verification-strategies.md carries the worked example with artifact
 * paths. `equivalenceVerdict` (src/verdict.ts) lands a finished record in
 * the shared verdict spine.
 *
 * The refusals are the design. An arm that saw the other arm's statement,
 * or the outcome it feeds, did not independently derive anything — the
 * check is invalid, and this module throws rather than record it.
 */

/**
 * The two-arm blind design. `arms: 2` and `blind: true` are literal types
 * on purpose: a wider design is a different protocol, not a parameter.
 */
export interface EquivalenceCheckSpec {
  /**
   * The strategy member whose obligation the check discharges — the pilot
   * used `'proof-kernel'`: the Lean kernel proved the two statements
   * equivalent. The bound checker must declare the same member.
   */
  source: VerificationStrategySource
  /**
   * Stable identity of the claim under verification: a path, digest, or
   * citation. Pilot: arXiv:1507.05650 inequality (4.6) plus the
   * five-atom counterexample record.
   */
  artifact: string
  /** Exactly two independent arms. An N-arm design is not this protocol. */
  arms: 2
  /**
   * Blind derivation is the point: a non-blind run is not a weaker check,
   * it is no check. `false` is unrepresentable here and refused at runtime
   * for untyped callers.
   */
  blind: true
}

/** A validated, frozen spec. Produced only by `defineEquivalenceCheck`. */
export interface EquivalenceCheckDefinition {
  readonly spec: Readonly<EquivalenceCheckSpec>
}

/** One arm's committed statement plus the provenance the record rests on. */
export interface EquivalenceArm {
  armId: string
  /** The committed formal statement text (pilot: the arm's `Statement.lean` source). */
  statement: string
  /**
   * What this arm derived the statement from. Pilot arm A: the paper's
   * LaTeX source; pilot arm B: the campaign's artifacts. The two arms
   * SHOULD derive from different renderings of the claim — that is what
   * makes agreement informative.
   */
  derivedFrom: string
  /**
   * The blindness declaration. Both flags must be `true`; a `false` value
   * is refused loudly, because recording a non-blind arm would launder an
   * invalid check into a valid-looking record.
   */
  blindness: {
    /** This arm never saw any other arm's statement before committing its own. */
    toOtherArms: boolean
    /** This arm never saw the verification outcome before committing. */
    toOutcome: boolean
  }
}

export type EquivalenceObligationStatus =
  | 'proved'
  | 'refuted-with-separating-witness'
  | 'unresolved'

/**
 * The discharged (or undischarged) equivalence obligation.
 *
 * Field presence is status-dependent and enforced by
 * `buildEquivalenceRecord`:
 * - `'proved'` requires `evidenceDigest` and forbids `separatingWitness`.
 * - `'refuted-with-separating-witness'` requires both the witness and
 *   `evidenceDigest`.
 * - `'unresolved'` requires `unresolvedReason` and forbids the witness —
 *   an undischarged obligation keeps its diagnostic instead of faking
 *   either verdict.
 */
export interface EquivalenceObligation {
  status: EquivalenceObligationStatus
  /** The input on which the two statements provably disagree. */
  separatingWitness?: string
  /** Why the obligation could not be discharged (checker error text, coverage limit). */
  unresolvedReason?: string
  /** The checker that ran (or failed to run) the obligation. */
  checker: CheckerIdentity
  /** Digest of the checker's evidence artifact (pilot: the kernel-checked `Check.lean` run). */
  evidenceDigest?: string
}

/** The record the protocol produces — the by-hand pilot record, typed. */
export interface EquivalenceRecord {
  spec: Readonly<EquivalenceCheckSpec>
  arms: readonly [EquivalenceArm, EquivalenceArm]
  obligation: EquivalenceObligation
}

/** Input the bound checker receives: the artifact identity and both committed statements. */
export interface EquivalenceCheckerInput {
  artifact: string
  statements: readonly [string, string]
}

/**
 * What a checker that RAN must return. `'unresolved'` is deliberately not
 * a checker result: a checker that could not decide returns
 * `{ succeeded: false, error }` through the port, and the protocol records
 * the unresolved obligation with that reason.
 */
export interface EquivalenceCheckerResult {
  status: 'proved' | 'refuted-with-separating-witness'
  /** Required when `status` is refuted. */
  separatingWitness?: string
  evidenceDigest: string
}

/** An equivalence checker is a `StrategyChecker` — same port as every strategy. */
export type EquivalenceChecker = StrategyChecker<EquivalenceCheckerInput, EquivalenceCheckerResult>

/** A refused equivalence check. `code` names the exact refusal for programmatic handling. */
export class EquivalenceProtocolError extends Error {
  readonly code:
    | 'arm-count'
    | 'not-blind'
    | 'arm-saw-other'
    | 'arm-saw-outcome'
    | 'duplicate-arm-id'
    | 'empty-field'
    | 'unknown-source'
    | 'witness-missing'
    | 'witness-on-proved'
    | 'witness-on-unresolved'
    | 'reason-missing'
    | 'evidence-missing'
    | 'checker-strategy-mismatch'

  constructor(code: EquivalenceProtocolError['code'], message: string) {
    super(message)
    this.name = 'EquivalenceProtocolError'
    this.code = code
  }
}

/**
 * Validate and freeze a two-arm blind equivalence check spec.
 *
 * The literal types already refuse a wide design at compile time; the
 * runtime checks hold the same line for untyped callers. There is no
 * escape hatch: `arms: 3` or `blind: false` throws, never downgrades.
 */
export function defineEquivalenceCheck(spec: EquivalenceCheckSpec): EquivalenceCheckDefinition {
  if (spec.arms !== 2) {
    throw new EquivalenceProtocolError(
      'arm-count',
      `equivalence check requires exactly 2 arms, received ${String(spec.arms)}`,
    )
  }
  if (spec.blind !== true) {
    throw new EquivalenceProtocolError(
      'not-blind',
      'equivalence check requires blind: true — a non-blind run is not a weaker check, it is no check',
    )
  }
  if (typeof spec.artifact !== 'string' || spec.artifact.trim() === '') {
    throw new EquivalenceProtocolError(
      'empty-field',
      'spec.artifact must identify the claim under verification',
    )
  }
  if (!VERIFICATION_STRATEGY_SOURCES.includes(spec.source)) {
    throw new EquivalenceProtocolError(
      'unknown-source',
      `spec.source '${String(spec.source)}' is not a verification-strategy member`,
    )
  }
  return Object.freeze({ spec: Object.freeze({ ...spec }) })
}

/**
 * Assemble the equivalence record, refusing every asymmetry.
 *
 * Refusals (each throws `EquivalenceProtocolError`):
 * - an arm whose `blindness.toOtherArms` is false — it saw the other
 *   statement, so nothing was independently derived;
 * - an arm whose `blindness.toOutcome` is false — it could steer its
 *   statement toward (or away from) the known result;
 * - duplicate arm ids, empty statements, empty derivations;
 * - an obligation whose fields contradict its status (see
 *   `EquivalenceObligation`).
 */
export function buildEquivalenceRecord(
  definition: EquivalenceCheckDefinition,
  arms: readonly [EquivalenceArm, EquivalenceArm],
  obligation: EquivalenceObligation,
): EquivalenceRecord {
  assertArms(arms)
  assertObligation(obligation)
  return Object.freeze({
    spec: definition.spec,
    arms: Object.freeze([Object.freeze({ ...arms[0] }), Object.freeze({ ...arms[1] })] as const),
    obligation: Object.freeze({ ...obligation }),
  })
}

/**
 * Discharge the obligation through an injected checker and return the
 * record.
 *
 * Order matters: every arm refusal fires BEFORE the checker runs — an
 * invalid check must not spend. A checker whose `strategy` differs from
 * `spec.source` is refused for the same reason: a judge cannot silently
 * discharge a proof-kernel obligation.
 *
 * A checker failure (`succeeded: false`) is not thrown: it becomes an
 * `'unresolved'` obligation carrying the full error text, which is the
 * honest record of an undischarged check.
 */
export async function runEquivalenceCheck(
  definition: EquivalenceCheckDefinition,
  arms: readonly [EquivalenceArm, EquivalenceArm],
  checker: EquivalenceChecker,
): Promise<EquivalenceRecord> {
  assertArms(arms)
  if (checker.strategy !== definition.spec.source) {
    throw new EquivalenceProtocolError(
      'checker-strategy-mismatch',
      `spec.source is '${definition.spec.source}' but the bound checker declares '${checker.strategy}'`,
    )
  }
  const outcome = await checker.check({
    artifact: definition.spec.artifact,
    statements: [arms[0].statement, arms[1].statement],
  })
  if (!outcome.succeeded) {
    return buildEquivalenceRecord(definition, arms, {
      status: 'unresolved',
      unresolvedReason: outcome.error,
      checker: checker.identity,
    })
  }
  const { status, separatingWitness, evidenceDigest } = outcome.value
  return buildEquivalenceRecord(definition, arms, {
    status,
    ...(separatingWitness === undefined ? {} : { separatingWitness }),
    checker: checker.identity,
    evidenceDigest,
  })
}

function assertArms(arms: readonly [EquivalenceArm, EquivalenceArm]): void {
  if (arms.length !== 2) {
    throw new EquivalenceProtocolError(
      'arm-count',
      `equivalence record requires exactly 2 arms, received ${arms.length}`,
    )
  }
  if (arms[0].armId === arms[1].armId) {
    throw new EquivalenceProtocolError(
      'duplicate-arm-id',
      `both arms declare armId '${arms[0].armId}' — two labels for one derivation is one arm`,
    )
  }
  for (const arm of arms) {
    if (arm.statement.trim() === '') {
      throw new EquivalenceProtocolError(
        'empty-field',
        `arm '${arm.armId}' committed an empty statement`,
      )
    }
    if (arm.derivedFrom.trim() === '') {
      throw new EquivalenceProtocolError(
        'empty-field',
        `arm '${arm.armId}' declares no derivation provenance`,
      )
    }
    if (arm.blindness.toOtherArms !== true) {
      throw new EquivalenceProtocolError(
        'arm-saw-other',
        `arm '${arm.armId}' saw another arm's statement — the derivation is not independent and the check is invalid`,
      )
    }
    if (arm.blindness.toOutcome !== true) {
      throw new EquivalenceProtocolError(
        'arm-saw-outcome',
        `arm '${arm.armId}' saw the outcome before committing — the check is invalid`,
      )
    }
  }
}

function assertObligation(obligation: EquivalenceObligation): void {
  const { status, separatingWitness, unresolvedReason, evidenceDigest } = obligation
  if (status === 'refuted-with-separating-witness') {
    if (typeof separatingWitness !== 'string' || separatingWitness.trim() === '') {
      throw new EquivalenceProtocolError(
        'witness-missing',
        'a refuted equivalence must carry the separating witness — a refutation without one is an assertion',
      )
    }
    if (typeof evidenceDigest !== 'string' || evidenceDigest.trim() === '') {
      throw new EquivalenceProtocolError(
        'evidence-missing',
        'a refuted equivalence must carry its evidence digest',
      )
    }
    return
  }
  if (status === 'proved') {
    if (separatingWitness !== undefined) {
      throw new EquivalenceProtocolError(
        'witness-on-proved',
        'a proved equivalence cannot carry a separating witness — the two claims contradict',
      )
    }
    if (typeof evidenceDigest !== 'string' || evidenceDigest.trim() === '') {
      throw new EquivalenceProtocolError(
        'evidence-missing',
        'a proved equivalence must carry its evidence digest',
      )
    }
    return
  }
  // status === 'unresolved'
  if (separatingWitness !== undefined) {
    throw new EquivalenceProtocolError(
      'witness-on-unresolved',
      'an unresolved obligation cannot carry a separating witness — a witness in hand is a refutation',
    )
  }
  if (typeof unresolvedReason !== 'string' || unresolvedReason.trim() === '') {
    throw new EquivalenceProtocolError(
      'reason-missing',
      "an unresolved obligation must say why — 'unresolved' with no reason erases the diagnostic",
    )
  }
}
