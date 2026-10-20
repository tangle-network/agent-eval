import { injectedTestOracle, MINI_SWE_SYSTEM_MESSAGE, parseAction, renderFormatErrorObservation, renderInstanceMessage, renderObservation, renderTimeoutObservation, submissionOf } from '../../src/trace-repair'
import { parseRecordedReturncode } from '../../src/trajectory-replay/steps'
import { PRICING, STEP_TIMEOUT_SECONDS, REPLAY_TIMEOUT_MS, GRADE_TIMEOUT_MS } from './settings'
import { type CorpusRow } from './corpus'
import { type TaskFixture, openContainer } from './container'
import { callModel } from './model'

// ── One row, one arm ─────────────────────────────────────────────────

interface StepRecord {
  step: number
  servedModel: string
  promptTokens: number
  completionTokens: number
  action: string | null
  formatError: boolean
  submitted: boolean
  returncode: number | null
  gradePassed: boolean
  gradeMs: number
  stepMs: number
}

export interface RowRun {
  rowId: string
  taskName: string
  arm: string
  replayedCommands: number
  replayDivergences: number
  endStatePassed: boolean
  steps: StepRecord[]
  passedAtStep: number | null
  bestPassed: boolean
  promptTokens: number
  completionTokens: number
  costUsd: number
  wallMs: number
  error: string | null
}

interface RunRowOptions {
  row: CorpusRow
  task: TaskFixture
  arm: string
  /** Model steps this run may spend. */
  allotment: number
  /** Stop the moment the held-out check passes. */
  stopOnPass: boolean
  log: (line: string) => void
}

export async function runRow(options: RunRowOptions): Promise<RowRun> {
  const { row, task, arm, allotment, stopOnPass, log } = options
  const startedMs = Date.now()
  const oracle = injectedTestOracle({
    files: task.suite,
    command:
      'chmod +x /tests/test.sh; rm -f /logs/verifier/reward.txt; ' +
      '(/tests/test.sh) > /logs/verifier/test-stdout.txt 2>&1; ' +
      'grep -qx 1 /logs/verifier/reward.txt',
    purge: ['/tests'],
    commandTimeoutMs: GRADE_TIMEOUT_MS,
  })
  const record: RowRun = {
    rowId: row.rowId,
    taskName: row.taskName,
    arm,
    replayedCommands: 0,
    replayDivergences: 0,
    endStatePassed: false,
    steps: [],
    passedAtStep: null,
    bestPassed: false,
    promptTokens: 0,
    completionTokens: 0,
    costUsd: 0,
    wallMs: 0,
    error: null,
  }
  const session = await openContainer(task, `${arm}-${row.taskName}`.slice(0, 40))
  try {
    const messages: { role: string; content: string }[] = [
      { role: 'system', content: MINI_SWE_SYSTEM_MESSAGE },
      { role: 'user', content: renderInstanceMessage({ task: task.instruction, systemInformation: 'Linux x86_64' }) },
    ]
    for (const step of row.steps) {
      const result = await session.exec2(step.action, REPLAY_TIMEOUT_MS)
      record.replayedCommands += 1
      const recorded = parseRecordedReturncode(step.observation)
      if (recorded !== result.returncode) record.replayDivergences += 1
      messages.push({ role: 'assistant', content: `Replaying the recorded step.\n\n\`\`\`bash\n${step.action}\n\`\`\`` })
      messages.push({
        role: 'user',
        content: result.timedOut
          ? renderTimeoutObservation(step.action, result.output.slice(0, 2000))
          : renderObservation({ returncode: result.returncode, output: result.output }),
      })
    }
    // The oracle context takes the substrate's arm vocabulary, which names the
    // container state under test: the recorded end state before any step of
    // this study, and an intervened state after one. This study's own arm
    // label rides on the record below.
    const endState = await oracle.grade(session, { rowId: row.rowId, arm: 'end-state', rolloutIndex: 0 })
    record.endStatePassed = endState.passed
    log(`${row.rowId} ${arm} replayed=${record.replayedCommands} divergences=${record.replayDivergences} endStatePassed=${endState.passed}`)

    let consecutiveFormatErrors = 0
    for (let step = 1; step <= allotment; step += 1) {
      const stepStarted = Date.now()
      const reply = await callModel(messages)
      record.promptTokens += reply.promptTokens
      record.completionTokens += reply.completionTokens
      messages.push({ role: 'assistant', content: reply.content })
      const parsed = parseAction(reply.content)
      let returncode: number | null = null
      let submitted = false
      let action: string | null = null
      if (parsed.kind === 'format-error') {
        consecutiveFormatErrors += 1
        messages.push({ role: 'user', content: renderFormatErrorObservation(parsed.actionCount) })
      } else {
        consecutiveFormatErrors = 0
        action = parsed.command
        const result = await session.exec2(parsed.command, STEP_TIMEOUT_SECONDS * 1000)
        returncode = result.returncode
        submitted = submissionOf({ returncode: result.returncode, output: result.output }) !== null
        messages.push({
          role: 'user',
          content: result.timedOut
            ? renderTimeoutObservation(parsed.command, result.output.slice(0, 2000))
            : renderObservation({ returncode: result.returncode, output: result.output }),
        })
      }
      const gradeStarted = Date.now()
      const graded = await oracle.grade(session, { rowId: row.rowId, arm: 'intervention', rolloutIndex: step })
      const gradeMs = Date.now() - gradeStarted
      if (graded.passed && record.passedAtStep === null) record.passedAtStep = step
      record.bestPassed = record.bestPassed || graded.passed
      record.steps.push({
        step,
        servedModel: reply.servedModel,
        promptTokens: reply.promptTokens,
        completionTokens: reply.completionTokens,
        action,
        formatError: parsed.kind === 'format-error',
        submitted,
        returncode,
        gradePassed: graded.passed,
        gradeMs,
        stepMs: Date.now() - stepStarted,
      })
      log(
        `${row.rowId} ${arm} step=${step}/${allotment} passed=${graded.passed} rc=${returncode} ` +
          `tokens=${reply.promptTokens}+${reply.completionTokens} gradeMs=${gradeMs}`,
      )
      if (graded.passed && stopOnPass) break
      if (consecutiveFormatErrors >= 3) {
        record.error = 'three consecutive format errors'
        break
      }
    }
  } catch (error) {
    record.error = (error as Error).message
    log(`${row.rowId} ${arm} ERROR ${record.error}`)
  } finally {
    await session.close()
  }
  record.costUsd =
    (record.promptTokens / 1e6) * PRICING.inputUsdPerMillion +
    (record.completionTokens / 1e6) * PRICING.outputUsdPerMillion
  record.wallMs = Date.now() - startedMs
  return record
}
