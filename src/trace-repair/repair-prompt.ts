/**
 * The one question every repair arm answers.
 *
 * Arms differ in what EXECUTES the question — a single chat completion, an
 * agent harness, a DSPy program — and in nothing else. One prompt module is
 * what makes a comparison between them an ablation of the execution path
 * rather than a comparison of two prompts.
 *
 * The execution environment is stated, not hinted. The recorded scaffold runs
 * every action in a fresh `/bin/sh` and takes exactly one top-level statement,
 * so an arm that is not told that writes bash-only syntax and dies at
 * execution for a reason that has nothing to do with whether it localized the
 * failure. Stating the shell leaks no label: the held-out suite, the control
 * rates and the end-state verdict all stay out, and the prompt is built from a
 * `BlindedTrajectoryPrefix`, which cannot carry them.
 *
 * The action caps in the prose are read from the budget the grader enforces,
 * so the instruction and the rejection can never drift apart.
 */

import { createHash } from 'node:crypto'
import { type InterventionBudget, SCAFFOLD_INTERVENTION_BUDGET } from './action-budget'
import type { BlindedTrajectoryPrefix } from './blinding'

export const REPAIR_QUESTION =
  'This coding agent ran and did not finish the task. Name the ONE recorded step whose action you would replace, and give the single shell action to run instead of it.'

/**
 * The task definition. Parameterised by the budget so the stated caps are the
 * enforced caps.
 */
export function repairTaskPolicy(
  budget: InterventionBudget = SCAFFOLD_INTERVENTION_BUDGET,
): readonly string[] {
  return Object.freeze([
    'You are given a task statement and the complete recorded trajectory of an agent that attempted it and failed.',
    "Your answer is executed. The action you return is run inside the real task container, at the point in the trajectory you name, and the task's held-out test suite is then run against the resulting state. You are scored on whether the suite passes, never on how your explanation reads.",
    '',
    'HOW YOUR ACTION IS EXECUTED — read this before writing it:',
    '- The action runs in a FRESH `/bin/sh`, which is dash on this image, not bash. C-style `for ((i=0;i<n;i++))`, `[[ ]]`, arrays, and `local` are bash-only and will fail with a syntax error.',
    `- The scaffold accepts exactly ${budget.maxStatements === 1 ? 'ONE top-level statement' : `${budget.maxStatements} top-level statements`}. Wrap multiple commands in a single \`{ ...; }\` block or chain them with \`&&\`.`,
    `- The action is at most ${budget.maxBytes} bytes, and must not be a no-op such as \`true\`, \`:\` or an empty string.`,
    '- It runs from the task working directory, as root, with the network available.',
    '- Prefer writing a complete correct file with a heredoc over patching in place; you cannot see the result of your own action, so it must work on the first attempt.',
    'Name the step whose action you would replace as `k`, using the step_id shown in the trajectory. Choosing the last step means "instead of the last thing the agent did, do this". You are not repairing the agent\'s reasoning; you are producing the state the suite requires.',
    'Return no finding only when no single replacement action could plausibly make the suite pass.',
  ])
}

/** The reply grammar, stated to an arm that answers in one JSON object. */
export const REPAIR_CONTRACT_LINES: readonly string[] = Object.freeze([
  'OUTPUT CONTRACT — reply with ONE fenced JSON object and nothing else:',
  '```json',
  '{"answer": "<one sentence on what went wrong>", "findings": [{"k": <int>, "failure_claim": "<what went wrong at step k>", "intervention": {"kind": "shell", "action": "<the single shell action to run instead>"}}]}',
  '```',
  'Rules:',
  '- `findings` carries AT MOST ONE object. Never more.',
  '- `k` is an integer step_id present in the trajectory below.',
  '- `failure_claim` is a non-empty string. It is recorded and never scored, so spend your effort on the action.',
  '- `intervention.kind` is the string "shell", or "edit" when the action authors a file with a heredoc.',
  '- `intervention.action` is the exact shell text to execute. It is not a description and not a diff.',
  '- Return `"findings": []` only to say that no single action could repair this run.',
])

/** The same grammar restated for the bounded repair turn, which never carries
 *  the trajectory again. */
export const REPAIR_REPAIR_CONTRACT_LINES: readonly string[] = Object.freeze([
  'Your previous reply did not satisfy the output contract. Resend the answer, and nothing else, as ONE fenced JSON object:',
  '```json',
  '{"answer": "<one sentence>", "findings": [{"k": <int>, "failure_claim": "<string>", "intervention": {"kind": "shell", "action": "<shell text>"}}]}',
  '```',
  '`findings` carries at most one object. Do not restate the trajectory.',
])

/** The trajectory as an arm sees it: actions, observations, nothing about grading. */
export function renderRepairTrajectory(prefix: BlindedTrajectoryPrefix): string {
  return prefix.steps
    .map((step) =>
      [
        `--- step_id ${step.step_id} ---`,
        'ACTION:',
        step.action,
        'OBSERVATION:',
        step.observation === null ? '(no observation recorded)' : step.observation,
      ].join('\n'),
    )
    .join('\n\n')
}

export function repairTrajectoryHeader(prefix: BlindedTrajectoryPrefix): string {
  return `RECORDED TRAJECTORY (${prefix.steps.length} steps; valid k is any step_id below, the last is ${prefix.maxK}):`
}

/** The task definition an arm receives: the policy plus the statement the
 *  recorded agent was given. */
export function repairTaskDefinition(
  prefix: BlindedTrajectoryPrefix,
  budget: InterventionBudget = SCAFFOLD_INTERVENTION_BUDGET,
): string {
  return [
    ...repairTaskPolicy(budget),
    '',
    'TASK STATEMENT GIVEN TO THE AGENT:',
    prefix.taskStatement,
  ].join('\n')
}

/**
 * Digest of the question and task policy every arm shares.
 *
 * This is the part of the prompt that is equal by construction across arms:
 * the question, the execution rules, and the budget the caps are read from.
 * An arm's own contract text — its output grammar, its typed-signature
 * instructions — is deliberately outside it, because arms differ there.
 */
export function repairQuestionSha256(
  budget: InterventionBudget = SCAFFOLD_INTERVENTION_BUDGET,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        kind: 'tb-repair-analyst-question',
        question: REPAIR_QUESTION,
        taskPolicy: repairTaskPolicy(budget),
        budget,
      }),
    )
    .digest('hex')
}

/**
 * Digest of the composed question one arm answered.
 *
 * Covers the shared question and the arm's own declared contract text, so two
 * arms that ask materially different composed questions — a JSON grammar
 * versus a typed SUBMIT signature — stamp different digests, and two arms
 * that ask the identical composed question share one.
 */
export function repairArmPromptSha256(
  budget: InterventionBudget,
  contract: readonly string[],
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        kind: 'tb-repair-analyst-prompt',
        question: REPAIR_QUESTION,
        taskPolicy: repairTaskPolicy(budget),
        budget,
        contract,
      }),
    )
    .digest('hex')
}
