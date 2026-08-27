/**
 * Milestone 2, phase 2b: the DSPy RLM arm.
 *
 * The incumbent analyst is a DSPy RLM — a Python code loop that queries the
 * trajectory through bounded tools and returns findings. That ENGINE runs here
 * unchanged.
 *
 * What does NOT carry over is its GEPA-certified instruction text. That text is
 * certified for the CodeTraceBench incorrect-step task: it names blocks,
 * `first_step`/`last_step`/`consequence_step`, escape status, and `step-<n>`
 * span selection, and it never produces an executable action. TB-Repair asks a
 * different question under a different grammar, so the certified text cannot be
 * transplanted and this arm is labelled for what it is: the DSPy RLM engine on
 * the repair contract, not the certified artifact.
 *
 * The engine's own finding schema is kept and mapped at the boundary, the same
 * way the CodeTraceBench runner maps rows onto blocks:
 *
 *   subject             `step-<k>`, the step whose action is replaced
 *   claim               the failure claim
 *   recommended_action  the shell action executed at k
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createDspyRlmTraceEngine } from '../src/analyst/dspy-rlm-engine'
import { testModelExecutionOwner } from '../src/analyst/model-execution.test-support'
import { CostLedger } from '../src/cost-ledger'
import { TRACE_ANALYST_TOOL_NAMESPACE } from '../src/trace-analyst/tools'
import type { TraceAnalysisToolDescriptor } from '../src/trace-analyst/tools'
import { type AdmissionEvidence, admitRow, blindTrajectory } from '../src/trace-repair'
import type { AnswerRecord } from './tb-repair-m2-analyze'
import { acquireSeat, makeLogger, mapLimit, WORK } from './tb-repair-m2-lib'
import { REPAIR_QUESTION, REPAIR_TASK_POLICY } from './tb-repair-m2-prompt'

const GLM_PRICING = { inputUsdPerMillion: 0.6, outputUsdPerMillion: 2.2 }
const VENV_PYTHON = '/home/drew/code/agent-eval/clients/python/.venv/bin/python'

/** The repair contract restated for the engine's own findings schema. */
const DSPY_INSTRUCTIONS = [
  ...REPAIR_TASK_POLICY,
  '',
  'Read the trajectory with the supplied tools. `list_steps` returns every step_id with its action; `view_step` returns one step in full, including its observation.',
  '',
  'Return AT MOST ONE finding, shaped as:',
  '- subject: "step-<k>", where <k> is the step_id whose action you replace.',
  '- claim: what went wrong at step k.',
  '- recommended_action: the EXACT shell text to run instead. Not a description, not a diff, not a plan. This string is executed verbatim.',
  '- severity: "high". confidence: your confidence from 0 to 1.',
  '- evidence: one entry whose uri is "step-<k>" and whose excerpt quotes the step you are replacing.',
  'Return an empty findings array only when no single replacement action could make the suite pass.',
].join('\n')

interface TrajectoryStep {
  step_id: number
  action: string
  observation: string | null
}

function trajectoryTools(steps: readonly TrajectoryStep[]): TraceAnalysisToolDescriptor[] {
  return [
    {
      namespace: TRACE_ANALYST_TOOL_NAMESPACE,
      name: 'list_steps',
      description: 'Every recorded step: its step_id and the action the agent ran.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      handler: async () => ({
        steps: steps.map((s) => ({ step_id: s.step_id, action: s.action })),
        count: steps.length,
      }),
    },
    {
      namespace: TRACE_ANALYST_TOOL_NAMESPACE,
      name: 'view_step',
      description: 'One recorded step in full, including the observation it produced.',
      parameters: {
        type: 'object',
        properties: { step_id: { type: 'integer' } },
        required: ['step_id'],
        additionalProperties: false,
      },
      handler: async (args) => {
        const id = (args as { step_id?: unknown }).step_id
        const step = steps.find((s) => s.step_id === id)
        if (!step) return { error: `no step_id ${String(id)}; valid: ${steps.map((s) => s.step_id).join(', ')}` }
        return step
      },
    },
  ]
}

/** `step-<k>` in the engine's subject or evidence uri. */
function stepFromSubject(value: unknown): number | null {
  if (typeof value !== 'string') return null
  const m = /step[-_ ]?(\d+)/i.exec(value)
  return m ? Number(m[1]) : null
}

async function askDspy(
  evidence: AdmissionEvidence,
  bearer: string,
  log: (m: string) => void,
): Promise<AnswerRecord> {
  const decision = admitRow(evidence)
  if (!decision.admitted) throw new Error(`${evidence.rowId} is not admitted`)
  const prefix = blindTrajectory(decision.row)
  const steps = prefix.steps.map((s) => ({ step_id: s.step_id, action: s.action, observation: s.observation }))
  const costLedger = new CostLedger()
  const owner = testModelExecutionOwner({
    // z.ai directly, the same upstream the other two arms answer from, so the
    // three-way contrast is the harness and not the provider. The router is not
    // used here: its edge closes a slow non-streaming completion with HTTP 524.
    baseUrl: 'https://api.z.ai/api/coding/paas/v4',
    bearer,
    fetchImpl: fetch,
    pricing: GLM_PRICING,
    callRef: 'tb-repair-m2:zai:glm-5.2',
  })
  const engine = createDspyRlmTraceEngine({
    call: owner.call,
    callRef: owner.callRef,
    recordExecution: owner.recordExecution,
    model: 'glm-5.2',
    pricing: GLM_PRICING,
    // Per-row ceiling chosen so the whole arm stays inside the campaign budget:
    // 0.10 x 20 held rows caps this arm at $2 against a measured prime arm of $0.41/row.
    maxCostUsd: 0.10,
    timeoutMs: 900_000,
    runner: { command: VENV_PYTHON },
  })
  const startedMs = Date.now()
  const base = {
    rowId: evidence.rowId,
    arm: 'dspy-rlm',
    promptChars: DSPY_INSTRUCTIONS.length + prefix.taskStatement.length,
    rejected: [] as { index: number; reason: string }[],
  }
  const fail = (reason: string, wallMs: number): AnswerRecord => ({
    ...base,
    status: 'failed',
    failure: reason,
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
    costUsd: costLedger.summary().totalCostUsd,
    wallMs,
  })
  let result
  try {
    result = await engine.analyze({
      analystId: 'tb-repair-m2-dspy',
      question: [
        REPAIR_QUESTION,
        '',
        'TASK STATEMENT GIVEN TO THE AGENT:',
        prefix.taskStatement,
        '',
        `The trajectory has ${steps.length} recorded steps, step_ids ${steps.map((s) => s.step_id).join(', ')}. Read them with list_steps and view_step.`,
      ].join('\n'),
      instructions: DSPY_INSTRUCTIONS,
      tools: trajectoryTools(steps),
      limits: { maxIterations: 14, maxLlmCalls: 8, maxToolCalls: 80, maxOutputChars: 8_000 },
      costLedger,
      costPhase: 'tb-repair-milestone2',
    })
  } catch (error) {
    const wallMs = Date.now() - startedMs
    log(`${evidence.rowId} dspy-rlm FAILED ${(error as Error).message.slice(0, 200)}`)
    return fail(`thrown: ${(error as Error).message}`, wallMs)
  }
  const wallMs = Date.now() - startedMs
  const costUsd = costLedger.summary().totalCostUsd
  const finding = result.findings[0]
  if (finding === undefined) {
    log(`${evidence.rowId} dspy-rlm declined (modelCalls=${result.modelCalls} toolCalls=${result.toolCalls})`)
    return {
      ...base,
      status: 'declined',
      failure: null,
      k: null,
      failureClaim: null,
      interventionKind: null,
      action: null,
      actionBytes: null,
      answer: result.answer,
      reportedRows: 0,
      repairAttempted: false,
      repairSucceeded: null,
      usage: { calls: result.modelCalls, inputTokens: null, outputTokens: null, bridgeEstimated: false },
      costUsd,
      wallMs,
    }
  }
  const record = finding as unknown as Record<string, unknown>
  const k =
    stepFromSubject(record.subject) ??
    stepFromSubject((record.evidence as { uri?: unknown }[] | undefined)?.[0]?.uri)
  const action = typeof record.recommended_action === 'string' ? record.recommended_action : null
  if (k === null || action === null || action.trim().length === 0) {
    log(`${evidence.rowId} dspy-rlm unusable finding (k=${String(k)} action=${action === null ? 'null' : 'empty'})`)
    return {
      ...fail(
        `finding missing ${k === null ? 'a step-<k> subject' : 'a recommended_action'}; the engine answered but not under the repair contract`,
        wallMs,
      ),
      answer: result.answer,
      reportedRows: result.findings.length,
    }
  }
  log(`${evidence.rowId} dspy-rlm finding k=${k} bytes=${Buffer.byteLength(action)} ${wallMs}ms $${costUsd?.toFixed(4) ?? '?'}`)
  return {
    ...base,
    status: 'finding',
    failure: null,
    k,
    failureClaim: typeof record.claim === 'string' ? record.claim : 'the recorded run did not satisfy the task',
    interventionKind: 'shell',
    action,
    actionBytes: Buffer.byteLength(action),
    answer: result.answer,
    reportedRows: result.findings.length,
    repairAttempted: false,
    repairSucceeded: null,
    usage: { calls: result.modelCalls, inputTokens: null, outputTokens: null, bridgeEstimated: false },
    costUsd,
    wallMs,
  }
}

async function main(): Promise<void> {
  const bearer = process.env.ZAI_API_KEY
  if (!bearer) throw new Error('ZAI_API_KEY is required for the dspy-rlm arm')
  const outDir = process.env.TBR_OUT ?? join(WORK, 'out')
  const admit = JSON.parse(readFileSync(join(outDir, 'admit.json'), 'utf8')) as {
    records: { rowId: string; admitted: boolean; evidence: AdmissionEvidence | null }[]
  }
  const subsetFile = process.env.TBR_ROW_SUBSET
  const subset = subsetFile ? new Set(JSON.parse(readFileSync(subsetFile, 'utf8')) as string[]) : null
  const admitted = admit.records
    .filter((r) => r.admitted && r.evidence !== null)
    .filter((r) => subset === null || subset.has(r.rowId))
  const concurrency = Number(process.env.TBR_ANALYST_CONCURRENCY ?? '3')
  mkdirSync(outDir, { recursive: true })
  const logPath = join(outDir, 'dspy.log')
  writeFileSync(logPath, '')
  const log = makeLogger((line) => writeFileSync(logPath, line, { flag: 'a' }))
  log(`phase=dspy rows=${admitted.length} concurrency=${concurrency}`)
  const started = Date.now()
  const release = await acquireSeat('tb-repair-m2-dspy', log)
  let answers
  try {
    answers = await mapLimit(admitted, concurrency, (record) => askDspy(record.evidence!, bearer, log))
  } finally {
    release()
  }
  const findings = answers.filter((a) => a.status === 'finding').length
  const cost = answers.reduce((sum, a) => sum + (a.costUsd ?? 0), 0)
  log(
    `arm=dspy-rlm findings=${findings}/${answers.length} declined=${answers.filter((a) => a.status === 'declined').length} failed=${answers.filter((a) => a.status === 'failed').length} cost=$${cost.toFixed(4)} wall=${Math.round((Date.now() - started) / 1000)}s`,
  )
  writeFileSync(
    join(outDir, 'answers-dspy.json'),
    JSON.stringify({ generatedAt: new Date().toISOString(), answers }, null, 2),
  )
}

main().catch((error) => {
  process.stderr.write(`${(error as Error).stack}\n`)
  process.exit(1)
})
