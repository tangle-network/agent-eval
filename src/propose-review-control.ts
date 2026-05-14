import {
  type ControlRunResult,
  type ControlRuntimeConfig,
  objectiveEval,
  runAgentControlLoop,
} from './control-runtime'
import {
  inMemoryReviewStore,
  type ProposeFn,
  type ProposeOutput,
  type Review,
  type ReviewFn,
  type ReviewMemoryEntry,
  type ReviewMemoryStore,
  type Verification,
  type VerifyFn,
} from './propose-review'
import type { FailureClass } from './trace/schema'
import type { TraceStore } from './trace/store'

export interface ProposeReviewControlState<State, Summary = unknown> {
  shot: number
  state: State
  priorReview: Review | null
  verification: Verification
  traceSummary?: Summary
  memory: ReviewMemoryEntry[]
  completed: boolean
  reviewAvailable: boolean
  reviewError?: string
}

export interface ProposeReviewControlAction {
  type: 'propose-review-shot'
  shot: number
}

export interface ProposeReviewControlResult<State, Summary = unknown> {
  state: State
  verification: Verification
  traceSummary?: Summary
  review: Review | null
  reviewAvailable: boolean
  reviewError?: string
}

export interface ProposeReviewControlConfig<State, Summary = unknown> {
  goal: string
  initialState: State
  propose: ProposeFn<State, Summary>
  verify: VerifyFn<State>
  review: ReviewFn<State, Summary>
  maxShots?: number
  maxWallMs?: number
  memory?: ReviewMemoryStore
  store?: TraceStore
  scenarioId?: string
  projectId?: string
  variantId?: string
  fallbackInstruction?: string
  confidenceFloor?: number
  confidenceFloorWindow?: number
  failureClassFromVerification?: (verification: Verification) => FailureClass | undefined
  actionFailure?: ControlRuntimeConfig<
    ProposeReviewControlState<State, Summary>,
    ProposeReviewControlAction,
    ProposeReviewControlResult<State, Summary>
  >['actionFailure']
}

const DEFAULT_FALLBACK_INSTRUCTION =
  'Inspect the verification failures above. Fix the critical issues first, then the major ones. Do not restate the failures — act on them.'

export async function runProposeReviewAsControlLoop<State, Summary = unknown>(
  config: ProposeReviewControlConfig<State, Summary>,
): Promise<
  ControlRunResult<
    ProposeReviewControlState<State, Summary>,
    ProposeReviewControlAction,
    ProposeReviewControlResult<State, Summary>
  >
> {
  const maxShots = config.maxShots ?? 10
  const confidenceFloor = config.confidenceFloor ?? 0.3
  const confidenceFloorWindow = config.confidenceFloorWindow ?? 2
  const memory = config.memory ?? inMemoryReviewStore()
  const fallbackInstruction = config.fallbackInstruction ?? DEFAULT_FALLBACK_INSTRUCTION
  const failureClassFromVerification =
    config.failureClassFromVerification ?? controlFailureClassFromVerification
  let lowConfidenceStreak = 0

  let current: ProposeReviewControlState<State, Summary> = {
    shot: 0,
    state: config.initialState,
    priorReview: null,
    verification: { pass: false },
    memory: await memory.load(),
    completed: false,
    reviewAvailable: false,
  }

  return runAgentControlLoop({
    intent: config.goal,
    budget: { maxSteps: maxShots, maxWallMs: config.maxWallMs },
    store: config.store,
    scenarioId: config.scenarioId ?? 'propose-review-control',
    projectId: config.projectId,
    variantId: config.variantId,
    actionFailure: config.actionFailure ?? 'stop',
    observe: () => current,
    validate: ({ state }) => [
      objectiveEval({
        id: 'verification',
        passed: state.verification.pass,
        score: state.verification.score,
        severity: 'critical',
        detail: state.verification.pass
          ? 'verification passed'
          : `verification failed${state.verification.failingLayers?.length ? `: ${state.verification.failingLayers.join(', ')}` : ''}`,
      }),
    ],
    shouldStop: ({ state }) => {
      if (state.verification.pass) {
        return {
          stop: true,
          pass: true,
          reason: 'verification passed',
          score: state.verification.score,
        }
      }
      if (state.completed) {
        return {
          stop: true,
          pass: false,
          reason: 'reviewer stopped continuation',
          score: state.verification.score,
          failureClass: failureClassFromVerification(state.verification),
        }
      }
      return {
        stop: false,
        pass: false,
        reason: 'verification still failing',
        score: state.verification.score,
      }
    },
    decide: ({ state }) => ({
      type: 'continue',
      action: { type: 'propose-review-shot', shot: state.shot + 1 },
      reason: state.priorReview?.nextShotInstruction ?? fallbackInstruction,
    }),
    act: async (action, ctx) => {
      const shot = action.shot
      const proposeOut: ProposeOutput<State, Summary> = await config.propose({
        shot,
        goal: config.goal,
        state: current.state,
        priorReview: current.priorReview,
        abortSignal: ctx.abortSignal,
        emitter: ctx.emitter,
      })

      const nextState = proposeOut.state
      const verification = await config.verify(nextState)
      let review: Review | null = null
      let reviewAvailable = false
      let reviewError: string | undefined
      let shouldContinue = !verification.pass

      if (!verification.pass) {
        try {
          review = await config.review({
            shot,
            goal: config.goal,
            state: nextState,
            verification,
            traceSummary: proposeOut.traceSummary,
            memory: await memory.load(),
          })
          reviewAvailable = true
          shouldContinue = review.shouldContinue
          lowConfidenceStreak = review.confidence <= confidenceFloor ? lowConfidenceStreak + 1 : 0
          if (confidenceFloorWindow > 0 && lowConfidenceStreak >= confidenceFloorWindow)
            shouldContinue = false
        } catch (err) {
          reviewError = err instanceof Error ? err.message : String(err)
          review = current.priorReview ?? {
            observations: 'Reviewer unavailable.',
            diagnosis: reviewError,
            nextShotInstruction: fallbackInstruction,
            shouldContinue: true,
            confidence: 0,
          }
          shouldContinue = true
        }
      } else {
        review = {
          observations: 'Verification passed.',
          diagnosis: 'No further revision needed.',
          nextShotInstruction: '',
          shouldContinue: false,
          confidence: 1,
        }
      }

      const entry: ReviewMemoryEntry = {
        ...(review ?? {
          observations: 'No review.',
          diagnosis: '',
          nextShotInstruction: fallbackInstruction,
          shouldContinue,
          confidence: 0,
        }),
        shot,
        timestamp: Date.now(),
        verification: {
          pass: verification.pass,
          score: verification.score,
          failingLayers: verification.failingLayers,
        },
      }
      await memory.append(entry)

      current = {
        shot,
        state: nextState,
        priorReview: review,
        verification,
        traceSummary: proposeOut.traceSummary,
        memory: await memory.load(),
        completed: verification.pass || !shouldContinue,
        reviewAvailable,
        reviewError,
      }

      return {
        state: nextState,
        verification,
        traceSummary: proposeOut.traceSummary,
        review,
        reviewAvailable,
        reviewError,
      }
    },
  })
}

export function controlFailureClassFromVerification(
  verification: Verification,
): FailureClass | undefined {
  if (verification.pass) return undefined
  return verification.failingLayers?.length ? 'instruction_following' : 'unknown'
}
