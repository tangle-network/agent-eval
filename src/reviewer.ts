/**
 * Reviewer primitives — prompt builder + default ReviewFn factory.
 *
 * `buildReviewerPrompt` is the pure, LLM-agnostic piece: takes
 * `ReviewerPromptInput` (user request, trace summary, verification
 * summary, memory, optional extra context) and emits the system +
 * user message pair. No LLM dependency — callers that want to drive
 * their own transport get full control.
 *
 * `createDefaultReviewer` is the convenience factory: wires the prompt
 * builder to `callLlmJson` with a default schema + soft-fail policy.
 * Returns a function that maps `ReviewerPromptInput` to `ReviewerOutput`.
 *
 * Same pattern as `runSemanticConceptJudge` / `createSemanticConceptJudge`:
 * low-level pure builder + high-level factory built on top.
 */

import { callLlmJson, type LlmClientOptions } from './llm-client'

// ─── Types ──────────────────────────────────────────────────────────────

export interface ReviewerMemoryEntry {
  shot: number
  ts?: string
  observations?: string
  diagnosis?: string
  nextShotInstruction?: string
  shouldContinue?: boolean
  confidence?: number
}

export interface ReviewerVerificationSummary {
  blendedScore: number
  allPass: boolean
  failCount: number
  failingLayers?: string[]
}

export interface ReviewerPromptInput {
  shot: number
  userRequest: string
  /**
   * Compact trace summary — tool-call counts, errors, recent activity
   * lines. Built by the caller from whatever trace format they have;
   * agent-eval does not prescribe.
   */
  traceSummary: string
  verification: ReviewerVerificationSummary
  memory: ReviewerMemoryEntry[]
  /**
   * Optional extra context injected into the prompt between the trace
   * and the verification blocks. Use for workdir file-tree snapshots,
   * scaffold descriptions, or any environmental fact the reviewer
   * needs to direct the next shot accurately.
   */
  extraContext?: string
  /**
   * Optional extra section appended at the end of the prompt (e.g.
   * leaf metadata, scenario id). Free-form — no agent-eval-shaped
   * schema.
   */
  trailingContext?: string
}

export interface ReviewerOutput {
  shot: number
  observations: string
  diagnosis: string
  nextShotInstruction: string
  shouldContinue: boolean
  /** 0..1 self-assessed confidence in the directive. */
  confidence: number
  /** LLM cost in USD if the transport reports it, else null. */
  costUsd: number | null
  durationMs: number
  /** False when the LLM errored or returned malformed JSON; caller soft-fails to defaults. */
  available: boolean
  error?: string
}

export interface ReviewerSoftFailDefaults {
  observations?: string
  diagnosis?: string
  nextShotInstruction?: string
  shouldContinue?: boolean
  confidence?: number
}

export interface CreateDefaultReviewerOptions {
  /** Model id to call. */
  model: string
  /** Per-call timeout. Default 180s. */
  timeoutMs?: number
  /** LlmClient transport config (baseUrl, apiKey, authHeader, etc.). */
  llm?: LlmClientOptions
  /**
   * Override the prompt builder. Default: `buildReviewerPrompt`.
   * Consumers with different reviewer voices pass their own.
   */
  promptBuilder?: (input: ReviewerPromptInput) => { system: string; user: string }
  /**
   * Soft-fail values when the LLM throws or returns unparseable JSON.
   * Matches VerticalBench's shipped policy: continue with generic
   * instruction at confidence 0.3 so the worker keeps trying.
   */
  softFailDefaults?: ReviewerSoftFailDefaults
}

// ─── JSON schema ───────────────────────────────────────────────────────

const REVIEWER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['observations', 'diagnosis', 'nextShotInstruction', 'shouldContinue', 'confidence'],
  properties: {
    observations: { type: 'string', minLength: 20, maxLength: 2000 },
    diagnosis: { type: 'string', minLength: 20, maxLength: 1500 },
    nextShotInstruction: { type: 'string', minLength: 40, maxLength: 3000 },
    shouldContinue: { type: 'boolean' },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
  },
} as const

// ─── Prompt builder ────────────────────────────────────────────────────

function summarizeMemory(memory: ReviewerMemoryEntry[]): string {
  if (memory.length === 0) return '(no prior shots)'
  return memory
    .map((m) => {
      const header = `shot ${m.shot} — confidence=${(m.confidence ?? 0).toFixed(2)} shouldContinue=${m.shouldContinue ?? '?'}`
      const obs = m.observations ? `  observations: ${m.observations.slice(0, 400)}` : ''
      const diag = m.diagnosis ? `  diagnosis: ${m.diagnosis.slice(0, 400)}` : ''
      const instr = m.nextShotInstruction ? `  instruction given: ${m.nextShotInstruction.slice(0, 400)}` : ''
      return [header, obs, diag, instr].filter(Boolean).join('\n')
    })
    .join('\n\n')
}

/**
 * Build the reviewer's system + user messages. Pure function, no LLM
 * call. Callers that want their own transport or a different structured
 * output can use this and skip `createDefaultReviewer` entirely.
 */
export function buildReviewerPrompt(input: ReviewerPromptInput): { system: string; user: string } {
  const system =
    'You are a senior-engineer-grade reviewer directing an agent through a multi-shot build. ' +
    'Your job is NOT to grade; your job IS to direct the worker\'s next shot using the trace, ' +
    'verification result, prior memory, and user request. Return STRICT JSON. No prose outside the JSON.'

  const failingLayersBlock =
    input.verification.failingLayers && input.verification.failingLayers.length > 0
      ? `failing layers: ${input.verification.failingLayers.join(', ')}`
      : 'no layers failing'

  const user = `=== SHOT NUMBER ===
shot ${input.shot} of the review loop

=== USER REQUEST ===
${input.userRequest}

=== WORKER TRACE (shot ${input.shot}) ===
${input.traceSummary}
${input.extraContext ? `\n=== EXTRA CONTEXT ===\n${input.extraContext}\n` : ''}
=== VERIFICATION (shot ${input.shot}) ===
blendedScore: ${input.verification.blendedScore.toFixed(2)}
allPass: ${input.verification.allPass}
failCount: ${input.verification.failCount}
${failingLayersBlock}

=== REVIEWER MEMORY ===
${summarizeMemory(input.memory)}
${input.trailingContext ? `\n=== TRAILING CONTEXT ===\n${input.trailingContext}\n` : ''}
=== YOUR TASK ===
Return STRICT JSON:

1. observations (20-2000 chars): first-person worker behavior from the trace (tool call counts, errors, loops).
2. diagnosis (20-1500 chars): root cause of current failures, not a restatement of verification.
3. nextShotInstruction (40-3000 chars): concrete "FIX THESE:" directive for the worker's next shot. Reference memory when instructions repeat.
4. shouldContinue (boolean): FALSE if verification.allPass=true, if worker is thrashing, if confidence < 0.3, or if the request looks unachievable. TRUE otherwise.
5. confidence (0-1): self-assessment.

RULES:
- If verification.allPass is true, shouldContinue MUST be false.
- If memory shows the same failing layer for 2 shots, reduce confidence — strategy isn't working.
- If the trace shows zero tool calls, the worker didn't run — surface that.
- Do NOT re-grade. Direct.`

  return { system, user }
}

// ─── Default reviewer factory ───────────────────────────────────────────

const DEFAULT_SOFT_FAIL: Required<ReviewerSoftFailDefaults> = {
  observations: 'reviewer soft-failed — no observations captured',
  diagnosis: 'reviewer soft-failed — inspect verification findings and retry',
  nextShotInstruction:
    'Inspect the verification findings above and address the highest-severity failing layer first. ' +
    'If install failed, start there; otherwise work from the first failing gate and address compilation/build errors before layout/semantic issues.',
  shouldContinue: true,
  confidence: 0.3,
}

/**
 * Factory: returns a function that invokes the default reviewer against
 * an LLM and parses the structured output. Soft-fails to the provided
 * defaults on LLM throw or JSON-parse error so the shot loop keeps
 * moving rather than crashing.
 */
export function createDefaultReviewer(
  options: CreateDefaultReviewerOptions,
): (input: ReviewerPromptInput) => Promise<ReviewerOutput> {
  const softFail: Required<ReviewerSoftFailDefaults> = {
    ...DEFAULT_SOFT_FAIL,
    ...(options.softFailDefaults ?? {}),
  }
  const promptBuilder = options.promptBuilder ?? buildReviewerPrompt
  const timeoutMs = options.timeoutMs ?? 180_000

  return async (input) => {
    const start = Date.now()
    const { system, user } = promptBuilder(input)
    try {
      const { value, result } = await callLlmJson<{
        observations: string
        diagnosis: string
        nextShotInstruction: string
        shouldContinue: boolean
        confidence: number
      }>(
        {
          model: options.model,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          jsonSchema: { name: 'reviewer_output', schema: REVIEWER_SCHEMA },
          temperature: 0,
          timeoutMs,
        },
        options.llm ?? {},
      )

      return {
        shot: input.shot,
        observations: String(value.observations ?? softFail.observations),
        diagnosis: String(value.diagnosis ?? softFail.diagnosis),
        nextShotInstruction: String(value.nextShotInstruction ?? softFail.nextShotInstruction),
        shouldContinue: Boolean(value.shouldContinue),
        confidence: Math.max(0, Math.min(1, Number(value.confidence ?? softFail.confidence))),
        costUsd: result.costUsd ?? null,
        durationMs: Date.now() - start,
        available: true,
      }
    } catch (err) {
      return {
        shot: input.shot,
        observations: softFail.observations,
        diagnosis: softFail.diagnosis,
        nextShotInstruction: softFail.nextShotInstruction,
        shouldContinue: softFail.shouldContinue,
        confidence: softFail.confidence,
        costUsd: null,
        durationMs: Date.now() - start,
        available: false,
        error: err instanceof Error ? err.message : String(err),
      }
    }
  }
}
