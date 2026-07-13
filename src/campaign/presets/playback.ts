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

import type { AgentProfile } from '@tangle-network/agent-interface'
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
 * usage through `ctx.cost.runPaidCall` so the backend-integrity check sees real
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

/** Launch-readiness headline counts rolled up from the per-requirement rows. */
export interface ScoreboardSummary {
  /** Distinct user stories on the board. */
  stories: number
  /** Stories whose every requirement passed. */
  storiesFullyComplete: number
  /** Total (story, requirement) rows. */
  requirements: number
  /** Rows with status PASS. */
  passed: number
  /** Rows with status FAIL. */
  failed: number
  /** passed / requirements; 0 when there are no rows. */
  passRate: number
}

/** Roll the per-requirement rows up into the launch headline counts. */
export function scoreboardSummary(rows: readonly ScoreboardRow[]): ScoreboardSummary {
  const byStory = new Map<string, { total: number; passed: number }>()
  let passed = 0
  for (const r of rows) {
    const s = byStory.get(r.storyId) ?? { total: 0, passed: 0 }
    s.total++
    if (r.status === 'PASS') {
      s.passed++
      passed++
    }
    byStory.set(r.storyId, s)
  }
  let storiesFullyComplete = 0
  for (const s of byStory.values()) if (s.total > 0 && s.passed === s.total) storiesFullyComplete++
  return {
    stories: byStory.size,
    storiesFullyComplete,
    requirements: rows.length,
    passed,
    failed: rows.length - passed,
    passRate: rows.length === 0 ? 0 : passed / rows.length,
  }
}

export interface ScoreboardRenderOptions {
  /** Document H1. Defaults to a generic playback title. */
  title?: string
  /** Key/value run metadata rendered under the headline (runId, backend, model, date). */
  meta?: Record<string, string>
  /** Max chars of joined evidence shown per row. Default 160. */
  maxEvidenceChars?: number
}

function escapeCell(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1))}…`
}

/**
 * Render the scoreboard as a launch-readiness Markdown document — the literal
 * "tick off every user story" artifact: a headline roll-up, the open tickets
 * (FAIL rows) up top as the launch blockers, then a per-story table of
 * requirement → PASS/FAIL with the evidence behind each verdict. Pure: same
 * rows in, same bytes out (no clock/random), so it is safe to snapshot.
 */
export function renderScoreboardMarkdown(
  rows: readonly ScoreboardRow[],
  opts: ScoreboardRenderOptions = {},
): string {
  const maxEv = opts.maxEvidenceChars ?? 160
  const sum = scoreboardSummary(rows)
  const pct = (n: number) => `${Math.round(n * 100)}%`
  const ev = (e: string[]) => escapeCell(truncate(e.join('; '), maxEv)) || '—'
  const out: string[] = [`# ${opts.title ?? 'Product-flow playback scoreboard'}`, '']
  if (opts.meta) {
    for (const [k, v] of Object.entries(opts.meta)) out.push(`- **${k}:** ${v}`)
    out.push('')
  }
  out.push(
    `**${sum.storiesFullyComplete}/${sum.stories}** user stories fully shipped · ` +
      `**${sum.passed}/${sum.requirements}** requirements passing (${pct(sum.passRate)}) · ` +
      `**${sum.failed}** open`,
    '',
  )
  const fails = rows.filter((r) => r.status === 'FAIL')
  if (fails.length > 0) {
    out.push('## Open tickets', '', '| Story | Requirement | Evidence |', '| --- | --- | --- |')
    for (const r of fails) {
      out.push(`| ${escapeCell(r.storyTitle)} | ${escapeCell(r.reqTitle)} | ${ev(r.evidence)} |`)
    }
    out.push('')
  } else {
    out.push('_All requirements passing — no open tickets._', '')
  }
  out.push('## Per-story tick-off', '')
  for (const storyId of [...new Set(rows.map((r) => r.storyId))]) {
    const storyRows = rows.filter((r) => r.storyId === storyId)
    const passed = storyRows.filter((r) => r.status === 'PASS').length
    const mark = passed === storyRows.length ? '✅' : '⚠️'
    out.push(
      `### ${escapeCell(storyRows[0]!.storyTitle)} — ${passed}/${storyRows.length} ${mark}`,
      '',
      '| Requirement | Status | Evidence |',
      '| --- | --- | --- |',
    )
    for (const r of storyRows) {
      out.push(
        `| ${escapeCell(r.reqTitle)} | ${r.status === 'PASS' ? '✅ PASS' : '❌ FAIL'} | ${ev(r.evidence)} |`,
      )
    }
    out.push('')
  }
  return out.join('\n')
}
