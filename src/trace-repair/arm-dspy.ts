/**
 * The DSPy arm on the repair contract.
 *
 * THIS ARM CARRIES NO CERTIFICATION ON THIS TASK, and the code says so rather
 * than leaving a reader to assume otherwise. The one GEPA-certified analyst
 * artifact this repository holds — `oht2-coverage-instructions.txt` — was
 * earned on the CodeTraceBench incorrect-step task, whose output contract is a
 * set of blocks carrying `first_step`, `last_step`, `consequence_step` and
 * `escape_status` over recorded steps that were wrong. The repair task asks a
 * different question with a different answer: one step k, and one executable
 * action of the same type and budget the scaffold itself took, which must make
 * a held-out suite pass. Re-authoring the certified text for that contract
 * would void the certification, because the benchmark it was earned on has
 * been retired. So the instruction text here is authored fresh for the repair
 * task and declared uncertified.
 *
 * What DOES carry over is the engine, and that is the point of the arm: a DSPy
 * program with a typed signature, a structured module, and a code environment
 * it reads the subject with. The trajectory is delivered as a typed input
 * bound as a REPL variable rather than parsed back out of prompt text, which
 * is the difference between this arm and the ones that answer over a chat
 * completion.
 *
 * The typed repair rows travel back in `runtime.repair`, not in `findings`.
 * The engine-neutral finding schema caps `recommended_action` at 2000
 * characters while the scaffold action budget is 4096 bytes, so routing a
 * repair through it would hand this arm a smaller action than every other arm
 * gets — an affordance asymmetry hidden inside a schema. The measured
 * comparison run shows why that matters: chat-completion arms returned actions
 * of 2705, 3413, 3987 and 4733 bytes.
 */

import type { TraceAnalysisEngine, TraceAnalystLimits } from '../analyst/engine'
import type { CostLedgerHandle } from '../cost-ledger'
import { ValidationError } from '../errors'
import {
  type ActionPayloadKind,
  type InterventionBudget,
  SCAFFOLD_INTERVENTION_BUDGET,
} from './action-budget'
import type {
  RepairArm,
  RepairArmRejectedRow,
  RepairArmReply,
  RepairArmRequest,
  RepairArmUsage,
} from './analyst-arm'
import { REPAIR_QUESTION, repairTaskPolicy } from './repair-prompt'

/**
 * Token the bridge reads to select the typed repair signature.
 *
 * The wire protocol carries instructions as opaque text, so the task is named
 * inside them rather than by adding a field every unrelated caller would have
 * to set. The same mechanism selects the CodeTraceBench typed signature.
 */
export const DSPY_REPAIR_TASK_TOKEN = 'tb-repair-typed-'

/** Signature the bridge reports for a repair analysis. */
export const DSPY_REPAIR_SIGNATURE = 'tb-repair-typed-v1'

/** The name the trajectory is bound to inside the program's environment. */
const DSPY_REPAIR_TRAJECTORY_INPUT = 'trajectory'

/**
 * The repair contract restated for the typed signature.
 *
 * Transport differs from the chat-completion arms — typed SUBMIT instead of a
 * fenced JSON object — and the QUESTION does not. Both read from
 * `repairTaskPolicy`, so the execution rules an arm is held to cannot drift
 * between arms.
 */
export function dspyRepairInstructions(
  budget: InterventionBudget = SCAFFOLD_INTERVENTION_BUDGET,
): string {
  return [
    `TASK ${DSPY_REPAIR_TASK_TOKEN}${DSPY_REPAIR_SIGNATURE}`,
    '',
    ...repairTaskPolicy(budget),
    '',
    `The recorded trajectory is already loaded into your environment as \`${DSPY_REPAIR_TRAJECTORY_INPUT}\`,`,
    'a list of {step_id, action, observation} objects in recorded order. Read it with code',
    'rather than re-fetching it, and do not claim to have inspected anything you did not read.',
    '',
    'SUBMIT at most ONE repair, shaped as:',
    '- k: the step_id whose action you replace. It must be a step_id present in the trajectory.',
    '- failure_claim: what went wrong at step k. Recorded, never scored.',
    '- intervention_kind: "edit" when the action authors a file with a heredoc, "shell" otherwise.',
    `- action: the EXACT shell text to run instead, at most ${budget.maxBytes} bytes and exactly`,
    `  ${budget.maxStatements === 1 ? 'one top-level statement' : `${budget.maxStatements} top-level statements`}. It is executed verbatim: not a description, not a diff, not a plan.`,
    'SUBMIT an empty list only when no single replacement action could make the suite pass.',
  ].join('\n')
}

export interface DspyRepairArmOptions {
  /** The DSPy engine. Injected, so a test drives the arm with no subprocess. */
  readonly engine: TraceAnalysisEngine
  readonly limits: TraceAnalystLimits
  readonly costLedger: CostLedgerHandle
  readonly costPhase: string
  readonly analystId: string
  readonly costTags?: Record<string, string>
  readonly budget?: InterventionBudget
  readonly id?: string
  readonly log?: (message: string, fields?: Record<string, unknown>) => void
}

export function createDspyRepairArm(options: DspyRepairArmOptions): RepairArm {
  assertDspyRepairEngine(options.engine)
  const budget = options.budget ?? SCAFFOLD_INTERVENTION_BUDGET
  const instructions = dspyRepairInstructions(budget)
  return {
    declaration: {
      id: options.id ?? 'dspy-rlm',
      execution: `DSPy RLM program (${options.engine.id} v${options.engine.version}) with a typed repair signature and a code environment`,
      certification: {
        kind: 'none',
        reason:
          'the GEPA-certified analyst text was earned on the CodeTraceBench incorrect-step ' +
          'contract, which asks for blocks of wrong steps rather than one executable repair; ' +
          'this arm runs instruction text authored for the repair contract and certified by nothing',
      },
      budget,
      // The bridge takes exactly one bounded structured re-read when the typed
      // field comes back as text, which is the same single retry the
      // chat-completion arms get for a malformed reply.
      repairTurns: 1,
      affordances: ['inline-trajectory', 'code-interpreter', 'agent-loop'],
      // The instruction text names the signature version, so bumping
      // DSPY_REPAIR_SIGNATURE changes the per-arm prompt digest.
      promptContract: [instructions],
    },
    async ask(request: RepairArmRequest): Promise<RepairArmReply> {
      const steps = request.prefix.steps.map((step) => ({
        step_id: step.step_id,
        action: step.action,
        observation: step.observation,
      }))
      let result: Awaited<ReturnType<TraceAnalysisEngine['analyze']>>
      try {
        result = await options.engine.analyze({
          analystId: options.analystId,
          question: [
            REPAIR_QUESTION,
            '',
            `The trajectory has ${steps.length} recorded steps, step_ids ${steps
              .map((step) => step.step_id)
              .join(', ')}.`,
          ].join('\n'),
          instructions,
          tools: [],
          taskInputs: {
            [DSPY_REPAIR_TRAJECTORY_INPUT]: steps,
            taskStatement: request.prefix.taskStatement,
          },
          limits: options.limits,
          costLedger: options.costLedger,
          costPhase: options.costPhase,
          ...(options.costTags ? { costTags: options.costTags } : {}),
          ...(request.signal ? { signal: request.signal } : {}),
          ...(options.log ? { log: options.log } : {}),
        })
      } catch (error) {
        return {
          status: 'failed',
          failure: `engine threw: ${error instanceof Error ? error.message : String(error)}`,
          answer: null,
          rejectedRows: [],
          repair: { attempted: false, succeeded: null },
          usage: engineUsage(null),
        }
      }
      const payload = readRepairPayload(result.runtime, {
        validSteps: steps.map((step) => step.step_id),
      })
      const usage = engineUsage(result.modelCalls)
      if (!payload.ok) {
        // The engine answered, but not under the repair contract. That is a
        // wiring fault or a signature mismatch, never an honest decline, so it
        // is reported as a failure with the reason attached.
        return {
          status: 'failed',
          failure: payload.reason,
          answer: result.answer,
          rejectedRows: [],
          repair: { attempted: false, succeeded: null },
          usage,
        }
      }
      const { rows, dropped, repair, reported, failure } = payload.value
      // Succeeded means the re-read produced a well-formed reply — the same
      // definition the chat-completion arms record — so a recovered empty
      // list, an honest decline, is a repair turn that succeeded.
      const repairTurn = {
        attempted: repair !== null,
        succeeded: repair === null ? null : failure === null,
      }
      if (failure !== null) {
        return {
          status: 'failed',
          failure,
          answer: result.answer,
          rejectedRows: dropped,
          repair: repairTurn,
          usage,
        }
      }
      const row = rows[0]
      if (row === undefined) {
        return {
          status: 'declined',
          answer: result.answer,
          reportedRows: reported,
          rejectedRows: dropped,
          repair: repairTurn,
          usage,
        }
      }
      return {
        status: 'finding',
        k: row.k,
        failureClaim: row.failureClaim,
        intervention: { kind: row.kind, action: row.action },
        answer: result.answer,
        reportedRows: reported,
        rejectedRows: dropped,
        repair: repairTurn,
        usage,
      }
    },
  }
}

interface DspyRepairRow {
  readonly k: number
  readonly failureClaim: string
  readonly kind: ActionPayloadKind
  readonly action: string
}

interface DspyRepairPayload {
  readonly signature: string
  readonly reported: number
  readonly rows: readonly DspyRepairRow[]
  readonly dropped: readonly RepairArmRejectedRow[]
  /** How the bounded structured re-read recovered the typed field, or null
   *  when the field arrived typed and no re-read was needed. */
  readonly repair: string | null
  /** The bridge's own account of a typed field it could not read — a reply
   *  that stayed malformed after the bounded re-read. The analysis completed,
   *  so the answer text survives beside it; null on a readable reply. */
  readonly failure: string | null
}

type ReadRepairPayload =
  | { readonly ok: true; readonly value: DspyRepairPayload }
  | { readonly ok: false; readonly reason: string }

export interface ReadRepairPayloadOptions {
  /** The step ids the blinded prefix holds. A row naming any other k is the
   *  model's mistake, not the bridge's, so it lands in `dropped` — the same
   *  rejected-row path the chat-completion arms take — never in a finding the
   *  grader would refuse as out of range. */
  readonly validSteps: readonly number[]
}

/**
 * Read the bridge's typed repair block.
 *
 * Structure is checked and fails loud: a missing block, a wrong signature, or
 * a row that does not carry an integer k and a non-empty action is a wiring
 * fault with a reason — never a default, and never an empty list that would
 * grade as a decline the program did not make. A structurally sound row whose
 * k is not a recorded step id is the model's mistake, and it is dropped with
 * its reason instead.
 */
function readRepairPayload(
  runtime: Record<string, unknown>,
  options: ReadRepairPayloadOptions,
): ReadRepairPayload {
  const block = runtime.repair
  if (!isRecord(block)) {
    return {
      ok: false,
      reason:
        'the engine returned no runtime.repair block; the bridge did not run the typed repair signature',
    }
  }
  if (block.signature !== DSPY_REPAIR_SIGNATURE) {
    return {
      ok: false,
      reason: `runtime.repair.signature is ${describe(block.signature)}, expected "${DSPY_REPAIR_SIGNATURE}"`,
    }
  }
  if (!Number.isSafeInteger(block.reported) || (block.reported as number) < 0) {
    return {
      ok: false,
      reason: `runtime.repair.reported must be a non-negative integer, got ${describe(block.reported)}`,
    }
  }
  if (!Array.isArray(block.rows)) {
    return { ok: false, reason: 'runtime.repair.rows must be an array' }
  }
  const repair = block.repair
  if (repair !== null && typeof repair !== 'string') {
    return {
      ok: false,
      reason: `runtime.repair.repair must be a string or null, got ${describe(repair)}`,
    }
  }
  const rawFailure = block.failure
  if (rawFailure !== undefined && rawFailure !== null && typeof rawFailure !== 'string') {
    return {
      ok: false,
      reason: `runtime.repair.failure must be a string or null, got ${describe(rawFailure)}`,
    }
  }
  const failure = typeof rawFailure === 'string' ? rawFailure : null
  const dropped: RepairArmRejectedRow[] = []
  if (block.dropped !== undefined) {
    if (!Array.isArray(block.dropped)) {
      return { ok: false, reason: 'runtime.repair.dropped must be an array' }
    }
    for (const [index, raw] of block.dropped.entries()) {
      if (!isRecord(raw) || typeof raw.reason !== 'string') {
        return {
          ok: false,
          reason: `runtime.repair.dropped[${index}] must carry a reason string`,
        }
      }
      dropped.push({
        index: Number.isSafeInteger(raw.index) ? (raw.index as number) : index,
        reason: raw.reason,
      })
    }
  }
  const rows: DspyRepairRow[] = []
  for (const [index, raw] of block.rows.entries()) {
    const decoded = decodeRepairRow(raw)
    if (!decoded.ok) {
      return { ok: false, reason: `runtime.repair.rows[${index}]: ${decoded.reason}` }
    }
    if (!options.validSteps.includes(decoded.row.k)) {
      dropped.push({
        index,
        reason: `k must be a recorded step_id in [${options.validSteps[0] ?? 1}, ${options.validSteps[options.validSteps.length - 1] ?? 1}], got ${decoded.row.k}`,
      })
      continue
    }
    if (rows.length >= 1) {
      // The bridge caps at one repair; a second valid row here means the cap
      // regressed, and the surplus is recorded rather than silently discarded.
      dropped.push({ index, reason: 'exceeds the one-repair cap' })
      continue
    }
    rows.push(decoded.row)
  }
  return {
    ok: true,
    value: {
      signature: DSPY_REPAIR_SIGNATURE,
      reported: block.reported as number,
      rows,
      dropped,
      repair: repair ?? null,
      failure,
    },
  }
}

function decodeRepairRow(
  raw: unknown,
): { ok: true; row: DspyRepairRow } | { ok: false; reason: string } {
  if (!isRecord(raw)) return { ok: false, reason: 'not an object' }
  const k = raw.k
  if (!Number.isInteger(k) || (k as number) < 1) {
    return { ok: false, reason: `k must be a positive integer, got ${describe(k)}` }
  }
  const claim = raw.failure_claim
  if (typeof claim !== 'string' || claim.trim().length === 0) {
    return { ok: false, reason: 'failure_claim must be a non-empty string' }
  }
  const intervention = raw.intervention
  if (!isRecord(intervention)) {
    return { ok: false, reason: 'intervention must be an object with kind and action' }
  }
  const kind = intervention.kind
  if (kind !== 'shell' && kind !== 'edit') {
    return {
      ok: false,
      reason: `intervention.kind must be "shell" or "edit", got ${describe(kind)}`,
    }
  }
  const action = intervention.action
  if (typeof action !== 'string' || action.length === 0) {
    return { ok: false, reason: 'intervention.action must be a non-empty string' }
  }
  return { ok: true, row: { k: k as number, failureClaim: claim.trim(), kind, action } }
}

/**
 * The engine reports model calls; token counts and cost live in the caller's
 * cost ledger, which meters the proxy the engine ran through. Reporting them
 * here as zero would state a measurement this arm did not make.
 */
function engineUsage(modelCalls: number | null): RepairArmUsage {
  return { calls: modelCalls, inputTokens: null, outputTokens: null, costUsd: null }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function describe(value: unknown): string {
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  return typeof value === 'string' ? JSON.stringify(value) : String(value)
}

/** Thrown by callers that build a repair arm with a non-DSPy engine. */
export function assertDspyRepairEngine(engine: TraceAnalysisEngine): void {
  if (engine.id !== 'dspy-rlm') {
    throw new ValidationError(
      `the DSPy repair arm needs the dspy-rlm engine, got '${engine.id}'; another engine ` +
        'does not run the typed repair signature and would answer a different contract',
    )
  }
}
