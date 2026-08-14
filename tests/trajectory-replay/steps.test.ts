import { describe, expect, it } from 'vitest'
import {
  renderFormatErrorObservation,
  renderObservation,
  renderTimeoutObservation,
} from '../../src/trace-repair/mini-swe-scaffold'
import {
  assertReplayableTrajectory,
  classifyObservation,
  decodeRecordedTurns,
  finalRecordedOutcome,
  isElidedField,
  isRecordedTimeout,
  isSubmitAction,
  isSubmitOnlyAction,
  parseRecordedReturncode,
  type RecordedTrajectoryTurn,
  unreadableExitCount,
} from '../../src/trajectory-replay/steps'

/**
 * Bytes copied from `yoonholee/terminalbench-trajectories`, agent
 * `mini-swe-agent`. Each one is a shape the corpus really carries, so a change
 * that stops reading it shows up here rather than as a smaller corpus.
 */
const CORPUS = {
  commandResult: '<returncode>127</returncode>\n<output>\n/bin/sh: 105: python: not found\n</output>',
  formatError:
    'Please always provide EXACTLY ONE action in triple backticks, found 0 actions.\n' +
    'If you want to end the task, please issue the following command: `echo COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT`\n' +
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
    'to proceed in two steps, first writing TRIPLEBACKTICKSBASH, then replacing them with ```bash.',
  timeout:
    'The last command <command>python /app/server.py &</command> timed out and has been killed.\n' +
    'The output of the command was:\n <output>\n\n</output>\n' +
    'Please try another command and make sure to avoid those requiring interactive input.',
  submitCommand: 'echo COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT',
} as const

function turn(cmd: string | null, obs: string | null): RecordedTrajectoryTurn {
  return { src: 'agent', tools: cmd === null ? null : [{ cmd }], obs }
}

describe('elided fields', () => {
  it('reads the hexadecimal counter the dump writes, not only its decimal-looking values', () => {
    expect(isElidedField('$33')).toBe(true)
    expect(isElidedField('$3a')).toBe(true)
    expect(isElidedField('$ff')).toBe(true)
    expect(isElidedField('$100')).toBe(true)
  })

  it('leaves a real command alone', () => {
    expect(isElidedField('echo $1')).toBe(false)
    expect(isElidedField('$PATH')).toBe(false)
    expect(isElidedField('')).toBe(false)
    expect(isElidedField(null)).toBe(false)
  })
})

describe('classifyObservation', () => {
  it('names each shape the corpus carries', () => {
    expect(classifyObservation(CORPUS.commandResult)).toBe('command-result')
    expect(classifyObservation(CORPUS.formatError)).toBe('format-error')
    expect(classifyObservation(CORPUS.timeout)).toBe('timeout')
    expect(classifyObservation('$3a')).toBe('elided')
    expect(classifyObservation(null)).toBe('absent')
    expect(classifyObservation('Requirement already satisfied: grpcio==1.73.0\n')).toBe('unreadable')
  })

  it('classifies what the scaffold writes the same way it classifies what was recorded', () => {
    expect(classifyObservation(renderFormatErrorObservation(0))).toBe('format-error')
    expect(classifyObservation(renderTimeoutObservation('python /app/server.py &', ''))).toBe(
      'timeout',
    )
    expect(classifyObservation(renderObservation({ returncode: 127, output: '' }))).toBe(
      'command-result',
    )
  })

  it('reads a command result whose own output mentions a kill as a command result', () => {
    const observation = renderObservation({
      returncode: 0,
      output: 'job 1 timed out and has been killed\n',
    })
    expect(classifyObservation(observation)).toBe('command-result')
    expect(isRecordedTimeout(observation)).toBe(false)
    expect(parseRecordedReturncode(observation)).toBe(0)
  })
})

describe('decodeRecordedTurns', () => {
  it('keeps each command with the observation of its own turn', () => {
    // The shape of large-scale-text-editing__bFbshXm: a rejected turn sits
    // between the run's only command and the sentinel that ends it.
    const decoded = decodeRecordedTurns([
      { src: 'system', msg: 'system prompt', tools: null, obs: null },
      { src: 'user', msg: 'task', tools: null, obs: null },
      turn(null, CORPUS.formatError),
      turn("cat <<'EOF' > /app/apply_macros.vim\nEOF", renderObservation({ returncode: 0, output: '' })),
      turn(CORPUS.submitCommand, null),
    ])
    expect(decoded.steps).toEqual([
      {
        step_id: 1,
        action: "cat <<'EOF' > /app/apply_macros.vim\nEOF",
        observation: renderObservation({ returncode: 0, output: '' }),
      },
    ])
    expect(decoded.formatErrorTurns).toBe(1)
    expect(decoded.endedOnSubmitSentinel).toBe(true)
    expect(finalRecordedOutcome(decoded.steps)).toEqual({ kind: 'returncode', value: 0 })
  })

  it('holds the submit sentinel as a step when the run continued past it', () => {
    const decoded = decodeRecordedTurns([
      turn(CORPUS.submitCommand, renderObservation({ returncode: 1, output: '' })),
      turn('ls', CORPUS.commandResult),
    ])
    expect(decoded.endedOnSubmitSentinel).toBe(false)
    expect(decoded.steps.map((step) => step.action)).toEqual([CORPUS.submitCommand, 'ls'])
    expect(isSubmitAction(decoded.steps[0]!.action)).toBe(true)
  })

  it('drops a rejected turn that still carries a command, so no replay runs it', () => {
    // 494 turns in the corpus hold both: the model wrote several bash blocks,
    // the scaffold ran none of them, and the dump kept one in the command field.
    const decoded = decodeRecordedTurns([
      turn('cd /app && python -m grpc_tools.protoc kv-store.proto', renderFormatErrorObservation(2)),
      turn('ls', CORPUS.commandResult),
    ])
    expect(decoded.steps.map((step) => step.action)).toEqual(['ls'])
    expect(decoded.formatErrorTurns).toBe(1)
  })

  it('counts elided commands rather than replaying the marker', () => {
    const decoded = decodeRecordedTurns([turn('$3a', CORPUS.commandResult), turn('ls', CORPUS.commandResult)])
    expect(decoded.elidedCommands).toBe(1)
  })

  it('reports a turn whose observation this grammar cannot read', () => {
    const decoded = decodeRecordedTurns([turn(null, 'hint: Using master as the name\n')])
    expect(decoded.unreadableTurns).toBe(1)
    expect(decoded.steps).toEqual([])
  })
})

describe('finalRecordedOutcome', () => {
  it('reads the exit of the last executed command', () => {
    const decoded = decodeRecordedTurns([turn('ls', CORPUS.commandResult), turn(CORPUS.submitCommand, null)])
    expect(finalRecordedOutcome(decoded.steps)).toEqual({ kind: 'returncode', value: 127 })
  })

  it('reports a killed command as a measured outcome, not a missing one', () => {
    const decoded = decodeRecordedTurns([turn('python /app/server.py &', CORPUS.timeout)])
    expect(finalRecordedOutcome(decoded.steps)).toEqual({ kind: 'killed' })
  })

  it('refuses to guess when the dump dropped the last observation', () => {
    const decoded = decodeRecordedTurns([turn('ls', CORPUS.commandResult), turn('make', '$41')])
    expect(finalRecordedOutcome(decoded.steps)).toEqual({ kind: 'unreadable', reason: 'elided' })
  })

  it('refuses when a command that is not the sentinel recorded no observation', () => {
    const decoded = decodeRecordedTurns([turn('ls', CORPUS.commandResult), turn('make', null)])
    expect(decoded.endedOnSubmitSentinel).toBe(false)
    expect(finalRecordedOutcome(decoded.steps)).toEqual({ kind: 'unreadable', reason: 'absent' })
  })

  it('is null for a trajectory with no executed command', () => {
    const decoded = decodeRecordedTurns([turn(CORPUS.submitCommand, null)])
    expect(decoded.steps).toEqual([])
    expect(finalRecordedOutcome(decoded.steps)).toBeNull()
  })
})

describe('unreadableExitCount', () => {
  it('counts every step whose recorded exit a replay cannot check', () => {
    const decoded = decodeRecordedTurns([
      turn('ls', CORPUS.commandResult),
      turn('sleep 600', CORPUS.timeout),
      turn('make', '$41'),
      turn('true', CORPUS.commandResult),
    ])
    expect(unreadableExitCount(decoded.steps)).toBe(2)
  })
})

describe('the sentinel that is dropped and the sentinel that is not', () => {
  it('drops a trailing step that echoes the sentinel and nothing else', () => {
    for (const action of [
      'echo COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT',
      '  echo COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT  ',
      'echo "COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT"',
      "echo 'COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT'",
    ]) {
      expect(isSubmitOnlyAction(action)).toBe(true)
      const decoded = decodeRecordedTurns([turn('ls', CORPUS.commandResult), turn(action, null)])
      expect(decoded.endedOnSubmitSentinel).toBe(true)
      expect(decoded.steps.map((step) => step.action)).toEqual(['ls'])
    }
  })

  it('keeps a trailing step that did real work before echoing the sentinel', () => {
    // 131 of 2,312 recorded runs end this way. The write is part of the end
    // state, and with no observation its exit is unknown rather than absent.
    const action =
      "cat <<'EOF' > /app/apply_macros.vim\n:wq\nEOF\ncp /app/expected.csv /app/input.csv\n" +
      'diff -q /app/input.csv /app/expected.csv && echo COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT'
    expect(isSubmitAction(action)).toBe(true)
    expect(isSubmitOnlyAction(action)).toBe(false)
    const decoded = decodeRecordedTurns([turn('ls', CORPUS.commandResult), turn(action, null)])
    expect(decoded.endedOnSubmitSentinel).toBe(false)
    expect(decoded.steps.map((step) => step.action)).toEqual(['ls', action])
    expect(finalRecordedOutcome(decoded.steps)).toEqual({ kind: 'unreadable', reason: 'absent' })
  })
})

describe('assertReplayableTrajectory', () => {
  it('passes a trajectory whose every command survived the dump', () => {
    const decoded = decodeRecordedTurns([turn('ls', CORPUS.commandResult)])
    expect(() => assertReplayableTrajectory(decoded)).not.toThrow()
  })

  it('refuses a trajectory holding an elision marker, naming the marker', () => {
    const decoded = decodeRecordedTurns([turn('$3a', CORPUS.commandResult), turn('ls', CORPUS.commandResult)])
    expect(decoded.steps.map((step) => step.action)).toEqual(['$3a', 'ls'])
    expect(() => assertReplayableTrajectory(decoded)).toThrow(/\$3a/)
  })
})
