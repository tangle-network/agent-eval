/**
 * Milestone 2, phase 2: ask every analyst arm for one finding, one arm at a
 * time.
 *
 * The arms are an ablation of the EXECUTION PATH. Both answer the same prompt,
 * under the same reply contract, with the same bounded repair turn, on the same
 * pre-registered rows, against the same model on the same upstream:
 *
 *   bare-framing  one streamed chat completion on the z.ai coding endpoint.
 *   prime         the prime agent harness through cli-bridge, same endpoint
 *                 underneath.
 *
 * Four rules separate this phase from a run that spends money and returns
 * nothing:
 *
 *   1. One arm at a time. The measurement seat is taken per arm and released
 *      before the next arm asks for it, because the arms share one upstream
 *      seat that answers HTTP 429 past a few concurrent calls.
 *   2. Layered deadlines. Time to first byte and the largest gap between bytes
 *      are measured in seconds, so a dead connection fails its row in seconds
 *      instead of holding it for the length of the turn deadline.
 *   3. The carrier is proved alive before the arm starts and before every row.
 *      When it dies the arm stops and says so; the rows it never asked are
 *      recorded as unasked, never as answers.
 *   4. A refusal that arrives before the model reads the prompt — a 429, a full
 *      bridge executor — is not an answer. The runner waits for capacity and
 *      reissues the row.
 *
 * REUSE. Rows already answered by an earlier attempt are not paid for twice.
 * The rule is fixed here, ahead of any grade, and applied to every arm alike:
 * an answer the model produced STANDS, whether it was a finding, an honest
 * decline, or a reply that stayed malformed through the repair turn; an outcome
 * produced by the carrier instead of the model — a deadline, an HTTP status, a
 * transport error, a 200 carrying no content — is not a sample and is reissued.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  analystUsageReceiptFromPrimeUsage,
  buildPrimePrompt,
  type PrimeReplyContract,
  runPrimeExchange,
} from '../src/analyst/prime-protocol'
import { nodeHttpPrimeBridgeTransport } from '../src/analyst/prime-bridge-transport'
import {
  type AdmissionEvidence,
  admitRow,
  blindTrajectory,
} from '../src/trace-repair'
import type { AnswerRecord } from './tb-repair-m2-analyze'
import {
  waitForBridge,
  waitForSeat,
  ZAI_COMPLETIONS,
  zaiStreamingTransport,
} from './tb-repair-m2-carrier'
import { acquireSeat, makeLogger, mapLimit, WORK } from './tb-repair-m2-lib'
import {
  REPAIR_CONTRACT_LINES,
  REPAIR_QUESTION,
  REPAIR_REPAIR_CONTRACT_LINES,
  REPAIR_TASK_POLICY,
  renderTrajectory,
  trajectoryHeader,
} from './tb-repair-m2-prompt'

/** Published z.ai coding-plan rates for the glm family every arm runs. */
const GLM_PRICING = { inputUsdPerMillion: 0.6, outputUsdPerMillion: 2.2 }

/**
 * Terminal reasons the carrier produced rather than the model. An answer
 * carrying one of these was never a sample, so reissuing the row does not hand
 * its arm a second attempt at a question the model already saw.
 */
const CARRIER_FAULTS = ['deadline', 'http-status', 'transport', 'no-content', 'unparseable-json']

function isCarrierFault(record: AnswerRecord): boolean {
  if (record.status !== 'failed') return false
  const kind = (record.failure ?? '').split(':')[0]!.trim()
  return CARRIER_FAULTS.includes(kind)
}

interface RepairRow {
  k: number
  failure_claim: string
  intervention: { kind: 'shell' | 'edit'; action: string }
}

interface ArmSpec {
  id: string
  url: string
  model: string
  concurrency: number
  /** Deadline for one turn, after the byte-level watchdogs. */
  turnTimeoutMs: number
  execution: string
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
      return {
        ok: true,
        row: { k: k as number, failure_claim: claim.trim(), intervention: { kind, action } },
      }
    },
  }
}

function emptyAnswer(rowId: string, arm: string, status: AnswerRecord['status'], failure: string): AnswerRecord {
  return {
    rowId,
    arm,
    status,
    failure,
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
  }
}

function buildPrompt(evidence: AdmissionEvidence): {
  prompt: string
  maxK: number
  validSteps: number[]
} {
  const decision = admitRow(evidence)
  if (!decision.admitted) throw new Error(`${evidence.rowId} is not admitted; phase 2 saw a rejected row`)
  const prefix = blindTrajectory(decision.row)
  return {
    prompt: buildPrimePrompt({
      question: REPAIR_QUESTION,
      taskDefinition: [
        ...REPAIR_TASK_POLICY,
        '',
        'TASK STATEMENT GIVEN TO THE AGENT:',
        prefix.taskStatement,
      ].join('\n'),
      contractLines: REPAIR_CONTRACT_LINES,
      trajectoryHeader: trajectoryHeader(prefix),
      renderedTrajectory: renderTrajectory(prefix),
    }),
    maxK: prefix.maxK,
    validSteps: prefix.steps.map((step) => step.step_id),
  }
}

/** One row, one arm, at most `attempts` issues when the carrier refuses early. */
async function askArm(
  arm: ArmSpec,
  evidence: AdmissionEvidence,
  apiKey: string,
  log: (m: string) => void,
  attempts = 3,
): Promise<AnswerRecord> {
  const { prompt, maxK, validSteps } = buildPrompt(evidence)
  const transport = arm.id === 'bare-framing' ? zaiStreamingTransport(apiKey) : nodeHttpPrimeBridgeTransport()
  const base = {
    rowId: evidence.rowId,
    arm: arm.id,
    promptChars: prompt.length,
    rejected: [] as { index: number; reason: string }[],
  }
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const startedMs = Date.now()
    const outcome = await runPrimeExchange<RepairRow>({
      contract: replyContract(maxK, validSteps),
      prompt,
      transport,
      url: arm.url,
      model: arm.model,
      timeoutMs: arm.turnTimeoutMs,
      repair: true,
    })
    const wallMs = Date.now() - startedMs
    const receipt = analystUsageReceiptFromPrimeUsage(outcome.usage, GLM_PRICING)
    const costUsd = receipt.cost.usd ?? receipt.knownCostUsd ?? null
    if (!outcome.ok) {
      // 429 is the seat's quota wall and 500 is the bridge's admission wall.
      // Both are refusals issued before the prompt reached a model, so the row
      // still has no answer and reissuing it is not a second attempt.
      const refusedStatus = outcome.failure.kind === 'http-status' ? outcome.failure.status : null
      const early = refusedStatus === 429 || refusedStatus === 500
      if (early && attempt < attempts) {
        log(`${evidence.rowId} ${arm.id} refused before the model read it (HTTP ${refusedStatus}); waiting for capacity, attempt ${attempt}/${attempts}`)
        if (arm.id === 'bare-framing') await waitForSeat(apiKey, log)
        else await waitForBridge(arm.url.replace('/v1/chat/completions', ''), log)
        continue
      }
      log(`${evidence.rowId} ${arm.id} FAILED ${outcome.failure.kind}: ${outcome.failure.message.slice(0, 180)}`)
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
        costUsd,
        wallMs,
      }
    }
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
      `${evidence.rowId} ${arm.id} finding k=${row.k} bytes=${Buffer.byteLength(row.intervention.action)} ${wallMs}ms $${costUsd?.toFixed(4) ?? 'uncaptured'}`,
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
  return emptyAnswer(evidence.rowId, arm.id, 'failed', `carrier-refused: ${attempts} issues all refused before the model read the prompt`)
}

async function main(): Promise<void> {
  const outDir = process.env.TBR_OUT ?? join(WORK, 'out')
  const apiKey = process.env.ZAI_API_KEY
  if (!apiKey) throw new Error('ZAI_API_KEY is required: both arms reach the same z.ai seat')
  const budgetUsd = Number(process.env.TBR_BUDGET_USD ?? '8')

  const admit = JSON.parse(readFileSync(join(outDir, 'admit.json'), 'utf8')) as {
    records: { rowId: string; admitted: boolean; evidence: AdmissionEvidence | null }[]
  }
  const subset = new Set(
    JSON.parse(readFileSync(join(outDir, 'row-subset.json'), 'utf8')) as string[],
  )
  const admitted = admit.records.filter((r) => r.admitted && r.evidence !== null && subset.has(r.rowId))

  // Which file the reuse rule reads, and which it writes. Named rather than
  // fixed so a second pass can reuse the FIRST pass's answers instead of the
  // attempt before it, and can write beside that file rather than over it.
  const priorFile = process.env.TBR_PRIOR_ANSWERS ?? 'answers.json'
  const answersOut = process.env.TBR_ANSWERS_OUT ?? 'answers-v2.json'
  const prior = (() => {
    try {
      return (JSON.parse(readFileSync(join(outDir, priorFile), 'utf8')) as { answers: AnswerRecord[] }).answers
    } catch {
      return [] as AnswerRecord[]
    }
  })()

  const arms: ArmSpec[] = [
    {
      id: 'bare-framing',
      url: ZAI_COMPLETIONS,
      model: 'glm-5.2',
      concurrency: Number(process.env.TBR_BARE_CONCURRENCY ?? '3'),
      turnTimeoutMs: Number(process.env.TBR_BARE_TURN_MS ?? '900000'),
      execution: 'one streamed chat completion on api.z.ai coding-plan, no harness',
    },
    {
      id: 'prime',
      url: process.env.TBR_PRIME_URL ?? 'http://localhost:4181/v1/chat/completions',
      model: process.env.TBR_PRIME_MODEL ?? 'prime/zai/glm-5.2',
      concurrency: Number(process.env.TBR_PRIME_CONCURRENCY ?? '2'),
      turnTimeoutMs: Number(process.env.TBR_PRIME_TURN_MS ?? '2400000'),
      execution: 'prime agent harness (loop + IPython kernel) through cli-bridge, same z.ai upstream',
    },
  ]
  const only = process.env.TBR_ARMS?.split(',').map((s) => s.trim()).filter(Boolean)
  const selected = only && only.length > 0 ? arms.filter((a) => only.includes(a.id)) : arms

  mkdirSync(outDir, { recursive: true })
  const logPath = join(outDir, 'analyze2.log')
  writeFileSync(logPath, '')
  const log = makeLogger((line) => writeFileSync(logPath, line, { flag: 'a' }))
  log(`phase=analyze2 rows=${admitted.length} arms=${selected.map((a) => `${a.id}@${a.concurrency}`).join(',')} budget=$${budgetUsd}`)

  const answers: AnswerRecord[] = []
  const provenance: Record<string, unknown>[] = []
  let spent = 0

  for (const arm of selected) {
    const reused = admitted
      .map((record) => prior.find((a) => a.arm === arm.id && a.rowId === record.rowId))
      .filter((a): a is AnswerRecord => a !== undefined && !isCarrierFault(a))
    const reusedIds = new Set(reused.map((a) => a.rowId))
    const todo = admitted.filter((record) => !reusedIds.has(record.rowId))
    log(`arm=${arm.id} reused=${reused.length} toRun=${todo.length} (reuse rule: the model's own outcome stands, a carrier fault is reissued)`)
    answers.push(...reused.map((a) => ({ ...a })))
    for (const answer of reused) {
      provenance.push({ arm: arm.id, rowId: answer.rowId, source: 'reused', status: answer.status })
    }
    if (todo.length === 0) continue

    const armStarted = Date.now()
    const release = await acquireSeat(`tb-repair-m2-analyze2:${arm.id}`, log)
    const onSignal = (): never => {
      release()
      process.exit(130)
    }
    process.once('SIGINT', onSignal)
    process.once('SIGTERM', onSignal)
    let carrierDown: string | null = null
    try {
      if (arm.id === 'bare-framing') {
        const probe = await waitForSeat(apiKey, log)
        log(`carrier check ${arm.id}: ok=${probe.ok} http=${probe.status} echoedModel=${probe.echoedModel} selfReport=${JSON.stringify(probe.selfReport)} ${probe.wallMs}ms`)
        if (!probe.ok) carrierDown = `pre-arm probe failed: ${probe.detail}`
      } else {
        const health = await waitForBridge(arm.url.replace('/v1/chat/completions', ''), log)
        log(`carrier check ${arm.id}: ok=${health.ok} ${health.detail} active=${health.active}/${health.maxActive}`)
        if (!health.ok) carrierDown = `pre-arm bridge check failed: ${health.detail}`
      }
      const armAnswers: AnswerRecord[] = []
      if (carrierDown === null) {
        const collected = await mapLimit(todo, arm.concurrency, async (record): Promise<AnswerRecord> => {
          if (carrierDown !== null) {
            return emptyAnswer(record.rowId, arm.id, 'failed', `unasked: ${carrierDown}`)
          }
          if (spent >= budgetUsd) {
            return emptyAnswer(record.rowId, arm.id, 'failed', `unasked: budget of $${budgetUsd} reached`)
          }
          // Between rows, on the same carrier the row is about to use.
          if (arm.id === 'bare-framing') {
            const probe = await waitForSeat(apiKey, log)
            if (!probe.ok) {
              carrierDown = `carrier died mid-arm: ${probe.detail}`
              log(`ARM STOPPED ${arm.id}: ${carrierDown}`)
              return emptyAnswer(record.rowId, arm.id, 'failed', `unasked: ${carrierDown}`)
            }
          } else {
            const health = await waitForBridge(arm.url.replace('/v1/chat/completions', ''), log)
            if (!health.ok) {
              carrierDown = `carrier died mid-arm: ${health.detail}`
              log(`ARM STOPPED ${arm.id}: ${carrierDown}`)
              return emptyAnswer(record.rowId, arm.id, 'failed', `unasked: ${carrierDown}`)
            }
          }
          const answer = await askArm(arm, record.evidence!, apiKey, log).catch(
            (error): AnswerRecord =>
              emptyAnswer(record.rowId, arm.id, 'failed', `thrown: ${(error as Error).message}`),
          )
          spent += answer.costUsd ?? 0
          provenance.push({ arm: arm.id, rowId: answer.rowId, source: 'ran', status: answer.status, costUsd: answer.costUsd })
          return answer
        })
        armAnswers.push(...collected)
      } else {
        log(`ARM NOT STARTED ${arm.id}: ${carrierDown}`)
        for (const record of todo) {
          armAnswers.push(emptyAnswer(record.rowId, arm.id, 'failed', `unasked: ${carrierDown}`))
        }
      }
      answers.push(...armAnswers)
      const findings = armAnswers.filter((a) => a.status === 'finding').length
      const cost = armAnswers.reduce((sum, a) => sum + (a.costUsd ?? 0), 0)
      log(
        `arm=${arm.id} ran=${armAnswers.length} findings=${findings} declined=${armAnswers.filter((a) => a.status === 'declined').length} failed=${armAnswers.filter((a) => a.status === 'failed').length} newCost=$${cost.toFixed(4)} wall=${Math.round((Date.now() - armStarted) / 1000)}s spentTotal=$${spent.toFixed(4)}`,
      )
    } finally {
      release()
      process.off('SIGINT', onSignal)
      process.off('SIGTERM', onSignal)
    }
    writeFileSync(
      join(outDir, answersOut),
      JSON.stringify({ generatedAt: new Date().toISOString(), arms: selected, provenance, answers }, null, 2),
    )
  }
  writeFileSync(
    join(outDir, answersOut),
    JSON.stringify({ generatedAt: new Date().toISOString(), arms: selected, provenance, answers }, null, 2),
  )
  log(`done answers=${answers.length} newSpend=$${spent.toFixed(4)}`)
}

main().catch((error) => {
  process.stderr.write(`${(error as Error).stack}\n`)
  process.exit(1)
})
