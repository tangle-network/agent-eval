/**
 * The mini-swe-agent scaffold as the Terminal-Bench-2 trajectory corpus
 * recorded it: one bash block per turn, one observation per command, and a
 * sentinel command that ends the run.
 *
 * Every template here is byte-verified against
 * `yoonholee/terminalbench-trajectories` (agent = `mini-swe-agent`, 6663 rows,
 * one distinct system prompt across all of them). A continuation that renders
 * different bytes puts the model in a different distribution than the prefix
 * it inherits, so these strings are pinned, not configurable.
 */

/** Whole-line marker that ends a run. The first output line must equal it and the command must exit 0. */
export const SUBMIT_SENTINEL = 'COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT'

/** Outputs at or above this length are elided head+tail instead of shown whole. */
export const OUTPUT_ELISION_THRESHOLD = 10_000

/** Characters kept from each end of an elided output. */
export const OUTPUT_ELISION_WINDOW = 5_000

export const MINI_SWE_SYSTEM_MESSAGE = `You are a helpful assistant that can interact with a computer.

Your response must contain exactly ONE bash code block with ONE command (or commands connected with && or ||).
Include a THOUGHT section before your command where you explain your reasoning process.
Format your response as shown in <format_example>.

<format_example>
Your reasoning and analysis here. Explain why you want to perform the action.

\`\`\`bash
your_command_here
\`\`\`
</format_example>

Failure to follow these rules will cause your response to be rejected.
`

export interface InstanceMessageInput {
  /** The task statement, substituted verbatim. */
  task: string
  /**
   * `uname`-style line the recorded runs rendered from the host running the
   * scaffold, e.g. `Linux 6.8.0-86-generic #87-Ubuntu SMP ... x86_64`.
   */
  systemInformation: string
}

/** The second message of every recorded run: task plus workflow rules. */
export function renderInstanceMessage(input: InstanceMessageInput): string {
  return `Please solve this issue: ${input.task}

You can execute bash commands and edit files to implement the necessary changes.

## Recommended Workflow

This workflows should be done step-by-step so that you can iterate on your changes and any possible problems.

1. Analyze the codebase by finding and reading relevant files
2. Create a script to reproduce the issue
3. Edit the source code to resolve the issue
4. Verify your fix works by running your script again
5. Test edge cases to ensure your fix is robust
6. Submit your changes and finish your work by issuing the following command: \`echo ${SUBMIT_SENTINEL}\`.
   Do not combine it with any other command. <important>After this command, you cannot continue working on this task.</important>

## Important Rules

1. Every response must contain exactly one action
2. The action must be enclosed in triple backticks
3. Directory or environment variable changes are not persistent. Every action is executed in a new subshell.
   However, you can prefix any action with \`MY_ENV_VAR=MY_VALUE cd /path/to/working/dir && ...\` or write/load environment variables from files

<system_information>
${input.systemInformation}
</system_information>

## Formatting your response

Here is an example of a correct response:

<example_response>
THOUGHT: I need to understand the structure of the repository first. Let me check what files are in the current directory to get a better understanding of the codebase.

\`\`\`bash
ls -la
\`\`\`
</example_response>

## Useful command examples

### Create a new file:

\`\`\`bash
cat <<'EOF' > newfile.py
import numpy as np
hello = "world"
print(hello)
EOF
\`\`\`

### Edit files with sed:\`\`\`bash
# Replace all occurrences
sed -i 's/old_string/new_string/g' filename.py

# Replace only first occurrence
sed -i 's/old_string/new_string/' filename.py

# Replace first occurrence on line 1
sed -i '1s/old_string/new_string/' filename.py

# Replace all occurrences in lines 1-10
sed -i '1,10s/old_string/new_string/g' filename.py
\`\`\`

### View file content:

\`\`\`bash
# View specific lines with numbers
nl -ba filename.py | sed -n '10,20p'
\`\`\`

### Any other command you want to run

\`\`\`bash
anything
\`\`\`
`
}

export type ParsedAction =
  | { kind: 'action'; command: string }
  | { kind: 'format-error'; actionCount: number }

const BASH_BLOCK = /```bash\n(.*?)\n```/gs

/**
 * Exactly one fenced bash block is an action; zero or many is a format error.
 * The scaffold trims the command, so a block padded with blank lines executes
 * the same command as an unpadded one.
 */
export function parseAction(assistantMessage: string): ParsedAction {
  const blocks = [...assistantMessage.matchAll(BASH_BLOCK)].map((match) => match[1] ?? '')
  if (blocks.length !== 1) return { kind: 'format-error', actionCount: blocks.length }
  return { kind: 'action', command: (blocks[0] ?? '').trim() }
}

export interface CommandOutput {
  returncode: number
  output: string
  /** Set when the environment itself failed rather than the command. */
  exceptionInfo?: string
}

/**
 * The observation the agent reads after a command. Short outputs are shown
 * whole; long ones keep the first and last `OUTPUT_ELISION_WINDOW` characters
 * with the dropped count between them.
 */
export function renderObservation(output: CommandOutput): string {
  const head = output.exceptionInfo ? `<exception>${output.exceptionInfo}</exception>\n` : ''
  const returncode = `<returncode>${output.returncode}</returncode>\n`
  if (output.output.length < OUTPUT_ELISION_THRESHOLD) {
    return `${head}${returncode}<output>\n${output.output}</output>`
  }
  const elided = output.output.length - OUTPUT_ELISION_THRESHOLD
  return (
    `${head}${returncode}<warning>\n` +
    'The output of your last command was too long.\n' +
    'Please try a different command that produces less output.\n' +
    "If you're looking at a file you can try use head, tail or sed to view a smaller number of lines selectively.\n" +
    "If you're using grep or find and it produced too much output, you can use a more selective search pattern.\n" +
    "If you really need to see something from the full command's output, you can redirect output to a file and then search in that file.\n" +
    '</warning>' +
    `<output_head>\n${output.output.slice(0, OUTPUT_ELISION_WINDOW)}\n</output_head>\n` +
    `<elided_chars>\n${elided} characters elided\n</elided_chars>\n` +
    `<output_tail>\n${output.output.slice(-OUTPUT_ELISION_WINDOW)}\n</output_tail>`
  )
}

/** The observation after the environment killed a command for exceeding its timeout. */
export function renderTimeoutObservation(command: string, partialOutput: string): string {
  return (
    `The last command <command>${command}</command> timed out and has been killed.\n` +
    `The output of the command was:\n <output>\n${partialOutput}\n</output>\n` +
    'Please try another command and make sure to avoid those requiring interactive input.'
  )
}

/** Substring `renderTimeoutObservation` always writes, whatever the command was. */
const TIMEOUT_OBSERVATION_MARKER = 'timed out and has been killed'

/**
 * True when the recording shows the environment killed this step at its
 * wall-clock bound.
 *
 * Such a step carries no returncode, so no replay can confirm or contradict
 * it. Callers use this to bound the replay of that step cheaply rather than to
 * decide agreement.
 */
export function isRecordedTimeout(observation: string | null): boolean {
  return observation?.includes(TIMEOUT_OBSERVATION_MARKER) === true
}

/** The observation after a turn that did not contain exactly one bash block. */
export function renderFormatErrorObservation(actionCount: number): string {
  return (
    `Please always provide EXACTLY ONE action in triple backticks, found ${actionCount} actions.\n` +
    `If you want to end the task, please issue the following command: \`echo ${SUBMIT_SENTINEL}\`\n` +
    'without any other command.\n' +
    'Else, please format your response exactly as follows:\n' +
    '\n' +
    '<response_example>\n' +
    'Here are some thoughts about why you want to perform the action.\n' +
    '\n' +
    '```bash\n' +
    '<action>\n' +
    '```\n' +
    '</response_example>\n' +
    '\n' +
    'Note: In rare cases, if you need to reference a similar format in your command, you might have\n' +
    'to proceed in two steps, first writing TRIPLEBACKTICKSBASH, then replacing them with ```bash.'
  )
}

/**
 * The submission text when this output ends the run, `null` otherwise.
 * A non-zero exit does not submit even when the sentinel is echoed, so an
 * agent cannot end the run through a command that failed.
 */
export function submissionOf(output: CommandOutput): string | null {
  if (output.returncode !== 0) return null
  const lines = output.output.replace(/^\s+/, '').split(/(?<=\n)/)
  const first = lines[0]
  if (first === undefined || first.trim() !== SUBMIT_SENTINEL) return null
  return lines.slice(1).join('')
}
