import { isDeepStrictEqual } from 'node:util'
import { canonicalString } from './ledger-core/canonical'

/**
 * The System One wire contract (TypeSafe-originated, https://api.typesafe.ai/openapi.json; also
 * served by Cloudflare Workers AI and Perplexity). This module names no endpoint, credential or
 * model; callers can use TypeSafe's SDK builders unchanged.
 */
export type SystemOneJson =
  | string
  | number
  | boolean
  | null
  | SystemOneJson[]
  | { [key: string]: SystemOneJson }
/** What the TypeSafe route accepts as `state` and as a score level: text or JSON, never null. */
export type SystemOneState = string | { [key: string]: SystemOneJson } | SystemOneJson[]
/** Instructions and choice or noul descriptions, which TypeSafe also accepts as null. */
export type SystemOneDescription = SystemOneState | null
export type SystemOneScoreCriteria = readonly [SystemOneState, SystemOneState, ...SystemOneState[]]
export type SystemOneQuestion =
  | {
      type: 'noul'
      instructions?: SystemOneDescription
      criteria?: { true?: SystemOneDescription; false?: SystemOneDescription } | null
    }
  | { type: 'score'; instructions?: SystemOneDescription; criteria: SystemOneScoreCriteria }
  | {
      type: 'choice'
      instructions?: SystemOneDescription
      criteria: Record<string, SystemOneDescription>
    }
export type SystemOneQuestions = Record<string, SystemOneQuestion>
export interface SystemOneRequest<Q extends SystemOneQuestions = SystemOneQuestions> {
  model: string
  state: SystemOneState
  questions: Q
}

/** Historical Tangle observations accepted null state and score levels. Not a live request. */
export type SystemOneRecordedQuestion =
  | Exclude<SystemOneQuestion, { type: 'score' }>
  | {
      type: 'score'
      instructions?: SystemOneDescription
      criteria: readonly [SystemOneDescription, SystemOneDescription, ...SystemOneDescription[]]
    }
export type SystemOneRecordedQuestions = Record<string, SystemOneRecordedQuestion>
export interface SystemOneRecordedRequest<
  Q extends SystemOneRecordedQuestions = SystemOneRecordedQuestions,
> {
  model: string
  state: SystemOneDescription
  questions: Q
}

type ScoreKeys<T extends readonly SystemOneDescription[]> = number extends T['length']
  ? number
  : Extract<keyof T, `${number}`>
export type SystemOneAnswerFor<Q extends SystemOneRecordedQuestion> = Q extends { type: 'noul' }
  ? { readonly type: 'noul'; readonly noul: number }
  : Q extends { type: 'score'; criteria: infer C extends readonly SystemOneDescription[] }
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
export type SystemOneAnswer = SystemOneAnswerFor<SystemOneQuestion>
export interface SystemOneResult<Q extends SystemOneRecordedQuestions = SystemOneQuestions> {
  readonly model: string
  readonly answers: { readonly [K in keyof Q]: SystemOneAnswerFor<Q[K]> }
  readonly usage: { readonly input_tokens: number; readonly output_tokens: number }
}

export class SystemOneResponseError extends Error {
  constructor(message: string) {
    super(`System One: ${message}`)
    this.name = 'SystemOneResponseError'
  }
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new SystemOneResponseError('Expected an object')
  }
  return value as Record<string, unknown>
}

// Providers answer 422 for a null state, and TypeSafe also for a null score level. Refusing them
// here reports the caller's mistake before a paid round trip, not as a provider failure after one.
function textOrJson(value: unknown, name: string): void {
  if (typeof value === 'string') return
  if (value === null || typeof value !== 'object') {
    throw new TypeError(`${name} must be text or a JSON object/array`)
  }
  // Reuse the canonical JSON validator rather than accepting lossy Map/Date coercions.
  canonicalString(value)
}

function optionalTextOrJson(value: unknown, name: string): void {
  if (value !== null) textOrJson(value, name)
}

/** Validate named questions without a state, as a judge does before it has input. */
export function parseSystemOneQuestions(raw: unknown): SystemOneQuestions {
  return readQuestions(raw, false) as SystemOneQuestions
}

function readQuestions(raw: unknown, recorded: boolean): SystemOneRecordedQuestions {
  const questions = object(raw)
  if (!Object.keys(questions).length) throw new TypeError('At least one question is required')
  for (const [name, rawQuestion] of Object.entries(questions)) {
    const question = object(rawQuestion)
    if (question.instructions !== undefined) {
      optionalTextOrJson(question.instructions, `${name} instructions`)
    }
    if (question.type === 'noul') {
      if (question.criteria != null) {
        const criteria = object(question.criteria)
        if (Object.keys(criteria).some((key) => key !== 'true' && key !== 'false')) {
          throw new TypeError('Noul criteria must describe true and/or false')
        }
        for (const value of Object.values(criteria)) {
          if (value !== undefined) optionalTextOrJson(value, `${name} criteria`)
        }
      }
    } else if (question.type === 'score') {
      if (!Array.isArray(question.criteria) || question.criteria.length < 2) {
        throw new TypeError('Score criteria require at least two ordered entries')
      }
      for (const value of question.criteria) {
        if (recorded && value === null) continue
        textOrJson(value, `${name} score level`)
      }
    } else if (question.type === 'choice') {
      const criteria = object(question.criteria)
      if (!Object.keys(criteria).length) throw new TypeError('Choice criteria cannot be empty')
      for (const value of Object.values(criteria)) optionalTextOrJson(value, `${name} choice`)
    } else {
      throw new TypeError('Unsupported native question type')
    }
  }
  return raw as SystemOneRecordedQuestions
}

export function parseSystemOneRequest(raw: unknown): SystemOneRequest {
  return readRequest(raw, false) as SystemOneRequest
}

/** Read immutable historical evidence without rewriting it or authorizing new inference.
 * Live transports must still call parseSystemOneRequest, even for re-execution of an old request. */
export function parseSystemOneRecordedRequest(raw: unknown): SystemOneRecordedRequest {
  canonicalString(raw)
  return readRequest(raw, true)
}

function readRequest(raw: unknown, recorded: boolean): SystemOneRecordedRequest {
  const request = object(raw)
  if (typeof request.model !== 'string' || !request.model.trim()) {
    throw new TypeError('Evaluation requires a model')
  }
  if (!recorded || request.state !== null) textOrJson(request.state, 'Evaluation state')
  readQuestions(request.questions, recorded)
  return raw as SystemOneRecordedRequest
}

export function systemOneUsage(raw: unknown): SystemOneResult['usage'] {
  const usage = object(object(raw).usage)
  for (const key of ['input_tokens', 'output_tokens']) {
    if (!Number.isSafeInteger(usage[key]) || Number(usage[key]) < 0) {
      throw new SystemOneResponseError('Missing or invalid usage')
    }
  }
  return usage as unknown as SystemOneResult['usage']
}

/** The strict parser's allowance for floating-point error; provider rounding is normalized first. */
const TOLERANCE = 0.0001

function levelsOf(question: SystemOneRecordedQuestion): string[] {
  return question.type === 'score'
    ? question.criteria.map((_, index) => String(index))
    : question.type === 'choice'
      ? Object.keys(question.criteria)
      : []
}

/** Σ level·p over score levels "0".."n-1". */
function expectation(levels: string[], probabilities: Record<string, unknown>): number {
  return levels.reduce((total, level) => total + Number(level) * Number(probabilities[level]), 0)
}

function probability(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new SystemOneResponseError('Invalid probability')
  }
  return value
}

function exactKeys(value: Record<string, unknown>, names: string[]): void {
  if (
    Object.keys(value).length !== names.length ||
    names.some((key) => !Object.hasOwn(value, key))
  ) {
    throw new SystemOneResponseError('Response keys differ from the request')
  }
}

/** Validate native evidence, not model alias policy or the caller's scoring rules. */
export function parseSystemOneResult<Q extends SystemOneRecordedQuestions>(
  raw: unknown,
  request: SystemOneRecordedRequest<Q>,
): SystemOneResult<Q> {
  // Preserve extension metadata, rejecting values that change when persisted as JSON.
  canonicalString(raw)
  const response = object(raw)
  if (typeof response.model !== 'string' || !response.model.trim()) {
    throw new SystemOneResponseError('Missing served model')
  }
  const answers = object(response.answers)
  exactKeys(answers, Object.keys(request.questions))
  for (const [name, question] of Object.entries(request.questions)) {
    const answer = object(answers[name])
    if (answer.type !== question.type) throw new SystemOneResponseError('Wrong answer type')
    if (question.type === 'noul') {
      probability(answer.noul)
      continue
    }
    probability(answer.confidence)
    const levels = levelsOf(question)
    const probabilities = object(answer.probabilities)
    exactKeys(probabilities, levels)
    const sum = levels.reduce((total, level) => total + probability(probabilities[level]), 0)
    if (Math.abs(sum - 1) > TOLERANCE) {
      throw new SystemOneResponseError('Invalid probability distribution')
    }
    if (question.type === 'score') {
      const legend = object(answer.legend)
      exactKeys(legend, levels)
      if (
        levels.some((level) => !isDeepStrictEqual(legend[level], question.criteria[Number(level)]))
      ) {
        throw new SystemOneResponseError('Provider changed the rubric')
      }
      if (
        typeof answer.score !== 'number' ||
        !Number.isFinite(answer.score) ||
        Math.abs(answer.score - expectation(levels, probabilities)) > TOLERANCE
      ) {
        throw new SystemOneResponseError('Score differs from its distribution')
      }
    } else if (
      typeof answer.choice !== 'string' ||
      !Object.hasOwn(probabilities, answer.choice) ||
      levels.some(
        (level) =>
          Number(probabilities[level]) > Number(probabilities[String(answer.choice)]) + TOLERANCE,
      )
    ) {
      throw new SystemOneResponseError('Choice is not a highest-probability option')
    }
  }
  systemOneUsage(raw)
  return raw as SystemOneResult<Q>
}

/**
 * How one provider reports results, measured from its responses. The caller that owns the
 * provider route supplies it; this module names no provider.
 */
export interface SystemOneResultProfile {
  /** Decimal places the provider rounds probabilities and scores to. Omit when it reports exact values. */
  readonly decimals?: number
  /**
   * `canonical`: the provider's `confidence` already follows `systemOneConfidence`.
   * `provider-defined`: it follows another definition, kept as `provider_confidence`.
   */
  readonly confidence: 'canonical' | 'provider-defined'
}

/**
 * The one confidence definition every route reports, TypeSafe's published formulas
 * (https://docs.typesafe.ai/confidence). Choice: (p_max − 1/n)/(1 − 1/n), and 1 for one option.
 * Score: 1 − Σ p_i·|i − m| / MAD_uniform, where m is the most likely level (the lowest on ties)
 * and MAD_uniform = (1/n)·Σ|i − (n − 1)/2|. Expects a normalized distribution; noul has none.
 */
export function systemOneConfidence(answer: {
  readonly type: 'choice' | 'score'
  readonly probabilities: Readonly<Record<string, number>>
}): number {
  const labels = Object.keys(answer.probabilities)
  const n = labels.length
  const p = labels.map(
    (label, index) => answer.probabilities[answer.type === 'score' ? String(index) : label],
  )
  if (
    !n ||
    (answer.type === 'score' && n < 2) ||
    p.some(
      (value) => typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1,
    )
  ) {
    throw new TypeError('Confidence requires a probability for every option or score level')
  }
  const values = p as number[]
  const peak = Math.max(...values)
  let confidence: number
  if (answer.type === 'choice') {
    confidence = n === 1 ? 1 : (peak - 1 / n) / (1 - 1 / n)
  } else {
    const mode = values.indexOf(peak)
    const center = (n - 1) / 2
    const uniform = values.reduce((total, _, level) => total + Math.abs(level - center), 0) / n
    const spread = values.reduce((total, value, level) => total + value * Math.abs(level - mode), 0)
    confidence = 1 - spread / uniform
  }
  return Math.min(1, Math.max(0, confidence))
}

function readProfile(profile: SystemOneResultProfile): void {
  if (
    profile === null ||
    typeof profile !== 'object' ||
    (profile.decimals !== undefined &&
      (!Number.isSafeInteger(profile.decimals) || profile.decimals < 0 || profile.decimals > 15)) ||
    (profile.confidence !== 'canonical' && profile.confidence !== 'provider-defined')
  ) {
    throw new TypeError('Invalid System One result profile')
  }
}

function normalizeAnswer(
  answer: Record<string, unknown>,
  question: Exclude<SystemOneRecordedQuestion, { type: 'noul' }>,
  profile: SystemOneResultProfile,
): Record<string, unknown> {
  const levels = levelsOf(question)
  const probabilities = answer.probabilities as Record<string, unknown>
  const keys = Object.keys(probabilities)
  if (
    keys.length !== levels.length ||
    levels.some((level) => {
      const value = probabilities[level]
      return (
        !Object.hasOwn(probabilities, level) ||
        typeof value !== 'number' ||
        !(value >= 0 && value <= 1)
      )
    })
  ) {
    // Leave shapes the strict parser refuses for it to name.
    return answer
  }
  const q = probabilities as Record<string, number>
  const sum = keys.reduce((total, key) => total + q[key]!, 0)
  const scored = question.type === 'score'
  const score = answer.score
  if (scored && (typeof score !== 'number' || !Number.isFinite(score))) return answer
  let next = answer
  const consistent =
    Math.abs(sum - 1) <= TOLERANCE &&
    (!scored || Math.abs((score as number) - expectation(levels, q)) <= TOLERANCE)
  if (!consistent && profile.decimals !== undefined) {
    // Rounding to `decimals` moves each reported probability by at most one unit in the last
    // place, and the reported score by half a unit; anything larger is a provider defect.
    const unit = 10 ** -profile.decimals
    if (Math.abs(sum - 1) > (levels.length * unit) / 2) {
      throw new SystemOneResponseError('Distribution error exceeds declared rounding')
    }
    const levelTotal = (levels.length * (levels.length - 1)) / 2
    if (
      scored &&
      Math.abs((score as number) - expectation(levels, q)) > unit / 2 + unit * levelTotal
    ) {
      throw new SystemOneResponseError('Score error exceeds declared rounding')
    }
    const p =
      Math.abs(sum - 1) <= TOLERANCE
        ? q
        : Object.fromEntries(keys.map((key) => [key, q[key]! / sum]))
    next = { ...answer, probabilities: p, ...(scored ? { score: expectation(levels, p) } : {}) }
  }
  // An answer that already carries provider_confidence was normalized before.
  if (
    profile.confidence === 'provider-defined' &&
    typeof answer.confidence === 'number' &&
    !Object.hasOwn(answer, 'provider_confidence')
  ) {
    next = {
      ...next,
      provider_confidence: answer.confidence,
      confidence: systemOneConfidence({
        type: question.type,
        probabilities: next.probabilities as Record<string, number>,
      }),
    }
  }
  return next
}

/**
 * Remove a provider's declared rounding and apply the one confidence definition, before
 * `parseSystemOneResult`. An answer that already passes the strict checks keeps its
 * probabilities and score. One that fails them only within the declared rounding is renormalized
 * and its score recomputed from that distribution; larger error throws. Noul answers never change.
 * Returns `raw` itself when nothing changes and never mutates it; shapes it cannot read are left
 * for the strict parser to refuse.
 */
export function normalizeSystemOneResult(
  raw: unknown,
  request: SystemOneRecordedRequest,
  profile: SystemOneResultProfile,
): unknown {
  readProfile(profile)
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return raw
  const response = raw as Record<string, unknown>
  const original = response.answers
  if (original === null || typeof original !== 'object' || Array.isArray(original)) return raw
  const answers: Record<string, unknown> = { ...original }
  let changed = false
  for (const [name, question] of Object.entries(request.questions)) {
    const answer = answers[name]
    if (
      question.type === 'noul' ||
      answer === null ||
      typeof answer !== 'object' ||
      Array.isArray(answer) ||
      (answer as Record<string, unknown>).type !== question.type ||
      (answer as Record<string, unknown>).probabilities === null ||
      typeof (answer as Record<string, unknown>).probabilities !== 'object' ||
      Array.isArray((answer as Record<string, unknown>).probabilities)
    ) {
      continue
    }
    const next = normalizeAnswer(answer as Record<string, unknown>, question, profile)
    if (next !== answer) {
      answers[name] = next
      changed = true
    }
  }
  return changed ? { ...response, answers } : raw
}
