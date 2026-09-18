/** Native TypeSafe System One values. The vendor SDK can supply the transport. */
export type JevState = string | Record<string, unknown> | unknown[]
export type JevQuestion =
  | { type: 'noul'; instructions: JevState; criteria?: { true?: string; false?: string } }
  | { type: 'choice'; instructions: JevState; criteria: Record<string, string | null> }
  | { type: 'score'; instructions: JevState; criteria: string[] }
export interface JevRequest {
  model: string
  state: JevState
  questions: Record<string, JevQuestion>
}
export type JevAnswer =
  | { type: 'noul'; noul: number }
  | { type: 'choice'; choice: string; probabilities: Record<string, number>; confidence: number }
  | { type: 'score'; score: number; probabilities: Record<string, number>; legend: Record<string, string>; confidence: number }
export interface JevResponse {
  model: string
  answers: Record<string, JevAnswer>
  usage: { input_tokens: number; output_tokens: number }
}

export class JevResponseError extends Error {
  readonly code = 'INVALID_JEV_RESPONSE'
  constructor(message: string) { super(message); this.name = 'JevResponseError' }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function probability(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
}
export function jevUsage(value: unknown): JevResponse['usage'] | undefined {
  if (!record(value) || !record(value.usage)) return undefined
  const { input_tokens: input, output_tokens: output } = value.usage
  if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < 0 ||
      typeof output !== 'number' || !Number.isSafeInteger(output) || output < 0) return undefined
  return { input_tokens: input, output_tokens: output }
}

export function validateJevRequest(request: JevRequest): void {
  if (!request.model.trim() || !record(request.questions) || Object.keys(request.questions).length === 0) {
    throw new TypeError('Jev requires an explicit model and nonempty questions')
  }
  if (!(typeof request.state === 'string' || record(request.state) || Array.isArray(request.state))) {
    throw new TypeError('Jev state must be text, an object, or an array')
  }
  for (const [key, q] of Object.entries(request.questions)) {
    if (!key.trim() || !record(q) || !(typeof q.instructions === 'string' || record(q.instructions) || Array.isArray(q.instructions))) {
      throw new TypeError(`Invalid Jev question: ${key}`)
    }
    if (q.type === 'score') {
      if (!Array.isArray(q.criteria) || q.criteria.length < 2 || q.criteria.some(x => typeof x !== 'string')) throw new TypeError(`Invalid score criteria: ${key}`)
    } else if (q.type === 'choice') {
      if (!record(q.criteria) || Object.keys(q.criteria).length < 2 || Object.values(q.criteria).some(x => x !== null && typeof x !== 'string')) throw new TypeError(`Invalid choice criteria: ${key}`)
    } else if (q.type === 'noul') {
      if (q.criteria !== undefined && (!record(q.criteria) || Object.entries(q.criteria).some(([k, v]) => !['true', 'false'].includes(k) || typeof v !== 'string'))) throw new TypeError(`Invalid noul criteria: ${key}`)
    } else throw new TypeError(`Unknown Jev question type: ${key}`)
  }
  // Refuse cycles and BigInt before spending anything.
  JSON.stringify(request)
}

/** Validate answers against THIS request; never coerce a missing answer into a score. */
export function parseJevResponse(value: unknown, request: JevRequest): JevResponse {
  const fail = (detail: string): never => { throw new JevResponseError(detail) }
  if (!record(value) || typeof value.model !== 'string' || !value.model.trim() || !record(value.answers)) return fail('Missing model or answers')
  const usage = jevUsage(value)
  if (!usage) return fail('Missing or invalid usage')
  // Explicit versions cannot quietly become another model. Aliases report their resolved model.
  const requested = request.model.replace(/^typesafe\//, '')
  const served = value.model.replace(/^typesafe\//, '')
  if (!['jev-latest', 'jev-preview'].includes(requested) && served !== requested) return fail('Served model differs from pinned model')
  const keys = Object.keys(request.questions)
  if (Object.keys(value.answers).length !== keys.length) return fail('Answer keys differ from question keys')
  const answers: Record<string, JevAnswer> = Object.create(null)
  for (const key of keys) {
    const q = request.questions[key]
    const a = Object.hasOwn(value.answers, key) ? value.answers[key] : undefined
    if (!record(a) || a.type !== q.type) return fail(`Missing or mismatched answer: ${key}`)
    if (q.type === 'noul') {
      if (!probability(a.noul)) return fail(`Invalid noul: ${key}`)
      answers[key] = { type: 'noul', noul: a.noul }
      continue
    }
    if (!probability(a.confidence) || !record(a.probabilities)) return fail(`Invalid distribution: ${key}`)
    const options = q.type === 'choice' ? Object.keys(q.criteria) : q.criteria.map((_, i) => String(i))
    if (Object.keys(a.probabilities).length !== options.length) return fail(`Invalid distribution keys: ${key}`)
    const probabilities: Record<string, number> = Object.create(null)
    for (const option of options) {
      const p = Object.hasOwn(a.probabilities, option) ? a.probabilities[option] : undefined
      if (!probability(p)) return fail(`Invalid probability: ${key}/${option}`)
      probabilities[option] = p
    }
    // Tolerate wire rounding, not missing or invented probability mass.
    if (Math.abs(Object.values(probabilities).reduce((sum, p) => sum + p, 0) - 1) > 1e-4) return fail(`Probability mass does not sum to one: ${key}`)
    if (q.type === 'choice') {
      if (typeof a.choice !== 'string' || !Object.hasOwn(probabilities, a.choice)) return fail(`Unknown choice: ${key}`)
      if (probabilities[a.choice] + 1e-4 < Math.max(...Object.values(probabilities))) return fail(`Choice is not highest probability: ${key}`)
      answers[key] = { type: 'choice', choice: a.choice, probabilities, confidence: a.confidence }
    } else {
      if (typeof a.score !== 'number' || !Number.isFinite(a.score) || a.score < 0 || a.score > q.criteria.length - 1 || !record(a.legend)) return fail(`Invalid score: ${key}`)
      if (Object.keys(a.legend).length !== options.length || options.some((k, i) => !Object.hasOwn(a.legend as object, k) || (a.legend as Record<string, unknown>)[k] !== q.criteria[i])) return fail(`Score legend differs from rubric: ${key}`)
      const expected = options.reduce((sum, k) => sum + Number(k) * probabilities[k], 0)
      if (Math.abs(expected - a.score) > 1e-3 * Math.max(1, q.criteria.length - 1)) return fail(`Score differs from distribution: ${key}`)
      answers[key] = { type: 'score', score: a.score, probabilities, legend: Object.fromEntries(q.criteria.map((v, i) => [String(i), v])), confidence: a.confidence }
    }
  }
  return { model: value.model, answers, usage }
}
