import { describe, expect, it } from 'vitest'
import {
  MINI_SWE_SYSTEM_MESSAGE,
  OUTPUT_ELISION_THRESHOLD,
  parseAction,
  renderFormatErrorObservation,
  renderInstanceMessage,
  renderObservation,
  renderTimeoutObservation,
  SUBMIT_SENTINEL,
  submissionOf,
} from './mini-swe-scaffold'

// Strings copied from `yoonholee/terminalbench-trajectories`, agent =
// `mini-swe-agent`. A continuation that renders different bytes puts the model
// in a different distribution than the prefix it inherits.
const RECORDED_SYSTEM_MESSAGE = [
  'You are a helpful assistant that can interact with a computer.',
  '',
  'Your response must contain exactly ONE bash code block with ONE command (or commands connected with && or ||).',
  'Include a THOUGHT section before your command where you explain your reasoning process.',
  'Format your response as shown in <format_example>.',
  '',
  '<format_example>',
  'Your reasoning and analysis here. Explain why you want to perform the action.',
  '',
  '```bash',
  'your_command_here',
  '```',
  '</format_example>',
  '',
  'Failure to follow these rules will cause your response to be rejected.',
  '',
].join('\n')

const RECORDED_TIMEOUT_OBSERVATION =
  'The last command <command>sleep 30 && which R && R --version | head -3</command> timed out and has been killed.\nThe output of the command was:\n <output>\n\n</output>\nPlease try another command and make sure to avoid those requiring interactive input.'

const RECORDED_FORMAT_ERROR_OBSERVATION =
  'Please always provide EXACTLY ONE action in triple backticks, found 0 actions.\nIf you want to end the task, please issue the following command: `echo COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT`\nwithout any other command.\nElse, please format your response exactly as follows:\n\n<response_example>\nHere are some thoughts about why you want to perform the action.\n\n```bash\n<action>\n```\n</response_example>\n\nNote: In rare cases, if you need to reference a similar format in your command, you might have\nto proceed in two steps, first writing TRIPLEBACKTICKSBASH, then replacing them with ```bash.'

const RECORDED_ELIDED_OBSERVATION_HEAD =
  "<returncode>1</returncode>\n<warning>\nThe output of your last command was too long.\nPlease try a different command that produces less output.\nIf you're looking at a file you can try use head, tail or sed to view a smaller number of lines selectively.\nIf you're using grep or find and it produced too much output, you can use a more selective search pattern.\nIf you really need to see something from the full command's output, you can redirect output to a file and then search in that file.\n</warning><output_head>\n"

describe('mini-swe-agent scaffold templates', () => {
  it('renders the recorded system message byte for byte', () => {
    expect(MINI_SWE_SYSTEM_MESSAGE).toBe(RECORDED_SYSTEM_MESSAGE)
  })

  it('renders the recorded timeout observation byte for byte', () => {
    expect(renderTimeoutObservation('sleep 30 && which R && R --version | head -3', '')).toBe(
      RECORDED_TIMEOUT_OBSERVATION,
    )
  })

  it('renders the recorded format-error observation byte for byte', () => {
    expect(renderFormatErrorObservation(0)).toBe(RECORDED_FORMAT_ERROR_OBSERVATION)
  })

  it('names the action count the turn actually produced', () => {
    expect(renderFormatErrorObservation(2)).toContain('found 2 actions')
  })

  it('puts the task and the system information into the instance message', () => {
    const message = renderInstanceMessage({
      task: 'Recover the deleted branch.',
      systemInformation: 'Linux 6.8.0-86-generic x86_64',
    })
    expect(message.startsWith('Please solve this issue: Recover the deleted branch.\n\n')).toBe(
      true,
    )
    expect(message).toContain(
      '<system_information>\nLinux 6.8.0-86-generic x86_64\n</system_information>',
    )
    expect(message).toContain(`\`echo ${SUBMIT_SENTINEL}\``)
  })
})

describe('parseAction', () => {
  it('accepts exactly one bash block and trims the command', () => {
    const parsed = parseAction('THOUGHT: look around\n\n```bash\nls -la /app\n```')
    expect(parsed).toEqual({ kind: 'action', command: 'ls -la /app' })
  })

  it('keeps a multi-line command intact', () => {
    const parsed = parseAction("```bash\ncat <<'EOF' > a.py\nx = 1\nEOF\n```")
    expect(parsed).toEqual({ kind: 'action', command: "cat <<'EOF' > a.py\nx = 1\nEOF" })
  })

  it('reports zero actions when the turn has no bash block', () => {
    expect(parseAction('THOUGHT: I am done thinking.')).toEqual({
      kind: 'format-error',
      actionCount: 0,
    })
  })

  it('reports every action when the turn has several', () => {
    expect(parseAction('```bash\nls\n```\nand\n```bash\npwd\n```')).toEqual({
      kind: 'format-error',
      actionCount: 2,
    })
  })
})

describe('renderObservation', () => {
  it('renders an empty output the way the corpus records it', () => {
    expect(renderObservation({ returncode: 1, output: '' })).toBe(
      '<returncode>1</returncode>\n<output>\n</output>',
    )
  })

  it('keeps the command output verbatim, trailing newline included', () => {
    expect(renderObservation({ returncode: 0, output: 'hello\n' })).toBe(
      '<returncode>0</returncode>\n<output>\nhello\n</output>',
    )
  })

  it('parses a negative return code from a killed command', () => {
    expect(renderObservation({ returncode: -15, output: '' })).toContain(
      '<returncode>-15</returncode>',
    )
  })

  it('elides output at the recorded threshold and joins the warning to the head', () => {
    const output = 'x'.repeat(OUTPUT_ELISION_THRESHOLD + 7)
    const rendered = renderObservation({ returncode: 1, output })
    expect(rendered.startsWith(RECORDED_ELIDED_OBSERVATION_HEAD)).toBe(true)
    expect(rendered).toContain('<elided_chars>\n7 characters elided\n</elided_chars>')
    expect(rendered.endsWith(`\n</output_tail>`)).toBe(true)
  })

  it('shows output whole one character below the threshold', () => {
    const output = 'x'.repeat(OUTPUT_ELISION_THRESHOLD - 1)
    expect(renderObservation({ returncode: 0, output })).toBe(
      `<returncode>0</returncode>\n<output>\n${output}</output>`,
    )
  })

  it('leads with the environment exception when one is present', () => {
    expect(
      renderObservation({ returncode: -1, output: '', exceptionInfo: 'docker exec failed' }),
    ).toBe(
      '<exception>docker exec failed</exception>\n<returncode>-1</returncode>\n<output>\n</output>',
    )
  })
})

describe('submissionOf', () => {
  it('submits when the sentinel is the first line of a clean exit', () => {
    expect(submissionOf({ returncode: 0, output: `${SUBMIT_SENTINEL}\ndone\n` })).toBe('done\n')
  })

  it('submits with empty text when the sentinel is the only line', () => {
    expect(submissionOf({ returncode: 0, output: `${SUBMIT_SENTINEL}\n` })).toBe('')
  })

  it('refuses to submit when the command failed', () => {
    expect(submissionOf({ returncode: 1, output: `${SUBMIT_SENTINEL}\n` })).toBeNull()
  })

  it('refuses to submit when the sentinel is not the first line', () => {
    expect(submissionOf({ returncode: 0, output: `building\n${SUBMIT_SENTINEL}\n` })).toBeNull()
  })
})
