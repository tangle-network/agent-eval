/**
 * Propose / Verify / Review — the core multi-shot primitive.
 *
 *   shot N:  propose(state, priorReview) → new state
 *            verify(state)               → pass/fail, optional layers
 *            review(state, verification, memory) → observations + next-shot
 *                                                   instruction + shouldContinue
 *            memory.append(entry)
 *
 * Roles are strictly separated:
 *
 *   - The WORKER is whatever the caller wraps in `propose`. It is
 *     stateful — caller owns its resume/session mechanism.
 *   - The VERIFIER grades the state. It produces the ground truth.
 *     The reviewer cannot overturn or downgrade a verification layer.
 *   - The REVIEWER is stateless per call. Its continuity is the
 *     `ReviewMemoryStore` — durable JSONL by default, or any store
 *     implementing the interface. It reads memory + trace summary +
 *     verification and directs the NEXT proposer shot.
 *
 * This shape is load-bearing. The reviewer never grades; the verifier
 * never directs. Two processes, two prompts, two concerns — which is
 * what keeps the loop from confirmation-biasing itself into "all
 * passed" when it didn't.
 *
 * Short-circuits and soft-fails are both first-class:
 *   - verify.pass === true  → reviewer LLM call is skipped, memory
 *     records a success entry, loop exits.
 *   - review throws         → the shot still counts; the loop uses the
 *     last-known instruction (or `fallbackInstruction`) for the next
 *     propose call. A transient reviewer failure must NEVER abort a
 *     valid arc.
 *
 * Composable: `propose` itself can be another `runProposeReview` call.
 * That's the dogfooding path — a harness built on this primitive is in
 * turn evaluable by it.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { type SpanHandle, TraceEmitter } from './trace/emitter'
import type { FailureClass } from './trace/schema'
import type { TraceStore } from './trace/store'

// ── Types ────────────────────────────────────────────────────────────

export interface Verification {
  pass: boolean
  score?: number
  failingLayers?: string[]
  details?: unknown
}

export interface Review {
  observations: string
  diagnosis: string
  nextShotInstruction: string
  shouldContinue: boolean
  confidence: number
}

export interface ReviewMemoryEntry extends Review {
  shot: number
  timestamp: number
  verification: {
    pass: boolean
    score?: number
    failingLayers?: string[]
  }
}

export interface ProposeInput<State> {
  shot: number
  goal: string
  state: State
  priorReview: Review | null
  abortSignal: AbortSignal
  emitter?: TraceEmitter
}

export interface ProposeOutput<State, Summary = unknown> {
  state: State
  traceSummary?: Summary
}

export interface ReviewInput<State, Summary = unknown> {
  shot: number
  goal: string
  state: State
  verification: Verification
  traceSummary: Summary | undefined
  memory: ReviewMemoryEntry[]
}

export type ProposeFn<State, Summary = unknown> = (
  input: ProposeInput<State>,
) => Promise<ProposeOutput<State, Summary>>

export type VerifyFn<State> = (state: State) => Promise<Verification>

export type ReviewFn<State, Summary = unknown> = (
  input: ReviewInput<State, Summary>,
) => Promise<Review>

export interface ReviewMemoryStore {
  load(): Promise<ReviewMemoryEntry[]>
  append(entry: ReviewMemoryEntry): Promise<void>
}

export interface ProposeReviewConfig<State, Summary = unknown> {
  goal: string
  initialState: State
  propose: ProposeFn<State, Summary>
  verify: VerifyFn<State>
  review: ReviewFn<State, Summary>
  /** Hard shot cap. Default 10. */
  maxShots?: number
  /** Wall-clock cap in ms. Default 10 min. */
  maxWallMs?: number
  /**
   * If the reviewer returns confidence ≤ floor on `confidenceFloorWindow`
   * consecutive shots, terminate early. Default floor 0.3, window 2.
   * Set window to 0 or floor to <0 to disable.
   */
  confidenceFloor?: number
  confidenceFloorWindow?: number
  /** Defaults to an in-memory store if omitted. */
  memory?: ReviewMemoryStore
  /** If provided, emit a Run + per-shot spans. */
  store?: TraceStore
  scenarioId?: string
  projectId?: string
  variantId?: string
  /**
   * Used when the reviewer soft-fails on shot 1 (no prior instruction to
   * fall back to). Default is a generic "inspect failures and fix".
   */
  fallbackInstruction?: string
}

export interface ProposeReviewShot<State, Summary = unknown> {
  shot: number
  state: State
  verification: Verification
  traceSummary: Summary | undefined
  review: Review
  reviewAvailable: boolean
  reviewError?: string
  durationMs: number
}

export interface ProposeReviewReport<State, Summary = unknown> {
  runId: string | null
  completed: boolean
  shots: ProposeReviewShot<State, Summary>[]
  finalState: State
  finalVerification: Verification
  failureClass?: FailureClass
  wallMs: number
  score: number
}

// ── Memory stores ────────────────────────────────────────────────────

export function inMemoryReviewStore(initial: ReviewMemoryEntry[] = []): ReviewMemoryStore {
  const entries: ReviewMemoryEntry[] = [...initial]
  return {
    async load() {
      return [...entries]
    },
    async append(entry) {
      entries.push(entry)
    },
  }
}

export function jsonlReviewStore(path: string): ReviewMemoryStore {
  return {
    async load() {
      if (!existsSync(path)) return []
      const raw = readFileSync(path, 'utf8')
      const out: ReviewMemoryEntry[] = []
      for (const line of raw.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed) continue
        try {
          out.push(JSON.parse(trimmed) as ReviewMemoryEntry)
        } catch {
          // A corrupt line is an observability problem, not a correctness
          // one — skip it rather than aborting the loop.
        }
      }
      return out
    },
    async append(entry) {
      mkdirSync(dirname(path), { recursive: true })
      appendFileSync(path, `${JSON.stringify(entry)}\n`)
    },
  }
}

// ── Core loop ────────────────────────────────────────────────────────

const DEFAULT_FALLBACK_INSTRUCTION =
  'Inspect the verification failures above. Fix the critical issues first, then the major ones. Do not restate the failures — act on them.'

export async function runProposeReview<State, Summary = unknown>(
  config: ProposeReviewConfig<State, Summary>,
): Promise<ProposeReviewReport<State, Summary>> {
  const maxShots = config.maxShots ?? 10
  const maxWallMs = config.maxWallMs ?? 10 * 60 * 1000
  const confidenceFloor = config.confidenceFloor ?? 0.3
  const confidenceFloorWindow = config.confidenceFloorWindow ?? 2
  const memory = config.memory ?? inMemoryReviewStore()
  const fallbackInstruction = config.fallbackInstruction ?? DEFAULT_FALLBACK_INSTRUCTION

  const emitter = config.store ? new TraceEmitter(config.store) : null
  if (emitter) {
    await emitter.startRun({
      scenarioId: config.scenarioId ?? 'propose-review',
      projectId: config.projectId,
      variantId: config.variantId,
      layer: 'meta',
      tags: {
        goal: config.goal.slice(0, 120),
        maxShots: String(maxShots),
      },
    })
  }

  const abort = new AbortController()
  const wallStart = Date.now()
  const wallTimer = setTimeout(
    () => abort.abort(new Error('propose-review wall timeout')),
    maxWallMs,
  )

  const shots: ProposeReviewShot<State, Summary>[] = []
  let state = config.initialState
  let priorReview: Review | null = null
  let lastVerification: Verification = { pass: false }
  let failureClass: FailureClass | undefined
  let completed = false
  let lowConfidenceStreak = 0

  try {
    for (let shot = 1; shot <= maxShots; shot++) {
      if (abort.signal.aborted) {
        failureClass = 'timeout'
        break
      }

      const shotStart = Date.now()
      const shotHandle = emitter ? await emitter.span({ kind: 'tool', name: `shot-${shot}` }) : null

      // 1. Propose.
      let proposeOut: ProposeOutput<State, Summary>
      try {
        proposeOut = await config.propose({
          shot,
          goal: config.goal,
          state,
          priorReview,
          abortSignal: abort.signal,
          emitter: emitter ?? undefined,
        })
      } catch (err) {
        await shotHandle?.fail(err instanceof Error ? err : String(err))
        failureClass = 'unknown'
        throw err
      }
      state = proposeOut.state
      const traceSummary = proposeOut.traceSummary

      // 2. Verify.
      let verification: Verification
      try {
        verification = await config.verify(state)
      } catch (err) {
        await shotHandle?.fail(err instanceof Error ? err : String(err))
        failureClass = 'unknown'
        throw err
      }
      lastVerification = verification

      // 3. Review — short-circuit on pass; soft-fail on throw.
      const memorySnapshot = await memory.load()
      const verificationDigest = {
        pass: verification.pass,
        score: verification.score,
        failingLayers: verification.failingLayers ?? [],
      }

      let review: Review
      let reviewAvailable = true
      let reviewError: string | undefined

      if (verification.pass) {
        review = {
          observations: 'verification passed — skipping reviewer LLM call',
          diagnosis: 'no failures to diagnose',
          nextShotInstruction: '(done)',
          shouldContinue: false,
          confidence: 1,
        }
      } else {
        try {
          review = await config.review({
            shot,
            goal: config.goal,
            state,
            verification,
            traceSummary,
            memory: memorySnapshot,
          })
          review = coerceReview(review)
        } catch (err) {
          reviewAvailable = false
          reviewError = err instanceof Error ? err.message : String(err)
          const lastInstruction =
            memorySnapshot.length > 0
              ? memorySnapshot[memorySnapshot.length - 1]!.nextShotInstruction
              : fallbackInstruction
          review = {
            observations: '(reviewer unavailable — using last-known instruction)',
            diagnosis: reviewError,
            nextShotInstruction: lastInstruction,
            shouldContinue: true,
            confidence: 0.3,
          }
        }
      }

      const entry: ReviewMemoryEntry = {
        shot,
        timestamp: Date.now(),
        ...review,
        verification: verificationDigest,
      }
      await memory.append(entry)

      const shotRecord: ProposeReviewShot<State, Summary> = {
        shot,
        state,
        verification,
        traceSummary,
        review,
        reviewAvailable,
        reviewError,
        durationMs: Date.now() - shotStart,
      }
      shots.push(shotRecord)

      await shotHandle?.end({
        attributes: {
          verificationPass: verification.pass,
          verificationScore: verification.score ?? null,
          reviewShouldContinue: review.shouldContinue,
          reviewConfidence: review.confidence,
          reviewAvailable,
        },
      } as Partial<SpanHandle['span']>)

      // 4. Exit rules.
      if (verification.pass) {
        completed = true
        break
      }
      if (!review.shouldContinue) {
        break
      }
      if (confidenceFloorWindow > 0 && review.confidence <= confidenceFloor) {
        lowConfidenceStreak += 1
        if (lowConfidenceStreak >= confidenceFloorWindow) break
      } else {
        lowConfidenceStreak = 0
      }

      priorReview = review
    }

    if (!completed && !failureClass) {
      failureClass = shots.length >= maxShots ? 'budget_exceeded' : 'unknown'
    }
  } finally {
    clearTimeout(wallTimer)
  }

  const score = lastVerification.pass
    ? 1
    : typeof lastVerification.score === 'number'
      ? lastVerification.score
      : 0

  if (emitter) {
    await emitter.endRun({
      pass: completed,
      score,
      failureClass,
      notes: `${shots.length} shot(s); final pass=${lastVerification.pass}`,
    })
  }

  return {
    runId: emitter?.runId ?? null,
    completed,
    shots,
    finalState: state,
    finalVerification: lastVerification,
    failureClass,
    wallMs: Date.now() - wallStart,
    score,
  }
}

// ── Reviewer helper (LLM-backed) ─────────────────────────────────────

export type LlmJsonCall = (req: { system: string; user: string }) => Promise<unknown>

export interface LlmReviewerConfig<State, Summary = unknown> {
  callJson: LlmJsonCall
  renderState?: (state: State) => string
  renderTraceSummary?: (summary: Summary | undefined) => string
  /** Appended to the default system prompt. */
  systemPromptAddendum?: string
}

const REVIEWER_SYSTEM_PROMPT = `You are a senior reviewer directing a multi-shot build loop.
You do NOT grade — the verifier already did. Your job is to direct the worker's next shot.
You are blind to the worker's inner monologue. You see what it DID, not what it thought.
Return STRICT JSON matching the schema. No prose outside the JSON.`

export function createLlmReviewer<State, Summary = unknown>(
  cfg: LlmReviewerConfig<State, Summary>,
): ReviewFn<State, Summary> {
  const renderState = cfg.renderState ?? ((s: State) => safeJson(s))
  const renderTraceSummary =
    cfg.renderTraceSummary ??
    ((s: Summary | undefined) => (s === undefined ? '(none)' : safeJson(s)))
  const system = cfg.systemPromptAddendum
    ? `${REVIEWER_SYSTEM_PROMPT}\n\n${cfg.systemPromptAddendum}`
    : REVIEWER_SYSTEM_PROMPT

  return async (input) => {
    const memoryBlock =
      input.memory.length === 0
        ? '(no prior shots — this is shot 1)'
        : input.memory
            .map((m) =>
              [
                `shot ${m.shot} — verification.pass=${m.verification.pass}` +
                  (typeof m.verification.score === 'number'
                    ? ` score=${m.verification.score.toFixed(2)}`
                    : '') +
                  ` confidence=${m.confidence.toFixed(2)} failing=[${(m.verification.failingLayers ?? []).join(',')}]`,
                `  observations: ${m.observations.slice(0, 400)}`,
                `  diagnosis: ${m.diagnosis.slice(0, 400)}`,
                `  instruction given: ${m.nextShotInstruction.slice(0, 400)}`,
              ].join('\n'),
            )
            .join('\n\n')

    const user = [
      `=== GOAL ===`,
      input.goal,
      ``,
      `=== SHOT NUMBER ===`,
      String(input.shot),
      ``,
      `=== CURRENT STATE ===`,
      renderState(input.state),
      ``,
      `=== TRACE SUMMARY ===`,
      renderTraceSummary(input.traceSummary),
      ``,
      `=== VERIFICATION ===`,
      summarizeVerification(input.verification),
      ``,
      `=== REVIEWER MEMORY (prior shots) ===`,
      memoryBlock,
      ``,
      `=== YOUR TASK ===`,
      `Return STRICT JSON:`,
      `{`,
      `  "observations": string (20..2000 chars, first-person worker behavior — quote counts, errors, loops)`,
      `  "diagnosis": string (20..1500 chars, root cause, NOT a restatement of verification)`,
      `  "nextShotInstruction": string (40..3000 chars, concrete directive to the worker)`,
      `  "shouldContinue": boolean (false if verification.pass, or if thrashing, or unachievable)`,
      `  "confidence": number in [0,1]`,
      `}`,
    ].join('\n')

    const raw = await cfg.callJson({ system, user })
    return coerceReview(raw as Partial<Review>)
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

function coerceReview(raw: Partial<Review> | null | undefined): Review {
  if (!raw || typeof raw !== 'object') {
    throw new Error('reviewer returned non-object')
  }
  const observations = typeof raw.observations === 'string' ? raw.observations : ''
  const diagnosis = typeof raw.diagnosis === 'string' ? raw.diagnosis : ''
  const nextShotInstruction =
    typeof raw.nextShotInstruction === 'string' ? raw.nextShotInstruction : ''
  if (!observations || !diagnosis || !nextShotInstruction) {
    throw new Error('reviewer missing required string fields')
  }
  if (typeof raw.shouldContinue !== 'boolean') {
    throw new Error('reviewer missing shouldContinue boolean')
  }
  const confidenceRaw = Number(raw.confidence)
  if (!Number.isFinite(confidenceRaw)) {
    throw new Error('reviewer confidence not finite')
  }
  return {
    observations,
    diagnosis,
    nextShotInstruction,
    shouldContinue: raw.shouldContinue,
    confidence: Math.max(0, Math.min(1, confidenceRaw)),
  }
}

function summarizeVerification(v: Verification): string {
  const header =
    `pass=${v.pass}` +
    (typeof v.score === 'number' ? ` score=${v.score.toFixed(3)}` : '') +
    (v.failingLayers && v.failingLayers.length > 0
      ? ` failing=[${v.failingLayers.join(', ')}]`
      : '')
  const details = v.details === undefined ? '' : `\n${safeJson(v.details).slice(0, 1500)}`
  return header + details
}

function safeJson(x: unknown): string {
  try {
    return JSON.stringify(x, null, 2)
  } catch {
    return String(x)
  }
}
