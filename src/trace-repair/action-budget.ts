/**
 * The action budget an intervention must fit inside.
 *
 * The analyst answers with one action, applied at step k, drawn from the same
 * action space the scaffold had: one shell command or one edit, at most 4 KB.
 * An answer that buys a bigger action than the scaffold could take is not a
 * counterfactual about the recorded run, so the budget is enforced before any
 * container is opened and a violation never reaches the reproduction gate.
 *
 * "One action" is decided by counting top-level statements, not lines. A
 * command list joined by `&&`, `||` or a pipe is one statement, because that
 * is one thing the shell runs and one thing the scaffold could have typed.
 * Two statements separated by a newline or `;` are two actions and are
 * rejected. Heredoc bodies, comments and compound blocks (`if`, `for`,
 * `while`, `until`, `case`, `{ … }`) are inside a statement, never separators.
 */

import { ValidationError } from '../errors'
import { SUBMIT_SENTINEL } from './mini-swe-scaffold'

/**
 * Payload shape of an action.
 *
 * `edit` authors file content inline through a heredoc; `shell` runs a
 * command. The split matters because the two carry different amounts of
 * information for the same byte count, and a report that pools them hides it.
 */
export type ActionPayloadKind = 'shell' | 'edit'

export interface InterventionBudget {
  /** Hard cap on the UTF-8 byte length of the action. */
  readonly maxBytes: number
  /** Top-level statements the action may contain. One means one action. */
  readonly maxStatements: number
  /** Heredoc redirections an `edit` may contain. One means one file. */
  readonly maxHeredocs: number
}

/** The scaffold's own per-action budget, pre-registered for the campaign. */
export const SCAFFOLD_INTERVENTION_BUDGET: InterventionBudget = Object.freeze({
  maxBytes: 4096,
  maxStatements: 1,
  maxHeredocs: 1,
})

/**
 * Actions whose only effect is to consume a turn. They are rejected before a
 * container opens: an intervention that changes nothing is measurably
 * identical to the no-op control, and paying rollouts to rediscover that
 * wastes the corpus.
 */
export const NO_OP_ACTIONS: readonly string[] = Object.freeze([
  ':',
  'true',
  '/bin/true',
  'exit',
  'exit 0',
])

interface HeredocMark {
  delimiter: string
  stripTabs: boolean
  quoted: boolean
}

interface ScanState {
  statements: string[]
  current: string
  heredocs: number
}

const BLOCK_OPENERS = new Set(['if', 'for', 'while', 'until', 'case', 'select', 'do', 'then'])
const BLOCK_CLOSERS = new Set(['fi', 'done', 'esac'])

/**
 * Split a shell script into top-level statements and count its heredocs.
 *
 * The scan tracks quoting, escapes, command substitution, brace and paren
 * grouping, comments, compound-block keywords, and heredoc bodies. Anything
 * it cannot resolve stays inside the current statement, so an unparseable
 * action reads as one oversized statement and is rejected on bytes rather
 * than silently accepted as one clean action.
 */
export function scanShellAction(script: string): { statements: string[]; heredocs: number } {
  const state: ScanState = { statements: [], current: '', heredocs: 0 }
  let index = 0
  let parenDepth = 0
  let braceDepth = 0
  let blockDepth = 0
  let inSingle = false
  let inDouble = false
  let inBacktick = false
  let pendingHeredocs: HeredocMark[] = []
  let word = ''
  let atStatementStart = true

  const flushWord = (): void => {
    if (word.length === 0) return
    if (BLOCK_OPENERS.has(word)) blockDepth += 1
    else if (BLOCK_CLOSERS.has(word)) blockDepth = Math.max(0, blockDepth - 1)
    word = ''
  }

  const endStatement = (): void => {
    flushWord()
    const text = state.current.trim()
    // A comment runs no command, so a comment-only chunk is not a statement.
    if (text.length > 0 && !isCommentOnly(text)) state.statements.push(text)
    state.current = ''
    atStatementStart = true
  }

  while (index < script.length) {
    const char = script[index]!

    if (inSingle) {
      state.current += char
      if (char === "'") inSingle = false
      index += 1
      continue
    }

    if (char === '\\' && index + 1 < script.length) {
      const next = script[index + 1]!
      if (next === '\n' && !inDouble) {
        // Line continuation: the statement carries on.
        state.current += char + next
        index += 2
        continue
      }
      state.current += char + next
      index += 2
      continue
    }

    if (inDouble) {
      state.current += char
      if (char === '"') inDouble = false
      index += 1
      continue
    }

    if (char === "'") {
      flushWord()
      inSingle = true
      state.current += char
      index += 1
      atStatementStart = false
      continue
    }

    if (char === '"') {
      flushWord()
      inDouble = true
      state.current += char
      index += 1
      atStatementStart = false
      continue
    }

    if (char === '`') {
      inBacktick = !inBacktick
      state.current += char
      index += 1
      atStatementStart = false
      continue
    }

    if (char === '#' && (atStatementStart || /\s/.test(script[index - 1] ?? ' '))) {
      const end = script.indexOf('\n', index)
      const stop = end === -1 ? script.length : end
      state.current += script.slice(index, stop)
      index = stop
      continue
    }

    // Heredoc introducer: `<<WORD`, `<<-WORD`, `<<'WORD'`. A run of three `<`
    // is a herestring, so neither of its `<<` pairs may open a heredoc.
    if (
      char === '<' &&
      script[index + 1] === '<' &&
      script[index + 2] !== '<' &&
      script[index - 1] !== '<'
    ) {
      const mark = readHeredocMark(script, index)
      if (mark) {
        pendingHeredocs.push(mark.mark)
        state.heredocs += 1
        state.current += script.slice(index, mark.nextIndex)
        index = mark.nextIndex
        atStatementStart = false
        continue
      }
    }

    if (char === '(') {
      flushWord()
      parenDepth += 1
      state.current += char
      index += 1
      atStatementStart = true
      continue
    }
    if (char === ')') {
      flushWord()
      parenDepth = Math.max(0, parenDepth - 1)
      state.current += char
      index += 1
      atStatementStart = false
      continue
    }
    if (char === '{') {
      flushWord()
      braceDepth += 1
      state.current += char
      index += 1
      atStatementStart = true
      continue
    }
    if (char === '}') {
      flushWord()
      braceDepth = Math.max(0, braceDepth - 1)
      state.current += char
      index += 1
      atStatementStart = false
      continue
    }

    if (char === '\n') {
      flushWord()
      if (pendingHeredocs.length > 0) {
        const consumed = consumeHeredocBodies(script, index + 1, pendingHeredocs)
        state.current += script.slice(index, consumed)
        pendingHeredocs = []
        index = consumed
        continue
      }
      if (
        parenDepth > 0 ||
        braceDepth > 0 ||
        blockDepth > 0 ||
        inBacktick ||
        endsWithContinuation(state.current)
      ) {
        state.current += char
        index += 1
        atStatementStart = true
        continue
      }
      endStatement()
      index += 1
      continue
    }

    if (char === ';') {
      flushWord()
      if (parenDepth > 0 || braceDepth > 0 || blockDepth > 0 || inBacktick) {
        state.current += char
        index += 1
        atStatementStart = true
        continue
      }
      endStatement()
      index += 1
      continue
    }

    if (/\s/.test(char)) {
      flushWord()
      state.current += char
      index += 1
      continue
    }

    if (char === '&' || char === '|') {
      flushWord()
      state.current += char
      index += 1
      atStatementStart = true
      continue
    }

    word += char
    state.current += char
    atStatementStart = false
    index += 1
  }

  endStatement()
  return { statements: state.statements, heredocs: state.heredocs }
}

function isCommentOnly(text: string): boolean {
  return text.split('\n').every((line) => line.trim().length === 0 || line.trim().startsWith('#'))
}

function endsWithContinuation(current: string): boolean {
  const trimmed = current.trimEnd()
  return /(&&|\|\||\||&|\\)$/.test(trimmed)
}

function readHeredocMark(
  script: string,
  index: number,
): { mark: HeredocMark; nextIndex: number } | null {
  let cursor = index + 2
  let stripTabs = false
  if (script[cursor] === '-') {
    stripTabs = true
    cursor += 1
  }
  while (script[cursor] === ' ' || script[cursor] === '\t') cursor += 1
  const quote = script[cursor]
  if (quote === "'" || quote === '"') {
    const close = script.indexOf(quote, cursor + 1)
    if (close === -1) return null
    return {
      mark: { delimiter: script.slice(cursor + 1, close), stripTabs, quoted: true },
      nextIndex: close + 1,
    }
  }
  const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(script.slice(cursor))
  if (!match) return null
  return {
    mark: { delimiter: match[0], stripTabs, quoted: false },
    nextIndex: cursor + match[0].length,
  }
}

/** Consume every pending heredoc body; returns the offset just past the last
 *  terminator, or the end of the script when a terminator never arrives. */
function consumeHeredocBodies(script: string, from: number, marks: HeredocMark[]): number {
  let cursor = from
  for (const mark of marks) {
    let closed = false
    while (cursor < script.length) {
      const lineEnd = script.indexOf('\n', cursor)
      const stop = lineEnd === -1 ? script.length : lineEnd
      const line = script.slice(cursor, stop)
      const candidate = mark.stripTabs ? line.replace(/^\t+/, '') : line
      cursor = lineEnd === -1 ? script.length : lineEnd + 1
      if (candidate === mark.delimiter) {
        closed = true
        break
      }
    }
    if (!closed) return script.length
  }
  return cursor
}

/** Payload shape of an action: `edit` when it authors file content through a
 *  heredoc, `shell` otherwise. */
export function classifyActionPayload(action: string): ActionPayloadKind {
  return scanShellAction(action).heredocs > 0 ? 'edit' : 'shell'
}

/** Why an action fails the budget. Every value is a rejection the report
 *  counts by name; none of them is a scoring judgement. */
export type BudgetViolation =
  | 'empty'
  | 'over-byte-cap'
  | 'multiple-statements'
  | 'multiple-heredocs'
  | 'no-op-action'
  | 'submit-instead-of-repair'

export interface BudgetMeasurement {
  bytes: number
  statements: number
  heredocs: number
  /** What the action IS, measured from its text. */
  payload: ActionPayloadKind
  /** What the analyst SAID it was. Recorded, never a rejection. */
  declared: ActionPayloadKind
}

export type BudgetCheck =
  | { readonly admissible: true; readonly measurement: BudgetMeasurement }
  | {
      readonly admissible: false
      readonly violation: BudgetViolation
      readonly detail: string
      readonly measurement: BudgetMeasurement
    }

/** Re-exported so budget callers read the sentinel from the module that
 *  measures actions. Submitting is how the recorded agent ended a run that the
 *  tests then failed, so it can never be the repair. */
export { SUBMIT_SENTINEL } from './mini-swe-scaffold'

/**
 * Measure an action against the budget.
 *
 * The budget bounds what the scaffold can execute: one top-level statement,
 * one authored file, a byte cap, and neither a no-op nor a submit. Every
 * rejection here is one of those.
 *
 * `declaredKind` is what the analyst called its own action. It is recorded
 * beside the measured payload and never rejected on, because the scaffold runs
 * the action identically either way — so rejecting the label scores an arm on
 * how it described a repair rather than on the repair. A reader who wants the
 * mismatch counts `declared` against `payload`.
 */
export function checkInterventionBudget(
  action: string,
  declaredKind: ActionPayloadKind,
  budget: InterventionBudget = SCAFFOLD_INTERVENTION_BUDGET,
): BudgetCheck {
  assertBudget(budget)
  const scan = scanShellAction(action)
  const payload: ActionPayloadKind = scan.heredocs > 0 ? 'edit' : 'shell'
  const measurement: BudgetMeasurement = {
    bytes: Buffer.byteLength(action, 'utf8'),
    statements: scan.statements.length,
    heredocs: scan.heredocs,
    payload,
    declared: declaredKind,
  }
  const reject = (violation: BudgetViolation, detail: string): BudgetCheck => ({
    admissible: false,
    violation,
    detail,
    measurement,
  })

  if (action.trim().length === 0) return reject('empty', 'the intervention is empty')
  if (measurement.bytes > budget.maxBytes) {
    return reject(
      'over-byte-cap',
      `${measurement.bytes} bytes exceeds the ${budget.maxBytes}-byte action budget`,
    )
  }
  if (measurement.statements > budget.maxStatements) {
    return reject(
      'multiple-statements',
      `${measurement.statements} top-level statements exceeds the ${budget.maxStatements} the scaffold takes per action`,
    )
  }
  if (measurement.heredocs > budget.maxHeredocs) {
    return reject(
      'multiple-heredocs',
      `${measurement.heredocs} heredocs exceeds the ${budget.maxHeredocs} one edit may author`,
    )
  }
  if (action.includes(SUBMIT_SENTINEL)) {
    return reject('submit-instead-of-repair', 'the action submits the run instead of repairing it')
  }
  if (NO_OP_ACTIONS.includes(action.trim())) {
    return reject('no-op-action', `"${action.trim()}" changes nothing`)
  }
  return { admissible: true, measurement }
}

function assertBudget(budget: InterventionBudget): void {
  for (const field of ['maxBytes', 'maxStatements', 'maxHeredocs'] as const) {
    const value = budget[field]
    if (!Number.isInteger(value) || value <= 0) {
      throw new ValidationError(
        `intervention budget ${field} must be a positive integer, got ${value}`,
      )
    }
  }
}

/**
 * Whitespace-insensitive comparison used to reject an intervention that is
 * the recorded action again. Trailing whitespace and blank lines are the only
 * differences a re-proposal can carry without changing what runs.
 */
export function normalizeActionForComparison(action: string): string {
  return action
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line, index, lines) => line.length > 0 || (index > 0 && index < lines.length - 1))
    .join('\n')
    .trim()
}
