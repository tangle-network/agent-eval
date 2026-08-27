/**
 * Milestone 3: the DSPy arm answers the repair contract.
 *
 * This runner drives the arm authored for the repair task
 * (`createDspyRepairArm`) rather than mapping the engine's generic finding
 * schema onto a repair. The distinction is load-bearing: the engine-neutral
 * schema caps `recommended_action` at 2000 characters against a 4096-byte
 * action budget, so routing this arm through it would hand it a smaller answer
 * than the completion arms get, and the asymmetry would sit inside a schema
 * where no reader would find it.
 *
 * The arm answers the same policy the completion arms were paid to answer.
 * `repairTaskPolicy` renders byte-identical to the text recorded in the
 * milestone-2 run, so the three arms differ in what EXECUTES the question and
 * in the reply grammar their transport requires, and in nothing else.
 *
 * Carrier discipline matches the completion arms: the seat is taken once for
 * the arm and released only if this process still owns it, the seat is proved
 * alive before the arm starts and before every row, and a refusal that arrives
 * before the model reads the prompt is waited out rather than recorded as an
 * answer.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDspyRlmTraceEngine } from '../src/analyst/dspy-rlm-engine'
import { testModelExecutionOwner } from '../src/analyst/model-execution.test-support'
import { CostLedger } from '../src/cost-ledger'
import { admitRow, askRepairArm, createDspyRepairArm } from '../src/trace-repair'
import type { AnswerRecord } from './tb-repair-m2-analyze'
import { probeZaiSeat, waitForSeat } from './tb-repair-m2-carrier'
import { acquireSeat, makeLogger, mapLimit, WORK } from './tb-repair-m2-lib'
import {
  type LegacyAdmissionEvidence,
  M3_CRITERIA,
  upgradeEvidence,
} from './tb-repair-m3-lib'

/** Published z.ai coding-plan rates for the glm family every arm runs. */
const GLM_PRICING = { inputUsdPerMillion: 0.6, outputUsdPerMillion: 2.2 }
const VENV_PYTHON = '/home/drew/code/agent-eval/clients/python/.venv/bin/python'
/** The worktree's bridge carries the typed repair signature; the venv's editable
 *  install points at a checkout that does not. PYTHONPATH precedes site-packages
 *  in sys.path, so this shadows it without mutating the shared venv. */
const BRIDGE_SRC = fileURLToPath(new URL('../clients/python/src', import.meta.url))

/** Per-row provider ceiling. The arm is capped so a runaway code loop cannot
 *  consume the campaign budget on one row. */
const MAX_COST_USD = Number(process.env.TBR_DSPY_MAX_COST ?? '0.35')
const ROW_DEADLINE_MS = Number(process.env.TBR_DSPY_DEADLINE_MS ?? '900000')

const ARM_ID = 'dspy-repair'

/** A row the ledger could not price reads as uncaptured, never as $0. */
function money(costUsd: number | null): string {
  return costUsd === null ? 'cost=uncaptured' : `$${costUsd.toFixed(4)}`
}

function emptyRecord(rowId: string, promptChars: number): Omit<AnswerRecord, 'status'> {
  return {
    rowId,
    arm: ARM_ID,
    promptChars,
    rejected: [],
    failure: null,
    k: null,
    failureClaim: null,
    interventionKind: null,
    action: null,
    actionBytes: null,
    answer: null,
    reportedRows: null,
    repairAttempted: false,
    repairSucceeded: null,
    usage: null,
    costUsd: null,
    wallMs: 0,
  }
}

async function askRow(
  legacy: LegacyAdmissionEvidence,
  bearer: string,
  log: (m: string) => void,
): Promise<AnswerRecord> {
  const evidence = upgradeEvidence(legacy)
  const decision = admitRow(evidence, M3_CRITERIA)
  if (!decision.admitted) throw new Error(`${evidence.rowId} is not admitted; phase 2 saw a rejected row`)

  // The carrier is proved alive before the row, so a dead seat fails in seconds
  // rather than inside a fifteen-minute analysis deadline.
  const probe = await waitForSeat(bearer, log)
  if (!probe.ok) {
    log(`${evidence.rowId} ${ARM_ID} carrier down before the row: ${probe.detail.slice(0, 120)}`)
    return {
      ...emptyRecord(evidence.rowId, 0),
      status: 'failed',
      failure: `carrier: ${probe.detail.slice(0, 160)}`,
    }
  }

  const costLedger = new CostLedger()
  const owner = testModelExecutionOwner({
    baseUrl: 'https://api.z.ai/api/coding/paas/v4',
    bearer,
    fetchImpl: fetch,
    pricing: GLM_PRICING,
    callRef: 'tb-repair-m3:zai:glm-5.2',
  })
  const engine = createDspyRlmTraceEngine({
    call: owner.call,
    callRef: owner.callRef,
    recordExecution: owner.recordExecution,
    model: 'glm-5.2',
    pricing: GLM_PRICING,
    maxCostUsd: MAX_COST_USD,
    timeoutMs: ROW_DEADLINE_MS,
    runner: {
      command: VENV_PYTHON,
      env: { ...process.env, PYTHONPATH: BRIDGE_SRC },
    },
  })
  const arm = createDspyRepairArm({
    engine,
    limits: { maxIterations: 12, maxLlmCalls: 8, maxToolCalls: 48, maxOutputChars: 10_000 },
    costLedger,
    costPhase: 'analysis',
    analystId: ARM_ID,
    id: ARM_ID,
    log: (message) => log(`${evidence.rowId} ${message}`),
  })

  const started = Date.now()
  const controller = new AbortController()
  const deadline = setTimeout(() => controller.abort(), ROW_DEADLINE_MS)
  let answer
  try {
    answer = await askRepairArm({ arm, row: decision.row, signal: controller.signal })
  } catch (error) {
    const wallMs = Date.now() - started
    log(`${evidence.rowId} ${ARM_ID} threw after ${wallMs}ms: ${(error as Error).message}`)
    return {
      ...emptyRecord(evidence.rowId, 0),
      status: 'failed',
      failure: `arm threw: ${(error as Error).message}`.slice(0, 300),
      wallMs,
    }
  } finally {
    clearTimeout(deadline)
  }

  const { reply } = answer
  // Provider-reported tokens and spend from the ledger the model-execution
  // owner writes, not an estimate re-derived here. A row the ledger could not
  // price is recorded as null so it reads as uncaptured, never as $0.
  const ledger = costLedger.summary()
  const priced = ledger.fullyPriced && ledger.accountingComplete
  if (!priced) {
    log(
      `${evidence.rowId} ${ARM_ID} cost incomplete: ${ledger.incompleteReasons.slice(0, 2).join('; ')}`,
    )
  }
  const usage = {
    calls: reply.usage.calls,
    inputTokens: ledger.usageComplete ? ledger.inputTokens : null,
    outputTokens: ledger.usageComplete ? ledger.outputTokens : null,
    bridgeEstimated: false,
  }
  const costUsd = priced ? ledger.totalCostUsd : null
  const base = {
    ...emptyRecord(evidence.rowId, 0),
    wallMs: answer.wallMs,
    usage,
    costUsd,
    repairAttempted: reply.repair.attempted,
    repairSucceeded: reply.repair.succeeded,
    rejected: reply.rejectedRows.map((row) => ({ index: row.index, reason: row.reason })),
    answer: reply.answer,
  }

  if (reply.status === 'failed') {
    log(`${evidence.rowId} ${ARM_ID} failed: ${reply.failure.slice(0, 160)}`)
    return { ...base, status: 'failed', failure: reply.failure.slice(0, 300) }
  }
  if (reply.status === 'declined') {
    log(`${evidence.rowId} ${ARM_ID} declined ${answer.wallMs}ms ${money(costUsd)}`)
    return { ...base, status: 'declined', reportedRows: reply.reportedRows }
  }
  const actionBytes = Buffer.byteLength(reply.intervention.action)
  const budget = answer.budget
  log(
    `${evidence.rowId} ${ARM_ID} finding k=${reply.k} bytes=${actionBytes} ` +
      `budget=${budget?.admissible === false ? budget.violation : 'ok'} ` +
      `calls=${String(reply.usage.calls)} ${answer.wallMs}ms ${money(costUsd)}`,
  )
  return {
    ...base,
    status: 'finding',
    k: reply.k,
    failureClaim: reply.failureClaim,
    interventionKind: reply.intervention.kind,
    action: reply.intervention.action,
    actionBytes,
    reportedRows: reply.reportedRows,
  }
}

/**
 * Answers already paid for, keyed by row.
 *
 * The arm persists each answer the moment it returns, so a run that dies
 * mid-arm keeps what the money bought. Reissuing a row the model already
 * answered would both spend twice and hand that row a second attempt the other
 * arms never got, so a recorded answer is never re-asked.
 */
function loadPaidAnswers(path: string): Map<string, AnswerRecord> {
  const paid = new Map<string, AnswerRecord>()
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return paid
  }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    const record = JSON.parse(line) as AnswerRecord
    paid.set(record.rowId, record)
  }
  return paid
}

async function main(): Promise<void> {
  const bearer = process.env.ZAI_API_KEY
  if (!bearer) throw new Error('ZAI_API_KEY is required for the dspy arm')
  const outDir = process.env.TBR_OUT ?? join(WORK, 'out')
  const admitPath = process.env.TBR_ADMIT ?? join(outDir, 'admit.json')
  const admit = JSON.parse(readFileSync(admitPath, 'utf8')) as {
    records: { rowId: string; admitted: boolean; evidence: LegacyAdmissionEvidence | null }[]
  }
  const subsetFile = process.env.TBR_ROW_SUBSET
  const subset = subsetFile ? new Set(JSON.parse(readFileSync(subsetFile, 'utf8')) as string[]) : null
  const rows = admit.records
    .filter((record) => record.admitted && record.evidence !== null)
    .filter((record) => subset === null || subset.has(record.rowId))
  const concurrency = Number(process.env.TBR_ANALYST_CONCURRENCY ?? '3')
  const destination = process.env.TBR_ANSWERS_OUT ?? join(outDir, 'answers-dspy-repair.json')

  mkdirSync(outDir, { recursive: true })
  const logPath = join(outDir, 'm3-dspy.log')
  const journalPath = process.env.TBR_ANSWER_JOURNAL ?? `${destination}l`
  const log = makeLogger((line) => writeFileSync(logPath, line, { flag: 'a' }))

  const paid = loadPaidAnswers(journalPath)
  const pending = rows.filter((record) => !paid.has(record.rowId))
  log(
    `phase=m3-dspy rows=${rows.length} alreadyPaid=${paid.size} pending=${pending.length} ` +
      `concurrency=${concurrency} maxCostUsd=${MAX_COST_USD}`,
  )
  if (pending.length === 0) log('every row is already answered; no model call is made')

  const started = Date.now()
  const release = await acquireSeat('tb-repair-m3-dspy', log)
  const onSignal = (): void => {
    release()
    process.exit(130)
  }
  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onSignal)

  const opening = await probeZaiSeat(bearer)
  log(
    `carrier open: ok=${opening.ok} status=${String(opening.status)} ${opening.wallMs}ms ` +
      `echoed=${opening.echoedModel ?? 'none'} selfReport=${opening.selfReport ?? 'none'}`,
  )
  if (!opening.ok) {
    release()
    throw new Error(`the seat is not answering: ${opening.detail}`)
  }

  try {
    await mapLimit(pending, concurrency, async (record) => {
      const answer = await askRow(record.evidence!, bearer, log)
      // Persisted the moment it exists. A run killed after this line keeps the
      // answer it paid for; a rerun reads it back and never re-asks the row.
      writeFileSync(journalPath, `${JSON.stringify(answer)}\n`, { flag: 'a' })
      return answer
    })
  } finally {
    release()
  }
  const answers = [...loadPaidAnswers(journalPath).values()].filter((answer) =>
    rows.some((record) => record.rowId === answer.rowId),
  )

  const findings = answers.filter((a) => a.status === 'finding').length
  const declined = answers.filter((a) => a.status === 'declined').length
  const failed = answers.filter((a) => a.status === 'failed').length
  const cost = answers.reduce((sum, a) => sum + (a.costUsd ?? 0), 0)
  log(
    `arm=${ARM_ID} findings=${findings}/${answers.length} declined=${declined} failed=${failed} ` +
      `cost=$${cost.toFixed(4)} wall=${Math.round((Date.now() - started) / 1000)}s`,
  )
  writeFileSync(
    destination,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        arms: [
          {
            id: ARM_ID,
            url: 'https://api.z.ai/api/coding/paas/v4/chat/completions',
            model: 'glm-5.2',
            concurrency,
            execution: 'DSPy RLM program with a typed repair signature and a code environment',
          },
        ],
        answers,
      },
      null,
      2,
    ),
  )
}

main().catch((error) => {
  process.stderr.write(`${(error as Error).stack}\n`)
  process.exit(1)
})
