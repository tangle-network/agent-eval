/**
 * Product-flow playback — drive the REAL product through a user story and
 * score the produced state per requirement (the launch "Jira tick-off").
 *
 * This is the substrate adapter + contract only. It plugs a `PlaybackDriver`
 * into the existing `runProfileMatrix` dispatch seam: a driver drives the real
 * product (a Playwright UI session or a sandbox workspace) and returns the
 * runtime event stream; `extractProducedState` + `verifyCompletion` then score
 * each requirement PASS/FAIL. The concrete drivers live in consumers — they
 * depend on browser / runtime infra the substrate must not import — so
 * agent-eval owns the seam, the `UserStory` contract, and the scoreboard.
 */

import type { AgentProfile } from '../../agent-profile'
import {
  type CompletionRequirement,
  type CompletionVerdict,
  type CorrectnessChecker,
  type ProducedState,
  verifyCompletion,
} from '../../completion-verifier'
import { extractProducedState, type RuntimeEventLike } from '../../produced-state'
import type { DispatchContext, Scenario } from '../types'
import type { ProfileDispatchFn } from './run-profile-matrix'

/** One step of a user story — what the user does. The driver interprets
 *  `payload` (a Playwright selector + action, or a sandbox chat turn). */
export interface PlaybackStep {
  /** Human-readable action, captured verbatim in the UX narrative. */
  action: string
  /** Driver-specific payload (e.g. `{ selector, fill }` or `{ turn }`). */
  payload?: Record<string, unknown>
}

/**
 * A user story = a runnable product journey plus the requirements that define
 * "this story works". Each requirement is one Jira ticket line. Extends
 * `Scenario` so a catalog drops straight into `runProfileMatrix({ scenarios })`.
 */
export interface UserStory extends Scenario {
  /** Human-readable story title (the ticket headline). */
  title: string
  /** Ordered steps the driver executes. */
  steps: PlaybackStep[]
  /** What must hold in the produced state for the story to pass. */
  requirements: CompletionRequirement[]
}

/** Dispatch context plus the profile under test (which cheap model, etc.). */
export interface PlaybackContext extends DispatchContext {
  profile: AgentProfile
}

/**
 * Drives the real product through a story and returns the runtime event stream
 * `extractProducedState` consumes. Implemented by CONSUMERS —
 * `SandboxPlaybackDriver` (real API / sandbox workspace) and
 * `PlaywrightPlaybackDriver` (real UI) — because they depend on runtime /
 * browser infra the substrate must not import. The driver MUST report LLM
 * usage via `ctx.cost.observeTokens` so the backend-integrity guard sees real
 * tokens (a run that never reports tokens reads as a stub).
 */
export interface PlaybackDriver<TStory extends UserStory = UserStory> {
  run(story: TStory, ctx: PlaybackContext): Promise<readonly RuntimeEventLike[]>
}

/**
 * Adapt a `PlaybackDriver` into a `runProfileMatrix` dispatch. The artifact the
 * matrix scores is the `ProducedState` extracted from the driver's event
 * stream — grade it with `scoreUserStory` (or a judge wrapping it).
 */
export function makePlaybackDispatch<TStory extends UserStory>(
  driver: PlaybackDriver<TStory>,
): ProfileDispatchFn<TStory, ProducedState> {
  return async (profile, scenario, ctx) => {
    const events = await driver.run(scenario, { ...ctx, profile })
    return extractProducedState(events)
  }
}

/** A scored user story — the completion verdict plus its human title. */
export interface UserStoryVerdict extends CompletionVerdict {
  title: string
}

/**
 * Score one story's produced state against its requirements. Thin wrapper over
 * `verifyCompletion` that builds the gold from the story and returns a
 * per-requirement PASS/FAIL verdict. `checkCorrectness` is injected — a
 * deterministic stub in tests, `createLlmCorrectnessChecker` in production.
 */
export async function scoreUserStory(
  story: UserStory,
  state: ProducedState,
  checkCorrectness: CorrectnessChecker,
): Promise<UserStoryVerdict> {
  const verdict = await verifyCompletion(
    { taskId: story.id, requirements: story.requirements },
    state,
    checkCorrectness,
  )
  return { ...verdict, title: story.title }
}

/** One row of the launch scoreboard — story × requirement → PASS/FAIL. */
export interface ScoreboardRow {
  storyId: string
  storyTitle: string
  reqId: string
  reqTitle: string
  status: 'PASS' | 'FAIL'
  evidence: string[]
}

/**
 * Flatten story verdicts into the per-requirement scoreboard — the literal
 * Jira tick-off: one row per (story, requirement) with PASS/FAIL and the
 * evidence behind the verdict.
 */
export function userStoryScoreboard(verdicts: readonly UserStoryVerdict[]): ScoreboardRow[] {
  const rows: ScoreboardRow[] = []
  for (const v of verdicts) {
    for (const r of v.requirements) {
      rows.push({
        storyId: v.taskId,
        storyTitle: v.title,
        reqId: r.reqId,
        reqTitle: r.title,
        status: r.satisfied ? 'PASS' : 'FAIL',
        evidence: r.evidence,
      })
    }
  }
  return rows
}
