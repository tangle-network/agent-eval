/**
 * Milestone 2, phase 2: ask every analyst arm for one finding. Models run here
 * and nowhere else, so this phase holds the measurement seat and nothing else
 * does.
 *
 * The arms are an ablation of the EXECUTION PATH. All of them answer the same
 * prompt, under the same reply contract, with the same bounded repair turn, on
 * the same admitted rows, against the same model family:
 *
 *   bare-framing  one chat completion on the router. No harness.
 *   prime         the prime agent harness through cli-bridge.
 *
 * A row's answer is recorded whatever it is — a finding, an honest decline, or
 * a terminal failure with its reason. Nothing is retried silently, because a
 * second attempt buys an arm a second sample the others never got.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { nodeHttpPrimeBridgeTransport } from '../src/analyst/prime-bridge-transport'
import {
  analystUsageReceiptFromPrimeUsage,
  buildPrimePrompt,
  type PrimeRawUsage,
  type PrimeReplyContract,
  runPrimeExchange,
} from '../src/analyst/prime-protocol'
import {
  type AdmissionEvidence,
  admitRow,
  type AnalystResponse,
  blindTrajectory,
  repairFinding,
} from '../src/trace-repair'
import { acquireSeat, makeLogger, mapLimit, WORK } from './tb-repair-m2-lib'
import {
  REPAIR_CONTRACT_LINES,
  REPAIR_QUESTION,
  REPAIR_REPAIR_CONTRACT_LINES,
  REPAIR_TASK_POLICY,
  renderTrajectory,
  trajectoryHeader,
} from './tb-repair-m2-prompt'

/**
 * Deadline for ONE turn.
 *
 * The one-shot arm has to produce the whole repair in a single completion, and
 * a streaming probe against the same endpoint showed first-token latency of
 * 4 s with generation continuing for minutes afterwards: the wait is the
 * model writing, not a dead connection. 15 minutes was not enough, so this is
 * configurable and the campaign runs it higher.
 */
const TURN_TIMEOUT_MS = Number(process.env.TBR_TURN_TIMEOUT_MS ?? '900000')

/** Published z.ai coding-plan rates for glm-5.2, the family every arm runs. */
const GLM_PRICING = { inputUsdPerMillion: 0.6, outputUsdPerMillion: 2.2 }

interface ArmSpec {
  id: string
  url: string
  model: string
  /**
   * Rows in flight for this arm. Per-arm because the arms have different
   * bottlenecks: the bare arm is one HTTP wait per row and can run wide, while
   * prime occupies a bridge admission slot for minutes and must stay under
   * cli-bridge's own active cap.
   */
  concurrency: number
  /** What actually answers the POST. Recorded so the report never has to infer it. */
  execution: string
}

interface RepairRow {
  k: number
  failure_claim: string
  intervention: { kind: 'shell' | 'edit'; action: string }
}

function replyContract(maxK: number, validSteps: readonly number[]): PrimeReplyContract<RepairRow> {
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
        return { ok: false, reason: `k must be a recorded step_id in [1, ${maxK}], got ${String(k)}` }
      }
      const claim = record.failure_claim ?? record.failureClaim
      if (typeof claim !== 'string' || claim.trim().length === 0) {
        return { ok: false, reason: 'failure_claim must be a non-empty string' }
      }
      const raw = record.intervention
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        return { ok: false, reason: 'intervention must be an object' }
      }
      const intervention = raw as Record<string, unknown>
      const action = intervention.action
      if (typeof action !== 'string' || action.length === 0) {
        return { ok: false, reason: 'intervention.action must be a non-empty string' }
      }
      const kind = intervention.kind
      if (kind !== 'shell' && kind !== 'edit') {
        return { ok: false, reason: `intervention.kind must be shell or edit, got ${String(kind)}` }
      }
      return { ok: true, row: { k: k as number, failure_claim: claim.trim(), intervention: { kind, action } } }
    },
  }
}

export interface AnswerRecord {
  rowId: string
  arm: string
  status: 'finding' | 'declined' | 'failed'
  failure: string | null
  k: number | null
  failureClaim: string | null
  interventionKind: string | null
  action: string | null
  actionBytes: number | null
  answer: string | null
  reportedRows: number | null
  rejected: { index: number; reason: string }[]
  repairAttempted: boolean
  repairSucceeded: boolean | null
  usage: PrimeRawUsage | null
  costUsd: number | null
  wallMs: number
  promptChars: number
}

/**
 * The bridge transport, optionally with a completion cap.
 *
 * A single unbounded completion on a reasoning model can run for many minutes,
 * because the whole task has to be solved in one turn. `TBR_MAX_TOKENS` bounds
 * it. Unset by default: a cap that truncates the reply turns a slow answer into
 * a malformed one, which would score the arm on the cap rather than on the
 * model, so it is only turned on deliberately and is recorded when it is.
 */
function boundedTransport(): ReturnType<typeof nodeHttpPrimeBridgeTransport> {
  const cap = Number(process.env.TBR_MAX_TOKENS ?? '0')
  const inner = nodeHttpPrimeBridgeTransport()
  if (!Number.isFinite(cap) || cap <= 0) return inner
  return (request) =>
    inner({ ...request, body: { ...request.body, max_tokens: cap } as typeof request.body })
}

async function askArm(
  arm: ArmSpec,
  evidence: AdmissionEvidence,
  log: (m: string) => void,
): Promise<AnswerRecord> {
  const decision = admitRow(evidence)
  if (!decision.admitted) throw new Error(`${evidence.rowId} is not admitted; phase 2 saw a rejected row`)
  const prefix = blindTrajectory(decision.row)
  const validSteps = prefix.steps.map((s) => s.step_id)
  const prompt = buildPrimePrompt({
    question: REPAIR_QUESTION,
    taskDefinition: [...REPAIR_TASK_POLICY, '', 'TASK STATEMENT GIVEN TO THE AGENT:', prefix.taskStatement].join('\n'),
    contractLines: REPAIR_CONTRACT_LINES,
    trajectoryHeader: trajectoryHeader(prefix),
    renderedTrajectory: renderTrajectory(prefix),
  })
  const startedMs = Date.now()
  const base = {
    rowId: evidence.rowId,
    arm: arm.id,
    promptChars: prompt.length,
    rejected: [] as { index: number; reason: string }[],
  }
  const outcome = await runPrimeExchange<RepairRow>({
    contract: replyContract(prefix.maxK, validSteps),
    prompt,
    transport: boundedTransport(),
    url: arm.url,
    model: arm.model,
    timeoutMs: TURN_TIMEOUT_MS,
    repair: true,
  })
  const wallMs = Date.now() - startedMs
  if (!outcome.ok) {
    const receipt = analystUsageReceiptFromPrimeUsage(outcome.usage, GLM_PRICING)
    log(`${evidence.rowId} ${arm.id} FAILED ${outcome.failure.kind}: ${outcome.failure.message.slice(0, 200)}`)
    return {
      ...base,
      status: 'failed',
      failure: `${outcome.failure.kind}: ${outcome.failure.message}`,
      k: null,
      failureClaim: null,
      interventionKind: null,
      action: null,
      actionBytes: null,
      answer: null,
      reportedRows: null,
      repairAttempted: outcome.repair.attempted,
      repairSucceeded: outcome.repair.succeeded,
      usage: outcome.usage,
      costUsd: receipt.cost.usd ?? receipt.knownCostUsd ?? null,
      wallMs,
    }
  }
  const receipt = analystUsageReceiptFromPrimeUsage(outcome.usage, GLM_PRICING)
  const costUsd = receipt.cost.usd ?? receipt.knownCostUsd ?? null
  const row = outcome.rows[0]
  if (row === undefined) {
    log(`${evidence.rowId} ${arm.id} declined (reported=${outcome.reportedRows} rejected=${outcome.rejected.length})`)
    return {
      ...base,
      status: 'declined',
      failure: null,
      k: null,
      failureClaim: null,
      interventionKind: null,
      action: null,
      actionBytes: null,
      answer: outcome.answer,
      reportedRows: outcome.reportedRows,
      rejected: outcome.rejected,
      repairAttempted: outcome.repair.attempted,
      repairSucceeded: outcome.repair.succeeded,
      usage: outcome.usage,
      costUsd,
      wallMs,
    }
  }
  log(
    `${evidence.rowId} ${arm.id} finding k=${row.k} bytes=${Buffer.byteLength(row.intervention.action)} ${wallMs}ms $${costUsd?.toFixed(4) ?? '?'}`,
  )
  return {
    ...base,
    status: 'finding',
    failure: null,
    k: row.k,
    failureClaim: row.failure_claim,
    interventionKind: row.intervention.kind,
    action: row.intervention.action,
    actionBytes: Buffer.byteLength(row.intervention.action),
    answer: outcome.answer,
    reportedRows: outcome.reportedRows,
    rejected: outcome.rejected,
    repairAttempted: outcome.repair.attempted,
    repairSucceeded: outcome.repair.succeeded,
    usage: outcome.usage,
    costUsd,
    wallMs,
  }
}

/** Turn a recorded answer back into the substrate's answer grammar. */
export function answerToResponse(record: AnswerRecord): AnalystResponse | null {
  if (record.status === 'declined') return { kind: 'no-decisive-failure' }
  if (record.status !== 'finding' || record.k === null || record.action === null) return null
  return repairFinding({
    k: record.k,
    failureClaim: record.failureClaim ?? '',
    intervention: { kind: record.interventionKind === 'edit' ? 'edit' : 'shell', action: record.action },
  })
}

async function main(): Promise<void> {
  const outDir = process.env.TBR_OUT ?? join(WORK, 'out')
  const admit = JSON.parse(readFileSync(join(outDir, 'admit.json'), 'utf8')) as {
    records: { rowId: string; admitted: boolean; evidence: AdmissionEvidence | null }[]
  }
  const subsetFile = process.env.TBR_ROW_SUBSET
  const subset = subsetFile ? new Set(JSON.parse(readFileSync(subsetFile, 'utf8')) as string[]) : null
  const admitted = admit.records
    .filter((r) => r.admitted && r.evidence !== null)
    .filter((r) => subset === null || subset.has(r.rowId))
  const arms: ArmSpec[] = [
    {
      id: 'bare-framing',
      url: process.env.TBR_BARE_URL ?? 'http://127.0.0.1:4200/v1/chat/completions',
      model: process.env.TBR_BARE_MODEL ?? 'glm-5.2',
      // z.ai directly rather than router.tangle.tools: the router's edge closes a
      // non-streaming request at ~100 s with HTTP 524, and a reasoning model on a
      // trajectory prompt runs past that. Going straight to z.ai also puts this arm
      // on the SAME upstream the prime backend uses, so the two arms differ by the
      // harness and not by the provider.
      execution: 'one chat completion on api.z.ai coding-plan through an auth-injecting proxy',
      concurrency: Number(process.env.TBR_BARE_CONCURRENCY ?? '10'),
    },
    {
      id: 'prime',
      url: process.env.TBR_PRIME_URL ?? 'http://localhost:4181/v1/chat/completions',
      model: process.env.TBR_PRIME_MODEL ?? 'prime/zai/glm-5.2',
      execution: 'prime agent harness (loop + IPython kernel) through cli-bridge',
      concurrency: Number(process.env.TBR_PRIME_CONCURRENCY ?? '4'),
    },
  ]
  const only = process.env.TBR_ARMS?.split(',').map((s) => s.trim()).filter(Boolean)
  const selected = only && only.length > 0 ? arms.filter((a) => only.includes(a.id)) : arms

  mkdirSync(outDir, { recursive: true })
  const logPath = join(outDir, 'analyze.log')
  writeFileSync(logPath, '')
  const log = makeLogger((line) => writeFileSync(logPath, line, { flag: 'a' }))
  log(`phase=analyze rows=${admitted.length} arms=${selected.map((a) => `${a.id}@${a.concurrency}`).join(',')} turnTimeoutMs=${TURN_TIMEOUT_MS}`)

  const release = await acquireSeat('tb-repair-m2-analyze', log)
  const answers: AnswerRecord[] = []
  try {
    for (const arm of selected) {
      const armStarted = Date.now()
      const armAnswers = await mapLimit(admitted, arm.concurrency, (record) =>
        askArm(arm, record.evidence!, log).catch(
          (error): AnswerRecord => ({
            rowId: record.rowId,
            arm: arm.id,
            status: 'failed',
            failure: `thrown: ${(error as Error).message}`,
            k: null,
            failureClaim: null,
            interventionKind: null,
            action: null,
            actionBytes: null,
            answer: null,
            reportedRows: null,
            rejected: [],
            repairAttempted: false,
            repairSucceeded: null,
            usage: null,
            costUsd: null,
            wallMs: 0,
            promptChars: 0,
          }),
        ),
      )
      answers.push(...armAnswers)
      const findings = armAnswers.filter((a) => a.status === 'finding').length
      const cost = armAnswers.reduce((sum, a) => sum + (a.costUsd ?? 0), 0)
      log(
        `arm=${arm.id} findings=${findings}/${armAnswers.length} declined=${armAnswers.filter((a) => a.status === 'declined').length} failed=${armAnswers.filter((a) => a.status === 'failed').length} cost=$${cost.toFixed(4)} wall=${Math.round((Date.now() - armStarted) / 1000)}s`,
      )
      writeFileSync(
        join(outDir, 'answers.json'),
        JSON.stringify({ generatedAt: new Date().toISOString(), arms: selected, answers }, null, 2),
      )
    }
  } finally {
    release()
  }
  log(`done answers=${answers.length}`)
}

main().catch((error) => {
  process.stderr.write(`${(error as Error).stack}\n`)
  process.exit(1)
})
