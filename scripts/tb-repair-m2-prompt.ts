/**
 * The one prompt every analyst arm answers.
 *
 * The arms differ in what EXECUTES the prompt — a single chat completion, the
 * prime agent harness, or a DSPy RLM code loop — and in nothing else. Sharing
 * one prompt module is what makes the comparison an ablation of the harness
 * rather than a comparison of two prompts.
 *
 * The execution environment is stated, not hinted. mini-swe-agent runs every
 * action in a fresh `/bin/sh`, which is dash on these images, and takes exactly
 * one top-level statement per action. An analyst that does not know that writes
 * bash-only syntax and dies at execution for a reason that has nothing to do
 * with whether it localized the failure. Telling it the shell leaks no label:
 * the held-out suite, the control rates and the end-state verdict stay out.
 */

import type { BlindedTrajectoryPrefix } from '../src/trace-repair'

export const REPAIR_QUESTION =
  'This coding agent ran and did not finish the task. Name the ONE recorded step whose action you would replace, and give the single shell action to run instead of it.'

export const REPAIR_TASK_POLICY = [
  'You are given a task statement and the complete recorded trajectory of an agent that attempted it and failed.',
  'Your answer is executed. The action you return is run inside the real task container, at the point in the trajectory you name, and the task\'s held-out test suite is then run against the resulting state. You are scored on whether the suite passes, never on how your explanation reads.',
  '',
  'HOW YOUR ACTION IS EXECUTED — read this before writing it:',
  '- The action runs in a FRESH `/bin/sh`, which is dash on this image, not bash. C-style `for ((i=0;i<n;i++))`, `[[ ]]`, arrays, and `local` are bash-only and will fail with a syntax error.',
  '- The scaffold accepts exactly ONE top-level statement. Wrap multiple commands in a single `{ ...; }` block or chain them with `&&`.',
  '- The action is at most 4 KB, and must not be a no-op such as `true`, `:` or an empty string.',
  '- It runs from the task working directory, as root, with the network available.',
  '- Prefer writing a complete correct file with a heredoc over patching in place; you cannot see the result of your own action, so it must work on the first attempt.',
  '',
  'Name the step whose action you would replace as `k`, using the step_id shown in the trajectory. Choosing the last step means "instead of the last thing the agent did, do this". You are not repairing the agent\'s reasoning; you are producing the state the suite requires.',
  'Return no finding only when no single replacement action could plausibly make the suite pass.',
] as const

export const REPAIR_CONTRACT_LINES = [
  'OUTPUT CONTRACT — reply with ONE fenced JSON object and nothing else:',
  '```json',
  '{"answer": "<one sentence on what went wrong>", "findings": [{"k": <int>, "failure_claim": "<what went wrong at step k>", "intervention": {"kind": "shell", "action": "<the single shell action to run instead>"}}]}',
  '```',
  'Rules:',
  '- `findings` carries AT MOST ONE object. Never more.',
  '- `k` is an integer step_id present in the trajectory below.',
  '- `failure_claim` is a non-empty string. It is recorded and never scored, so spend your effort on the action.',
  '- `intervention.kind` is the string "shell".',
  '- `intervention.action` is the exact shell text to execute. It is not a description and not a diff.',
  '- Return `"findings": []` only to say that no single action could repair this run.',
] as const

export const REPAIR_REPAIR_CONTRACT_LINES = [
  'Your previous reply did not satisfy the output contract. Resend the answer, and nothing else, as ONE fenced JSON object:',
  '```json',
  '{"answer": "<one sentence>", "findings": [{"k": <int>, "failure_claim": "<string>", "intervention": {"kind": "shell", "action": "<shell text>"}}]}',
  '```',
  '`findings` carries at most one object. Do not restate the trajectory.',
] as const

/** The trajectory as the analyst sees it: actions, observations, nothing about grading. */
export function renderTrajectory(prefix: BlindedTrajectoryPrefix): string {
  return prefix.steps
    .map((step) => {
      const observation = step.observation === null ? '(no observation recorded)' : step.observation
      return [
        `--- step_id ${step.step_id} ---`,
        'ACTION:',
        step.action,
        'OBSERVATION:',
        observation,
      ].join('\n')
    })
    .join('\n\n')
}

export function trajectoryHeader(prefix: BlindedTrajectoryPrefix): string {
  return `RECORDED TRAJECTORY (${prefix.steps.length} steps; valid k is any step_id below, the last is ${prefix.maxK}):`
}
