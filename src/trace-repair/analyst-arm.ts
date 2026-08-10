/**
 * What an analyst arm is, and what every arm owes the comparison.
 *
 * An arm is one way of EXECUTING the repair question: a single chat
 * completion, an agent harness, a DSPy program. The question, the reply
 * grammar, the action budget and the bounded repair turn belong to the
 * comparison, not to the arm — so they live here and every arm inherits them.
 *
 * Three rules this module makes structural rather than customary:
 *
 *   one contract      an arm returns `RepairFinding` or an honest decline,
 *                     and nothing else parses. An arm that produced neither
 *                     fails loud with a typed reason; nothing is defaulted.
 *   one budget        `askRepairArm` measures every action against the
 *                     scaffold budget and records the measurement. The grader
 *                     remains the single authority that rejects, so a
 *                     violation is reported here and refused there — never
 *                     silently trimmed to fit.
 *   one repair turn   arms declare how many bounded retries a malformed reply
 *                     earns. `repairArmAsymmetries` refuses a set whose arms
 *                     disagree, because a second attempt is a second sample
 *                     the other arms never got.
 *
 * What arms are ALLOWED to differ in is declared, not hidden: `affordances`
 * names what an arm can do that another cannot — read the trajectory through
 * a code interpreter, take internal turns — and `repairArmAsymmetries` renders
 * those differences so a reader sees them beside the result instead of having
 * to infer them from two runners' source.
 */

import { assertEqualDeclarativeTerms } from '../analyst/equal-terms'
import { ValidationError } from '../errors'
import {
  type BudgetMeasurement,
  type BudgetViolation,
  checkInterventionBudget,
  type InterventionBudget,
} from './action-budget'
import type { AdmittedRow } from './admission-contract'
import type { AnalystResponse, RepairFinding, RepairIntervention } from './analyst-response'
import { type BlindedTrajectoryPrefix, blindTrajectory } from './blinding'
import { repairArmPromptSha256, repairQuestionSha256 } from './repair-prompt'

/**
 * Something an arm can do that another arm cannot.
 *
 * Declared per arm and reported beside the result. This list is the vocabulary
 * of admissible difference: an arm whose advantage is not nameable here is not
 * comparable to the others, and that is a design decision to take deliberately
 * rather than a field to widen.
 */
export type RepairArmAffordance =
  /** The whole trajectory arrives in the prompt text. */
  | 'inline-trajectory'
  /** The trajectory is read through bounded tools instead of the prompt. */
  | 'trajectory-tools'
  /** The arm may run code while it reasons. */
  | 'code-interpreter'
  /** The arm takes internal turns of its own before answering. */
  | 'agent-loop'

/**
 * Whether the arm's instruction text carries a certification, and from where.
 *
 * On the repair task nothing is certified: the one certified analyst artifact
 * this repository holds was earned on a different benchmark under a different
 * output contract. `kind: 'none'` with a reason is therefore the expected
 * value, and it is recorded rather than omitted so a reader never has to
 * assume.
 */
export type RepairArmCertification =
  | { readonly kind: 'none'; readonly reason: string }
  | {
      readonly kind: 'certified'
      /** The artifact whose text this arm runs. */
      readonly artifact: string
      /** The benchmark the certification was earned on. */
      readonly benchmark: string
      /** The output contract it was certified for. */
      readonly contract: string
    }

export interface RepairArmDeclaration {
  readonly id: string
  /** What actually answers, in one plain sentence. Recorded so a report never
   *  has to infer the execution path from the runner's source. */
  readonly execution: string
  readonly certification: RepairArmCertification
  /** The action budget the arm's answers are measured against. */
  readonly budget: InterventionBudget
  /** Bounded retries a structurally malformed reply earns. */
  readonly repairTurns: number
  readonly affordances: readonly RepairArmAffordance[]
  /** The arm's own instruction and output-grammar text, exactly as the arm
   *  composes it into the question. It enters the per-arm prompt digest, so a
   *  contract change — a reworded grammar, a new signature version — changes
   *  the digest of every answer the arm stamps. */
  readonly promptContract: readonly string[]
}

/** What an arm is handed. The type carries only the blinded prefix, so a
 *  grading field is unreachable rather than merely unread: the admitted row
 *  stays with `askRepairArm`, which does the blinding and the bookkeeping. */
export interface RepairArmRequest {
  readonly prefix: BlindedTrajectoryPrefix
  readonly signal?: AbortSignal
}

/** Token accounting exactly as the execution path reported it. A side nobody
 *  measured stays null rather than becoming a zero. */
export interface RepairArmUsage {
  readonly calls: number | null
  readonly inputTokens: number | null
  readonly outputTokens: number | null
  readonly costUsd: number | null
}

export interface RepairArmRepairTurn {
  readonly attempted: boolean
  /** Null when no repair turn ran, or when it never returned a reply. */
  readonly succeeded: boolean | null
}

/** A row an arm reported and the pipeline refused, counted by reason. */
export interface RepairArmRejectedRow {
  readonly index: number
  readonly reason: string
}

/**
 * What an arm hands back.
 *
 * `finding` and `declined` are the two answers the grader consumes. `failed`
 * is everything else, and it always carries a reason: an arm that could not
 * answer must say so rather than return an empty finding that grades as a
 * decline it never made.
 */
export type RepairArmReply =
  | {
      readonly status: 'finding'
      readonly k: number
      readonly failureClaim: string
      readonly intervention: RepairIntervention
      readonly answer: string | null
      readonly reportedRows: number
      readonly rejectedRows: readonly RepairArmRejectedRow[]
      readonly repair: RepairArmRepairTurn
      readonly usage: RepairArmUsage
    }
  | {
      readonly status: 'declined'
      readonly answer: string | null
      readonly reportedRows: number
      readonly rejectedRows: readonly RepairArmRejectedRow[]
      readonly repair: RepairArmRepairTurn
      readonly usage: RepairArmUsage
    }
  | {
      readonly status: 'failed'
      readonly failure: string
      readonly answer: string | null
      readonly rejectedRows: readonly RepairArmRejectedRow[]
      readonly repair: RepairArmRepairTurn
      readonly usage: RepairArmUsage
    }

export interface RepairArm {
  readonly declaration: RepairArmDeclaration
  ask(request: RepairArmRequest): Promise<RepairArmReply>
}

/**
 * The budget verdict on an arm's action, measured before any container opens.
 *
 * Recorded, never enforced here: `gradeRepairRow` refuses an inadmissible
 * action, and one authority is the point. Measuring it at answer time is what
 * lets a report say what an arm spent its bytes on without paying for a
 * rollout to find out.
 */
export type RepairArmBudgetRecord =
  | { readonly admissible: true; readonly measurement: BudgetMeasurement }
  | {
      readonly admissible: false
      readonly violation: BudgetViolation
      readonly detail: string
      readonly measurement: BudgetMeasurement
    }

export interface RepairArmAnswer {
  readonly rowId: string
  readonly armId: string
  /** Digest of the composed question the arm answered. */
  readonly promptSha256: string
  readonly reply: RepairArmReply
  /** Present only for a finding. */
  readonly budget: RepairArmBudgetRecord | null
  readonly wallMs: number
}

export interface AskRepairArmOptions {
  readonly arm: RepairArm
  readonly row: AdmittedRow
  /** Truncate the prefix after this 1-based step. Defaults to the whole recording. */
  readonly throughStep?: number
  readonly signal?: AbortSignal
  /** Injectable clock so a test can assert a recorded duration. */
  readonly now?: () => number
}

/**
 * Ask one arm about one admitted row.
 *
 * Blinding, prompt identity and budget measurement happen here, once, for
 * every arm. An arm that wants a different question does not get one.
 */
export async function askRepairArm(options: AskRepairArmOptions): Promise<RepairArmAnswer> {
  const { arm, row } = options
  assertDeclaration(arm.declaration)
  const now = options.now ?? Date.now
  const startedMs = now()
  const prefix = blindTrajectory(
    row,
    options.throughStep === undefined ? {} : { throughStep: options.throughStep },
  )
  const reply = await arm.ask({
    prefix,
    ...(options.signal ? { signal: options.signal } : {}),
  })
  assertReplyWithinDeclaration(arm.declaration, reply)
  const budget =
    reply.status === 'finding'
      ? checkInterventionBudget(
          reply.intervention.action,
          reply.intervention.kind,
          arm.declaration.budget,
        )
      : null
  return {
    rowId: row.rowId,
    armId: arm.declaration.id,
    promptSha256: repairArmPromptSha256(arm.declaration.budget, arm.declaration.promptContract),
    reply,
    budget,
    wallMs: now() - startedMs,
  }
}

/**
 * The answer in the grammar the grader consumes.
 *
 * Null for a failure: a run that could not answer has no answer to grade, and
 * turning it into a decline would credit an arm with an honest null it never
 * produced.
 */
export function repairArmResponse(answer: RepairArmAnswer): AnalystResponse | null {
  const { reply } = answer
  if (reply.status === 'declined') return { kind: 'no-decisive-failure' }
  if (reply.status === 'failed') return null
  const finding: RepairFinding = {
    kind: 'finding',
    k: reply.k,
    failureClaim: reply.failureClaim,
    intervention: reply.intervention,
  }
  return finding
}

/** One arm's difference from the set, as a report renders it. */
export interface RepairArmAsymmetry {
  readonly armId: string
  /** Affordances this arm has that at least one other arm lacks. */
  readonly extraAffordances: readonly RepairArmAffordance[]
  /** Affordances at least one other arm has and this one lacks. */
  readonly missingAffordances: readonly RepairArmAffordance[]
  readonly certification: RepairArmCertification
  /** Digest of the composed question this arm answers: the shared question
   *  plus the arm's own contract text. Two arms with the same digest asked the
   *  identical composed question; two arms with different digests did not. */
  readonly promptSha256: string
}

export interface RepairArmAsymmetryReport {
  readonly armIds: readonly string[]
  /** Affordances every arm has. Not an asymmetry; recorded so a reader can see
   *  the floor the comparison runs on. */
  readonly sharedAffordances: readonly RepairArmAffordance[]
  readonly asymmetries: readonly RepairArmAsymmetry[]
  /** True when no arm carries a certification. The honest state on a task
   *  whose graders are newer than every certified artifact. */
  readonly noArmCertified: boolean
  readonly budget: InterventionBudget
  readonly repairTurns: number
  /** Digest of the question and task policy every arm shares. Per-arm
   *  composed-question digests live on each asymmetry entry. */
  readonly questionSha256: string
}

/**
 * Refuse a set of arms that cannot be compared, and describe what still
 * differs between the ones that can.
 *
 * Two properties are hard: the arms measure actions against the same budget,
 * and a malformed reply earns the same number of retries everywhere. Both are
 * things that would move a score without moving the thing being measured.
 *
 * Certification is the third: a set where some arms run certified text and
 * others do not is refused outright. An optimisation applies to every arm or
 * to none — a mixed set measures the optimisation, then reports it as the
 * harness.
 */
export function repairArmAsymmetries(
  arms: readonly RepairArm[],
  options: { readonly budget?: InterventionBudget } = {},
): RepairArmAsymmetryReport {
  if (arms.length === 0) {
    throw new ValidationError('a repair-arm comparison needs at least one arm')
  }
  const declarations = arms.map((arm) => arm.declaration)
  for (const declaration of declarations) assertDeclaration(declaration)

  const { ids, repairTurns } = assertEqualDeclarativeTerms(
    'repair arm',
    declarations.map((declaration) => ({
      id: declaration.id,
      repairTurns: declaration.repairTurns,
    })),
  )

  const budget = options.budget ?? declarations[0]!.budget
  const mismatched = declarations.find((declaration) => !sameBudget(declaration.budget, budget))
  if (mismatched) {
    throw new ValidationError(
      `arm '${mismatched.id}' measures actions against ${JSON.stringify(mismatched.budget)}, ` +
        `the comparison runs ${JSON.stringify(budget)}; one arm buying a bigger action than ` +
        'another is a difference in what was asked, not in what answered',
    )
  }

  const certified = declarations.filter(
    (declaration) => declaration.certification.kind === 'certified',
  )
  if (certified.length > 0 && certified.length !== declarations.length) {
    throw new ValidationError(
      `${certified.length}/${declarations.length} arms run certified text ` +
        `(${certified.map((declaration) => declaration.id).join(', ')}); an optimisation applies ` +
        'to every arm or to none',
    )
  }

  const shared = ALL_AFFORDANCES.filter((affordance) =>
    declarations.every((declaration) => declaration.affordances.includes(affordance)),
  )
  const asymmetries = declarations.map((declaration) => ({
    armId: declaration.id,
    extraAffordances: ALL_AFFORDANCES.filter(
      (affordance) =>
        declaration.affordances.includes(affordance) &&
        declarations.some((other) => !other.affordances.includes(affordance)),
    ),
    missingAffordances: ALL_AFFORDANCES.filter(
      (affordance) =>
        !declaration.affordances.includes(affordance) &&
        declarations.some((other) => other.affordances.includes(affordance)),
    ),
    certification: declaration.certification,
    promptSha256: repairArmPromptSha256(declaration.budget, declaration.promptContract),
  }))
  return {
    armIds: ids,
    sharedAffordances: shared,
    asymmetries,
    noArmCertified: certified.length === 0,
    budget,
    repairTurns,
    questionSha256: repairQuestionSha256(budget),
  }
}

const ALL_AFFORDANCES: readonly RepairArmAffordance[] = Object.freeze([
  'inline-trajectory',
  'trajectory-tools',
  'code-interpreter',
  'agent-loop',
])

function sameBudget(a: InterventionBudget, b: InterventionBudget): boolean {
  return (
    a.maxBytes === b.maxBytes &&
    a.maxStatements === b.maxStatements &&
    a.maxHeredocs === b.maxHeredocs
  )
}

function assertDeclaration(declaration: RepairArmDeclaration): void {
  if (
    typeof declaration.id !== 'string' ||
    declaration.id.trim() !== declaration.id ||
    !declaration.id
  ) {
    throw new ValidationError('a repair arm id must be a trimmed non-empty string')
  }
  if (typeof declaration.execution !== 'string' || !declaration.execution.trim()) {
    throw new ValidationError(`arm '${declaration.id}' must state what executes its answer`)
  }
  if (!Number.isInteger(declaration.repairTurns) || declaration.repairTurns < 0) {
    throw new ValidationError(
      `arm '${declaration.id}' repairTurns must be a non-negative integer, got ${declaration.repairTurns}`,
    )
  }
  if (
    declaration.certification.kind === 'none' &&
    (typeof declaration.certification.reason !== 'string' ||
      !declaration.certification.reason.trim())
  ) {
    throw new ValidationError(
      `arm '${declaration.id}' carries no certification and must say why in one sentence`,
    )
  }
  if (
    !Array.isArray(declaration.promptContract) ||
    declaration.promptContract.length === 0 ||
    declaration.promptContract.some((line) => typeof line !== 'string')
  ) {
    throw new ValidationError(
      `arm '${declaration.id}' must declare its contract text as a non-empty array of strings; ` +
        'the per-arm prompt digest is computed from it',
    )
  }
  for (const affordance of declaration.affordances) {
    if (!ALL_AFFORDANCES.includes(affordance)) {
      throw new ValidationError(
        `arm '${declaration.id}' declares unknown affordance '${affordance}'`,
      )
    }
  }
}

/** An arm that reports more repair turns than it declared is not the arm the
 *  comparison admitted, so the answer never reaches a grader. */
function assertReplyWithinDeclaration(
  declaration: RepairArmDeclaration,
  reply: RepairArmReply,
): void {
  if (reply.repair.attempted && declaration.repairTurns === 0) {
    throw new ValidationError(
      `arm '${declaration.id}' declares no bounded repair turn but took one`,
    )
  }
  if (reply.status === 'failed' && !reply.failure.trim()) {
    throw new ValidationError(`arm '${declaration.id}' failed without stating why`)
  }
  if (reply.status === 'finding' && !reply.intervention.action) {
    throw new ValidationError(
      `arm '${declaration.id}' returned a finding with an empty intervention`,
    )
  }
}
