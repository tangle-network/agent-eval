/**
 * ModelSeats — the program's model seating chart.
 *
 * One object names which model fills each role in an eval program: the worker
 * under evaluation, the judge panel, the analyst, the reflection/driver model,
 * and the verifier. Re-tiering an entire program (economy ↔ frontier) is one
 * swapped object instead of a hunt through call sites.
 *
 * Wiring points — consumers thread seats; this module implements none of them
 * (those files belong to other surfaces):
 *  - `judges`     → `ensembleJudge({ models: seats.judges, … })` (src/judge-panel.ts)
 *                   and the `JudgeConfig`s handed to `makeEvalTools({ judges })`
 *                   (src/eval-tools.ts).
 *  - `reflection` → `selfImprove({ llm: { model: seats.reflection } })` — the
 *                   `gepaProposer` reflection model (src/contract/self-improve.ts);
 *                   same seat for any custom `SurfaceProposer`'s LLM.
 *  - `worker`     → the dispatch model the agent itself calls — the model an
 *                   `AgentProfile` declares.
 *  - `analyst`    → the LLM behind `analyzeRuns` / analyst-registry kinds.
 *  - `verifier`   → completion-verifier / objective-checker model.
 *  - campaign cells thread `judges` + driver models the same way; that wiring
 *    lands with the campaign surface, not here.
 *
 * `resolveSeat` is the only read path: an unset seat with no explicit fallback
 * throws — a model id is a budget decision, never a silent default.
 */

import { ConfigError, ValidationError } from './errors'

export interface ModelSeats {
  /** The model under evaluation — what the agent itself dispatches with. */
  worker?: string
  /** Judge-panel model ids — thread into `ensembleJudge({ models })`. */
  judges?: string[]
  /** Analyst model — `analyzeRuns` / analyst-registry LLM calls. */
  analyst?: string
  /** Reflection/proposer model — `gepaProposer` mutation proposals. */
  reflection?: string
  /** Verifier model — completion/objective checking. */
  verifier?: string
}

export type SeatName = keyof ModelSeats

export type SeatPresetName = keyof typeof seatPresets

/**
 * Tier presets — plain data, swap or spread freely.
 *
 * `economy` uses the fleet-policy ids: every id resolves through the
 * substrate's family pricing (no costUnknown axis) and the judge trio spans
 * three provider families (moonshot / deepseek / openai), so it passes
 * `assertCrossFamily` as-is.
 *
 * `frontier` is deliberately EMPTY: entitled frontier ids vary per router
 * account, and a hardcoded claude/gpt-5 id 401s on keys that lack it. Supply
 * your own: `{ ...seatPresets.frontier, worker: '<your-frontier-id>', … }` —
 * `resolveSeat` throws on every seat you haven't filled.
 */
export const seatPresets: Record<'economy' | 'frontier', ModelSeats> = {
  economy: {
    worker: 'kimi-k2.6',
    judges: ['kimi-k2.6', 'deepseek-v4-pro', 'gpt-4.1-mini'],
    analyst: 'gpt-4.1-mini',
    reflection: 'gpt-4.1-mini',
    verifier: 'deepseek-v4-pro',
  },
  frontier: {},
}

/** Thrown by `resolveSeat` when a seat is unset and no fallback was given. */
export class SeatUnsetError extends ConfigError {
  constructor(public readonly seat: SeatName) {
    super(
      `ModelSeats: seat '${seat}' is unset and no fallback was given — ` +
        'name a model explicitly (a model id is a budget decision, never a silent default)',
    )
  }
}

/**
 * Read one seat. Blank strings and empty arrays count as unset (env-var
 * plumbing produces them); malformed values (non-string seat, non-array or
 * blank-entry `judges`) throw `ValidationError`. When the seat is unset, an
 * explicit `fallback` is returned (`[fallback]` for `judges` — a one-model
 * panel); without one, `SeatUnsetError`.
 */
export function resolveSeat(seats: ModelSeats, seat: 'judges', fallback?: string): string[]
export function resolveSeat(
  seats: ModelSeats,
  seat: Exclude<SeatName, 'judges'>,
  fallback?: string,
): string
export function resolveSeat(seats: ModelSeats, seat: SeatName, fallback?: string): string | string[]
export function resolveSeat(
  seats: ModelSeats,
  seat: SeatName,
  fallback?: string,
): string | string[] {
  const value = seats[seat]
  if (seat === 'judges') {
    if (value !== undefined && !Array.isArray(value)) {
      throw new ValidationError(`ModelSeats: seat 'judges' must be a string[], got ${typeof value}`)
    }
    const models = Array.isArray(value) ? value : []
    if (models.length > 0) {
      const blank = models.findIndex((m) => typeof m !== 'string' || m.trim() === '')
      if (blank >= 0) {
        throw new ValidationError(
          `ModelSeats: judges[${blank}] is blank — every panel model must be a non-empty id`,
        )
      }
      return [...models]
    }
  } else {
    if (value !== undefined && typeof value !== 'string') {
      throw new ValidationError(`ModelSeats: seat '${seat}' must be a string, got ${typeof value}`)
    }
    if (typeof value === 'string' && value.trim() !== '') return value
  }
  if (fallback !== undefined) {
    if (fallback.trim() === '') {
      throw new ValidationError(`ModelSeats: fallback for seat '${seat}' is blank`)
    }
    return seat === 'judges' ? [fallback] : fallback
  }
  throw new SeatUnsetError(seat)
}
