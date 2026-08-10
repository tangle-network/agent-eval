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
 * The parsers here are the only place that grammar is decoded. Everything
 * downstream — replay verdicts, corpus enumeration, fix prompts — reads the
 * returncode, the output, and the failure signature through these functions.
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
