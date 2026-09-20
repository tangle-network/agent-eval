import { isDeepStrictEqual } from 'node:util'
import { canonicalString } from './ledger-core/canonical'

/** Structural equivalents of the native SDK types; callers can use its builders unchanged. */
export type JevJson = string | number | boolean | null | JevJson[] | { [key: string]: JevJson }
export type JevState = string | { [key: string]: JevJson } | JevJson[] | null
export type JevScoreCriteria = readonly [JevState, JevState, ...JevState[]]
export type JevQuestion =
  | {
      type: 'noul'
      instructions?: JevState
      criteria?: { true?: JevState; false?: JevState } | null
    }
  | { type: 'score'; instructions?: JevState; criteria: JevScoreCriteria }
  | { type: 'choice'; instructions?: JevState; criteria: Record<string, JevState> }
export type JevQuestions = Record<string, JevQuestion>
export interface JevRequest<Q extends JevQuestions = JevQuestions> {
  model: string
  state: JevState
  questions: Q
}

type ScoreKeys<T extends JevScoreCriteria> = number extends T['length']
  ? number
  : Extract<keyof T, `${number}`>
export type JevAnswerFor<Q extends JevQuestion> = Q extends { type: 'noul' }
  ? { readonly type: 'noul'; readonly noul: number }
  : Q extends { type: 'score'; criteria: infer C extends JevScoreCriteria }
    ? {
        readonly type: 'score'
        readonly score: number
        readonly confidence: number
        readonly legend: { readonly [K in ScoreKeys<C>]: C[K] }
        readonly probabilities: { readonly [K in ScoreKeys<C>]: number }
      }
    : Q extends { type: 'choice'; criteria: infer C }
      ? {
          readonly type: 'choice'
          readonly choice: keyof C & string
          readonly confidence: number
          readonly probabilities: { readonly [K in keyof C]: number }
        }
      : never
export type JevAnswer = JevAnswerFor<JevQuestion>
export interface JevResult<Q extends JevQuestions = JevQuestions> {
  readonly model: string
  readonly answers: { readonly [K in keyof Q]: JevAnswerFor<Q[K]> }
  readonly usage: { readonly input_tokens: number; readonly output_tokens: number }
}

export class JevResponseError extends Error {
  constructor(message: string) {
    super(`Jev: ${message}`)
    this.name = 'JevResponseError'
  }
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new JevResponseError('Expected an object')
  }
  return value as Record<string, unknown>
}

function entry(value: unknown): void {
  if (value === null || typeof value === 'string') return
  if (typeof value !== 'object') throw new TypeError('Expected text, JSON object/array, or null')
  // Reuse the canonical JSON validator rather than accepting lossy Map/Date coercions.
  canonicalString(value)
}

export function parseJevRequest(raw: unknown): JevRequest {
  const request = object(raw)
  if (typeof request.model !== 'string' || !request.model.trim()) {
    throw new TypeError('Evaluation requires a model')
  }
  entry(request.state)
  const questions = object(request.questions)
  if (!Object.keys(questions).length) throw new TypeError('At least one question is required')
  for (const rawQuestion of Object.values(questions)) {
    const question = object(rawQuestion)
    if (question.instructions !== undefined) entry(question.instructions)
    if (question.type === 'noul') {
      if (question.criteria != null) {
        const criteria = object(question.criteria)
        if (Object.keys(criteria).some((key) => key !== 'true' && key !== 'false')) {
          throw new TypeError('Noul criteria must describe true and/or false')
        }
        for (const value of Object.values(criteria)) {
          if (value !== undefined) entry(value)
        }
      }
    } else if (question.type === 'score') {
      if (!Array.isArray(question.criteria) || question.criteria.length < 2) {
        throw new TypeError('Score criteria require at least two ordered entries')
      }
      for (const value of question.criteria) entry(value)
    } else if (question.type === 'choice') {
      const criteria = object(question.criteria)
      if (!Object.keys(criteria).length) throw new TypeError('Choice criteria cannot be empty')
      for (const value of Object.values(criteria)) entry(value)
    } else {
      throw new TypeError('Unsupported native question type')
    }
  }
  return raw as JevRequest
}

export function jevUsage(raw: unknown): JevResult['usage'] {
  const usage = object(object(raw).usage)
  for (const key of ['input_tokens', 'output_tokens']) {
    if (!Number.isSafeInteger(usage[key]) || Number(usage[key]) < 0) {
      throw new JevResponseError('Missing or invalid usage')
    }
  }
  return usage as unknown as JevResult['usage']
}

function probability(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new JevResponseError('Invalid probability')
  }
  return value
}

function exactKeys(value: Record<string, unknown>, names: string[]): void {
  if (
    Object.keys(value).length !== names.length ||
    names.some((key) => !Object.hasOwn(value, key))
  ) {
    throw new JevResponseError('Response keys differ from the request')
  }
}

/** Validate native evidence, not model alias policy or the caller's scoring rules. */
export function parseJevResult<Q extends JevQuestions>(
  raw: unknown,
  request: JevRequest<Q>,
): JevResult<Q> {
  const response = object(raw)
  if (typeof response.model !== 'string' || !response.model.trim()) {
    throw new JevResponseError('Missing served model')
  }
  const answers = object(response.answers)
  exactKeys(answers, Object.keys(request.questions))
  for (const [name, question] of Object.entries(request.questions)) {
    const answer = object(answers[name])
    if (answer.type !== question.type) throw new JevResponseError('Wrong answer type')
    if (question.type === 'noul') {
      probability(answer.noul)
      continue
    }
    probability(answer.confidence)
    const levels =
      question.type === 'score'
        ? question.criteria.map((_, index) => String(index))
        : Object.keys(question.criteria)
    const probabilities = object(answer.probabilities)
    exactKeys(probabilities, levels)
    const sum = levels.reduce((total, level) => total + probability(probabilities[level]), 0)
    if (Math.abs(sum - 1) > 0.0001) throw new JevResponseError('Invalid probability distribution')
    if (question.type === 'score') {
      const legend = object(answer.legend)
      exactKeys(legend, levels)
      if (
        levels.some((level) => !isDeepStrictEqual(legend[level], question.criteria[Number(level)]))
      ) {
        throw new JevResponseError('Provider changed the rubric')
      }
      const expected = levels.reduce(
        (total, level) => total + Number(level) * Number(probabilities[level]),
        0,
      )
      if (
        typeof answer.score !== 'number' ||
        !Number.isFinite(answer.score) ||
        Math.abs(answer.score - expected) > 0.0001
      ) {
        throw new JevResponseError('Score differs from its distribution')
      }
    } else if (
      typeof answer.choice !== 'string' ||
      !Object.hasOwn(probabilities, answer.choice) ||
      levels.some(
        (level) =>
          Number(probabilities[level]) > Number(probabilities[String(answer.choice)]) + 0.0001,
      )
    ) {
      throw new JevResponseError('Choice is not a highest-probability option')
    }
  }
  jevUsage(raw)
  // Retained responses may include provider metadata. Reject lossy JSON once at this boundary.
  canonicalString(raw)
  return raw as JevResult<Q>
}
