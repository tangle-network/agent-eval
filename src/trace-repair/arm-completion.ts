/**
 * The arms that answer over an OpenAI-compatible endpoint.
 *
 * Two arms share this factory because they differ only in what sits behind the
 * URL: `bare-framing` is one chat completion with no harness, `prime` is an
 * agent harness reached through a bridge that speaks the same wire shape. The
 * prompt, the reply grammar, the single bounded repair turn and the row cap
 * are identical, so the difference the comparison measures is the execution
 * path and not the framing.
 *
 * The exchange itself is `runPrimeExchange`: one call, one bounded repair turn
 * on a structurally malformed reply, then decoding. Zero valid rows from a
 * well-formed reply is an honest decline, not a failure.
 */

import type { PrimeBridgeTransport } from '../analyst/prime-bridge-transport'
import {
  analystUsageReceiptFromPrimeUsage,
  buildPrimePrompt,
  type PrimeRawUsage,
  type PrimeReplyContract,
  runPrimeExchange,
} from '../analyst/prime-protocol'
import type { CustomTokenPricing } from '../cost-ledger'
import { ValidationError } from '../errors'
import type { ActionPayloadKind } from './action-budget'
import { type InterventionBudget, SCAFFOLD_INTERVENTION_BUDGET } from './action-budget'
import type {
  RepairArm,
  RepairArmAffordance,
  RepairArmCertification,
  RepairArmReply,
  RepairArmRequest,
  RepairArmUsage,
} from './analyst-arm'
import {
  REPAIR_CONTRACT_LINES,
  REPAIR_QUESTION,
  REPAIR_REPAIR_CONTRACT_LINES,
  renderRepairTrajectory,
  repairTaskDefinition,
  repairTrajectoryHeader,
} from './repair-prompt'

/** One decoded reply row, before it becomes a finding. */
interface CompletionRepairRow {
  readonly k: number
  readonly failureClaim: string
  readonly kind: ActionPayloadKind
  readonly action: string
}

export interface CompletionRepairArmOptions {
  readonly id: string
  /** What actually answers the POST, in one plain sentence. */
  readonly execution: string
  /** Full endpoint, e.g. `http://127.0.0.1:4200/v1/chat/completions`. */
  readonly url: string
  readonly model: string
  /** Injected so a test drives the arm without a network. */
  readonly transport: PrimeBridgeTransport
  /** Deadline for ONE turn. */
  readonly timeoutMs: number
  /** Rates used to price the reported tokens. */
  readonly pricing: CustomTokenPricing
  readonly budget?: InterventionBudget
  /** What this arm can do that another cannot. */
  readonly affordances: readonly RepairArmAffordance[]
  readonly certification: RepairArmCertification
}

export function createCompletionRepairArm(options: CompletionRepairArmOptions): RepairArm {
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new ValidationError(
      `repair arm '${options.id}' timeoutMs must be a positive safe integer, got ${options.timeoutMs}`,
    )
  }
  const budget = options.budget ?? SCAFFOLD_INTERVENTION_BUDGET
  return {
    declaration: {
      id: options.id,
      execution: options.execution,
      certification: options.certification,
      budget,
      // `runPrimeExchange` takes exactly one repair turn on a malformed reply.
      repairTurns: 1,
      affordances: options.affordances,
    },
    async ask(request: RepairArmRequest): Promise<RepairArmReply> {
      const prompt = buildPrimePrompt({
        question: REPAIR_QUESTION,
        taskDefinition: repairTaskDefinition(request.prefix, budget),
        contractLines: REPAIR_CONTRACT_LINES,
        trajectoryHeader: repairTrajectoryHeader(request.prefix),
        renderedTrajectory: renderRepairTrajectory(request.prefix),
      })
      const outcome = await runPrimeExchange<CompletionRepairRow>({
        contract: replyContract(request),
        prompt,
        transport: options.transport,
        url: options.url,
        model: options.model,
        timeoutMs: options.timeoutMs,
        repair: true,
        ...(request.signal ? { signal: request.signal } : {}),
      })
      const usage = armUsage(outcome.usage, options.pricing)
      if (!outcome.ok) {
        return {
          status: 'failed',
          failure: `${outcome.failure.kind}: ${outcome.failure.message}`,
          answer: null,
          rejectedRows: [],
          repair: outcome.repair,
          usage,
        }
      }
      const row = outcome.rows[0]
      if (row === undefined) {
        return {
          status: 'declined',
          answer: outcome.answer,
          reportedRows: outcome.reportedRows,
          rejectedRows: outcome.rejected,
          repair: outcome.repair,
          usage,
        }
      }
      return {
        status: 'finding',
        k: row.k,
        failureClaim: row.failureClaim,
        intervention: { kind: row.kind, action: row.action },
        answer: outcome.answer,
        reportedRows: outcome.reportedRows,
        rejectedRows: outcome.rejected,
        repair: outcome.repair,
        usage,
      }
    },
  }
}

/**
 * Decode one reply row.
 *
 * Every field is checked and nothing is defaulted: a `k` outside the recorded
 * step ids is a rejected row rather than a clamped one, because an arm that
 * names a step the recording does not hold has not localized anything.
 */
function replyContract(request: RepairArmRequest): PrimeReplyContract<CompletionRepairRow> {
  const validSteps = request.prefix.steps.map((step) => step.step_id)
  return {
    rowsField: 'findings',
    contractLines: REPAIR_CONTRACT_LINES,
    repairContractLines: REPAIR_REPAIR_CONTRACT_LINES,
    maxRows: 1,
    decodeRow(row, index) {
      if (typeof row !== 'object' || row === null || Array.isArray(row)) {
        return { ok: false, reason: `row ${index} is not an object` }
      }
      const record = row as Record<string, unknown>
      const k = record.k
      if (!Number.isInteger(k) || !validSteps.includes(k as number)) {
        return {
          ok: false,
          reason: `k must be a recorded step_id in [${validSteps[0] ?? 1}, ${request.prefix.maxK}], got ${describe(k)}`,
        }
      }
      const claim = record.failure_claim ?? record.failureClaim
      if (typeof claim !== 'string' || claim.trim().length === 0) {
        return { ok: false, reason: 'failure_claim must be a non-empty string' }
      }
      const raw = record.intervention
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        return { ok: false, reason: 'intervention must be an object with kind and action' }
      }
      const intervention = raw as Record<string, unknown>
      const action = intervention.action
      if (typeof action !== 'string' || action.length === 0) {
        return { ok: false, reason: 'intervention.action must be a non-empty string' }
      }
      const kind = intervention.kind
      if (kind !== 'shell' && kind !== 'edit') {
        return {
          ok: false,
          reason: `intervention.kind must be "shell" or "edit", got ${describe(kind)}`,
        }
      }
      return {
        ok: true,
        row: { k: k as number, failureClaim: claim.trim(), kind, action },
      }
    },
  }
}

function armUsage(usage: PrimeRawUsage, pricing: CustomTokenPricing): RepairArmUsage {
  const receipt = analystUsageReceiptFromPrimeUsage(usage, pricing)
  return {
    calls: usage.calls,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    // A one-sided token count prices to a lower bound, which the receipt
    // reports separately from a complete cost. Neither becomes a zero.
    costUsd: receipt.cost.usd ?? receipt.knownCostUsd ?? null,
  }
}

function describe(value: unknown): string {
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  return typeof value === 'string' ? JSON.stringify(value) : String(value)
}
