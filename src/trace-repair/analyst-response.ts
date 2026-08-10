/**
 * What an analyst is allowed to say about a blinded trajectory prefix.
 *
 * Exactly one of two answers:
 *
 *   a finding                {k, failureClaim, intervention}
 *   the literal string       no-decisive-failure
 *
 * Nothing else parses. A finding names one step, states what went wrong
 * there, and supplies one action to run instead. Declining is a real answer
 * with its own cell in the funnel, not a parse failure — an admitted row has
 * a failure by construction, but it need not have a single-action repair, and
 * an analyst that says so is answering the question it was asked.
 */

import { ValidationError } from '../errors'
import type { ActionPayloadKind } from './action-budget'

/** The literal an analyst returns when no single step carries the failure. */
export const NO_DECISIVE_FAILURE = 'no-decisive-failure'

export interface RepairIntervention {
  /** What the action is: a shell command, or an edit that authors file content. */
  readonly kind: ActionPayloadKind
  /** The action itself, exactly as it will be executed at step k. */
  readonly action: string
}

export interface RepairFinding {
  readonly kind: 'finding'
  /** 1-based step the analyst blames. The repair must work here; there is no
   *  credit for naming a step and repairing elsewhere. */
  readonly k: number
  /** What the analyst says went wrong at step k. Recorded, never scored: a
   *  claim graded by another model would put a judge inside the metric. */
  readonly failureClaim: string
  readonly intervention: RepairIntervention
}

export interface RepairDeclined {
  readonly kind: 'no-decisive-failure'
}

export type AnalystResponse = RepairFinding | RepairDeclined

/** Why a response does not parse. Counted by name in the funnel. */
export type ResponseParseFailure =
  | 'unreadable'
  | 'not-a-single-answer'
  | 'missing-k'
  | 'missing-failure-claim'
  | 'missing-intervention'
  | 'unknown-intervention-kind'

export type ParseAnalystResponseOutcome =
  | { readonly succeeded: true; readonly value: AnalystResponse }
  | { readonly succeeded: false; readonly failure: ResponseParseFailure; readonly detail: string }

/**
 * Read an analyst reply.
 *
 * Accepts the bare literal, or a JSON object carrying one finding. The reply
 * is untrusted text, so every field is checked and nothing is defaulted: a
 * missing `k` is a parse failure, never step 1.
 */
export function parseAnalystResponse(reply: string): ParseAnalystResponseOutcome {
  const trimmed = reply.trim()
  if (trimmed.length === 0) {
    return { succeeded: false, failure: 'unreadable', detail: 'the reply is empty' }
  }
  if (trimmed === NO_DECISIVE_FAILURE) {
    return { succeeded: true, value: { kind: 'no-decisive-failure' } }
  }

  const json = extractJsonObject(trimmed)
  if (!json) {
    return {
      succeeded: false,
      failure: 'unreadable',
      detail: `expected the literal "${NO_DECISIVE_FAILURE}" or one JSON object`,
    }
  }
  if (json.count > 1) {
    return {
      succeeded: false,
      failure: 'not-a-single-answer',
      detail: `the reply carries ${json.count} findings; exactly one is allowed`,
    }
  }

  const body = json.value
  if (body.no_decisive_failure === true || body.finding === NO_DECISIVE_FAILURE) {
    return { succeeded: true, value: { kind: 'no-decisive-failure' } }
  }

  const k = body.k
  if (typeof k !== 'number' || !Number.isInteger(k)) {
    return {
      succeeded: false,
      failure: 'missing-k',
      detail: `k must be an integer, got ${describe(k)}`,
    }
  }
  const failureClaim = body.failure_claim ?? body.failureClaim
  if (typeof failureClaim !== 'string' || failureClaim.trim().length === 0) {
    return {
      succeeded: false,
      failure: 'missing-failure-claim',
      detail: 'failure_claim must be a non-empty string',
    }
  }
  const raw = body.intervention
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return {
      succeeded: false,
      failure: 'missing-intervention',
      detail: 'intervention must be an object with kind and action',
    }
  }
  const intervention = raw as Record<string, unknown>
  const action = intervention.action
  if (typeof action !== 'string') {
    return {
      succeeded: false,
      failure: 'missing-intervention',
      detail: 'intervention.action must be a string',
    }
  }
  const kind = intervention.kind
  if (kind !== 'shell' && kind !== 'edit') {
    return {
      succeeded: false,
      failure: 'unknown-intervention-kind',
      detail: `intervention.kind must be "shell" or "edit", got ${describe(kind)}`,
    }
  }

  return {
    succeeded: true,
    value: {
      kind: 'finding',
      k,
      failureClaim: failureClaim.trim(),
      intervention: { kind, action },
    },
  }
}

/** Build a finding directly, for callers that already hold typed fields. */
export function repairFinding(input: {
  k: number
  failureClaim: string
  intervention: RepairIntervention
}): RepairFinding {
  if (!Number.isInteger(input.k) || input.k < 1) {
    throw new ValidationError(`repair finding k must be a positive integer, got ${input.k}`)
  }
  if (input.failureClaim.trim().length === 0) {
    throw new ValidationError('repair finding requires a non-empty failure claim')
  }
  return {
    kind: 'finding',
    k: input.k,
    failureClaim: input.failureClaim.trim(),
    intervention: input.intervention,
  }
}

function describe(value: unknown): string {
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  return typeof value === 'string' ? JSON.stringify(value) : String(value)
}

/**
 * Pull the single JSON object out of a reply, tolerating a fenced block and
 * surrounding prose. `count` reports how many top-level objects were found so
 * a reply hedging with several findings is rejected rather than silently
 * reduced to the first one.
 */
function extractJsonObject(
  reply: string,
): { value: Record<string, unknown>; count: number } | null {
  const fenced = [...reply.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)].map((m) => m[1]!.trim())
  const candidates = fenced.length > 0 ? fenced : [reply]
  const parsed: Record<string, unknown>[] = []
  for (const candidate of candidates) {
    for (const slice of topLevelObjectSlices(candidate)) {
      try {
        const value = JSON.parse(slice) as unknown
        if (Array.isArray(value)) {
          for (const item of value) {
            if (isPlainObject(item)) parsed.push(item)
          }
        } else if (isPlainObject(value)) {
          parsed.push(value)
        }
      } catch {
        // A slice that does not parse is not an answer; keep scanning.
      }
    }
  }
  if (parsed.length === 0) return null
  return { value: parsed[0]!, count: parsed.length }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Balanced `{…}` and `[…]` slices at the top level of a candidate string. */
function topLevelObjectSlices(text: string): string[] {
  const slices: string[] = []
  let depth = 0
  let start = -1
  let inString = false
  let escaped = false
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]!
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
      continue
    }
    if (char === '{' || char === '[') {
      if (depth === 0) start = i
      depth += 1
      continue
    }
    if (char === '}' || char === ']') {
      depth -= 1
      if (depth === 0 && start >= 0) {
        slices.push(text.slice(start, i + 1))
        start = -1
      }
      if (depth < 0) depth = 0
    }
  }
  return slices
}
