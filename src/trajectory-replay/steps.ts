/**
 * Recorded shell-trajectory steps and the observation grammar they carry.
 *
 * A recorded trajectory is the action/observation sequence an agent actually
 * ran. Scaffolds that execute one shell command per step (mini-SWE and the
 * CodeTracer-normalized corpora built from it) tag each observation with the
 * command's returncode and its combined output:
 *
 *     <returncode>2</returncode>
 *     <output>
 *     …command output…
 *     </output>
 *
 * That is one of four shapes a recorded turn carries, and the other three are
 * not command results at all:
 *
 *   - a timeout notice, when the environment killed the command at its bound;
 *   - a format-error notice, when the scaffold rejected the turn and ran
 *     nothing;
 *   - an elision marker `$<hex>`, when the published dump dropped the string.
 *
 * A turn also carries no observation when it is the run's last turn, because
 * the scaffold records an observation only when it hands one back to the model.
 *
 * The parsers here are the only place that grammar is decoded. Everything
 * downstream — replay verdicts, corpus enumeration, admission funnels, fix
 * prompts — reads the returncode, the output, and the failure signature through
 * these functions. A second decoder elsewhere is how a corpus reads as
 * unreplayable when it is not.
 */

/**
 * One step of a recorded shell trajectory. Structural: any richer step record
 * (file refs, thinking text, tool type) satisfies it.
 */
export interface RecordedTrajectoryStep {
  /** 1-based position in the trajectory. */
  readonly step_id: number
  readonly action: string
  /** Null when the step recorded no observation (terminal submit steps). */
  readonly observation: string | null
}

/** Recorded returncode of a step, or null when the observation carries none. */
export function parseRecordedReturncode(observation: string | null): number | null {
  if (!observation) return null
  const m = /<returncode>(-?\d+)<\/returncode>/.exec(observation)
  return m ? Number(m[1]) : null
}

/** Text between the observation's <output> tags, or the raw observation when
 *  the tags are absent. */
export function parseObservationOutput(observation: string | null): string {
  if (!observation) return ''
  const m = /<output>\n?([\s\S]*?)\n?<\/output>/.exec(observation)
  return m ? m[1]! : observation
}

/**
 * Stable failure-signature candidate: the first line of the recorded output
 * that contains the word "error". Null when no such line exists — a verdict
 * then falls back to returncode-only matching and says so.
 * Pass an explicit signature to override (compiler quote glyphs vary with
 * locale, so a hand-picked ASCII substring is often more robust).
 */
export function deriveFailureSignature(observation: string | null): string | null {
  const line = parseObservationOutput(observation)
    .split('\n')
    .find((l) => /\berror\b/i.test(l))
  return line ? line.trim().slice(0, 200) : null
}

/** mini-SWE's end-of-run submit convention: the agent echoes this sentinel
 *  and dumps the diff. A label on this step marks a bad SUBMIT DECISION, not a
 *  failed command — there is no executable failure to reproduce, so it is
 *  never a counterfactual replay target. */
export const SUBMIT_ACTION_SIGNATURE = 'COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT'

export function isSubmitAction(action: string): boolean {
  return action.includes(SUBMIT_ACTION_SIGNATURE)
}

/**
 * True when the action is the sentinel echo and nothing else.
 *
 * The distinction decides whether a step may be dropped. An agent is told to
 * issue the sentinel alone, and 5.7% of recorded runs end on a command that
 * writes files or edits them and then echoes it. Dropping such a step because
 * it holds the sentinel would remove the run's last state change from the
 * replay, so the recorded end state and the replayed one would differ.
 */
export function isSubmitOnlyAction(action: string): boolean {
  return /^echo\s+(?:"COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT"|'COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT'|COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT)$/.test(
    action.trim(),
  )
}

// ── Fields the published dump dropped ────────────────────────────────

/**
 * A field the dump replaced with a counter instead of its text.
 *
 * The counter is hexadecimal and rises by one per dropped string in document
 * order, so a decimal-only reading (`$12`) accepts every marker that carries a
 * letter (`$3a`) as if it were real text. A command read that way replays as
 * the literal two-to-four characters `$3a`, which is not the command the run
 * executed.
 *
 * Nothing in the dump maps a marker back to its text: the same marker carries
 * different content in different rows, so there is no dictionary to read. A
 * field that matches is unrecoverable, and the row that holds it is rejected.
 */
export const RECORDED_ELISION_PATTERN = /^\$[0-9a-f]+$/

export function isElidedField(value: string | null | undefined): boolean {
  return typeof value === 'string' && RECORDED_ELISION_PATTERN.test(value)
}

// ── Observation grammar ──────────────────────────────────────────────

/** Substring the timeout notice always carries, whatever the command was. */
export const TIMEOUT_OBSERVATION_MARKER = 'timed out and has been killed'

/** Opening of the notice the scaffold writes when a turn held no single action. */
export const FORMAT_ERROR_OBSERVATION_PREFIX =
  'Please always provide EXACTLY ONE action in triple backticks, found '

/**
 * What a recorded observation is.
 *
 * `command-result` is the only kind that carries an exit status. `timeout` and
 * `format-error` are the scaffold speaking rather than a command: the first
 * says the environment killed the command, the second says no command ran at
 * all. `elided` and `absent` carry no information about the step, and
 * `unreadable` is a shape this grammar does not know — never assumed to be
 * anything.
 */
export type RecordedObservationKind =
  | 'command-result'
  | 'timeout'
  | 'format-error'
  | 'elided'
  | 'absent'
  | 'unreadable'

export function classifyObservation(observation: string | null): RecordedObservationKind {
  if (observation === null) return 'absent'
  if (isElidedField(observation)) return 'elided'
  if (parseRecordedReturncode(observation) !== null) return 'command-result'
  if (observation.startsWith(FORMAT_ERROR_OBSERVATION_PREFIX)) return 'format-error'
  if (observation.includes(TIMEOUT_OBSERVATION_MARKER)) return 'timeout'
  return 'unreadable'
}

/** True when the recording shows the environment killed this step at its
 *  wall-clock bound. Such a step carries no returncode, so no replay can
 *  confirm or contradict it. */
export function isRecordedTimeout(observation: string | null): boolean {
  return classifyObservation(observation) === 'timeout'
}

// ── Turns to steps ───────────────────────────────────────────────────

/**
 * One turn as the published trajectory dump holds it.
 *
 * A turn is not a step: the system prompt, the task statement and every turn
 * the scaffold rejected are turns that executed nothing.
 */
export interface RecordedTrajectoryTurn {
  readonly src?: string | null
  readonly msg?: string | null
  readonly tools?: readonly { readonly cmd?: string | null }[] | null
  readonly obs?: string | null
}

export interface DecodedTrajectory {
  /** Executed commands in recorded order, each holding its OWN observation. */
  readonly steps: readonly RecordedTrajectoryStep[]
  /** Turns the scaffold rejected before anything ran. */
  readonly formatErrorTurns: number
  /** Executed commands whose text the dump dropped. Any at all blocks replay. */
  readonly elidedCommands: number
  /** True when the run's last turn was the submit sentinel with no observation. */
  readonly endedOnSubmitSentinel: boolean
  /** Turns carrying an observation this grammar cannot read. */
  readonly unreadableTurns: number
}

/**
 * Pair every recorded command with the observation of its own turn.
 *
 * Collecting commands and observations into two lists and zipping them is the
 * decode that looks right and is not: a turn the scaffold rejected carries an
 * observation of its own, so from the first such turn onward every observation
 * belongs to a different command than the one it is read against.
 *
 * A rejected turn executed nothing, so it is never a step — including when the
 * dump recorded a command for it. The scaffold rejects a turn holding several
 * bash blocks and runs none of them, while the dump keeps one of the blocks in
 * the command field. Replaying that field would execute a command the recorded
 * run did not, which is a worse corpus than a smaller one.
 *
 * A trailing step that echoes the sentinel and nothing else, with no
 * observation, is dropped from `steps` and reported as `endedOnSubmitSentinel`.
 * The scaffold records an observation only when it hands one to the model, and
 * the sentinel ends the run, so the missing observation is the end of the
 * transcript rather than a gap in it. Echoing the sentinel changes no state, so
 * the recorded end state is the state the step before it left.
 *
 * A step that DID get an observation stays a step: the run continued past it.
 * So does a step that echoes the sentinel after doing real work — its state
 * change is part of the recorded end state, and with no observation its exit is
 * unknown, which `finalRecordedOutcome` reports rather than hides.
 */
export function decodeRecordedTurns(turns: readonly RecordedTrajectoryTurn[]): DecodedTrajectory {
  const steps: RecordedTrajectoryStep[] = []
  let formatErrorTurns = 0
  let unreadableTurns = 0
  for (const turn of turns) {
    const command = turn.tools?.[0]?.cmd ?? null
    const observation = turn.obs ?? null
    const kind = classifyObservation(observation)
    if (kind === 'format-error') {
      formatErrorTurns += 1
      continue
    }
    if (command === null) {
      if (kind === 'unreadable' || kind === 'elided') unreadableTurns += 1
      continue
    }
    steps.push({ step_id: steps.length + 1, action: command, observation })
  }
  const last = steps[steps.length - 1]
  const endedOnSubmitSentinel =
    last !== undefined && last.observation === null && isSubmitOnlyAction(last.action)
  if (endedOnSubmitSentinel) steps.pop()
  return {
    steps,
    formatErrorTurns,
    elidedCommands: steps.filter((step) => isElidedField(step.action)).length,
    endedOnSubmitSentinel,
    unreadableTurns,
  }
}

// ── The state a trajectory ended in ──────────────────────────────────

/**
 * How the recorded run's last executed command ended.
 *
 * `killed` is a measured outcome, not a missing one: the environment stopped
 * the command at its bound and wrote a notice instead of an exit status.
 * `unreadable` names the observation kind that blocked the read, so a funnel
 * can report which shape cost it the row.
 */
export type RecordedFinalOutcome =
  | { readonly kind: 'returncode'; readonly value: number }
  | { readonly kind: 'killed' }
  | { readonly kind: 'unreadable'; readonly reason: RecordedObservationKind }

/**
 * The outcome of the last step, or `null` when the trajectory has no steps.
 *
 * Reads only the last step. `decodeRecordedTurns` has already removed the turns
 * that executed nothing, so the last step is the last command the run ran.
 */
export function finalRecordedOutcome(
  steps: readonly RecordedTrajectoryStep[],
): RecordedFinalOutcome | null {
  const last = steps[steps.length - 1]
  if (last === undefined) return null
  const kind = classifyObservation(last.observation)
  if (kind === 'command-result') {
    return { kind: 'returncode', value: parseRecordedReturncode(last.observation)! }
  }
  if (kind === 'timeout') return { kind: 'killed' }
  return { kind: 'unreadable', reason: kind }
}

/**
 * Steps whose recorded exit a replay cannot check.
 *
 * A killed step counts: the recording holds no exit status to compare a replay
 * against, so agreement on it cannot be measured either way.
 */
export function unreadableExitCount(steps: readonly RecordedTrajectoryStep[]): number {
  return steps.filter((step) => classifyObservation(step.observation) !== 'command-result').length
}
