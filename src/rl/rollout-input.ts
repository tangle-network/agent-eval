/**
 * The `RunRecord[]` → `MintedRolloutLine[]` adapter that keeps the deprecated
 * training-data entry points alive.
 *
 * The structural guarantee, stated precisely — an earlier version of this
 * comment claimed "an exporter whose only possible input is a minted line
 * cannot be handed an ungated reward", which was FALSE while `RolloutLine` was
 * a plain structural interface: any object literal of the right shape was one,
 * so `{reward: 0.95, realness_gated: true}` type-checked as a valid input and
 * every exporter copied it out verbatim. Two mechanisms now hold it up
 * together, and neither is sufficient alone:
 *
 *   - COMPILE time — exporters take `MintedRolloutLine`, a nominally branded
 *     type no object literal can satisfy. It is produced by `mintRolloutRows`
 *     (which applies the gate via `trainingReward`), by `readRolloutLedger`,
 *     or by an explicit `assertMinted`.
 *   - RUN time — `validateRolloutLine` rejects `reward > 0` together with
 *     `realness_gated: true`, so a line that arrives as data (a ledger file, a
 *     foreign import, JSON from another process) is refused where the type
 *     system was never present to help.
 *
 * The published `RunRecord[]` signatures survive as deprecated overloads that
 * mint HERE and delegate to the same implementation, so consumers keep
 * compiling and silently gain the gate.
 *
 * Minting for a legacy call uses an EMPTY trace store deliberately. These
 * exporters resolve prompt/completion text through caller lookups (a RunRecord
 * carries only hashes), so the trace-derived half of a line — inline messages
 * and span projections — is not what they read. The consequence is that every
 * legacy-minted line is a labeled GAP line (`messages: []`, `provenance.gap`),
 * which is the truth: no trajectory was supplied with the records. Exporters
 * that genuinely need step structure (PRM) must therefore REJECT such a line
 * rather than train on an empty trajectory.
 */

import { mintRolloutRows } from '../rollout/mint'
import { assertRewardGate, type MintedRolloutLine, ROLLOUT_SCHEMA } from '../rollout/schema'
import type { RunRecord } from '../run-record'
import { InMemoryTraceStore } from '../trace/store'

/** A minted line paired with the record it came from. */
export interface MintedFromRecord {
  record: RunRecord
  line: MintedRolloutLine
}

/**
 * Mint one gate-carrying line per record, preserving input order so callers can
 * keep the record beside its line (the deprecated overloads need the record to
 * invoke `RunRecord`-typed callbacks the published API still accepts).
 */
export async function mintLinesFromRecords(records: RunRecord[]): Promise<MintedFromRecord[]> {
  const { rows } = await mintRolloutRows(records, new InMemoryTraceStore())
  if (rows.length !== records.length) {
    // mintRolloutRows emits exactly one row per record (gap lines included).
    // If that ever stops holding, pairing by index silently mislabels rewards.
    throw new Error(
      `rollout mint returned ${rows.length} lines for ${records.length} records — cannot pair`,
    )
  }
  return rows.map((line, i) => ({ line, record: records[i]! }))
}

/**
 * Discriminate the two accepted inputs at runtime. An empty array is reported
 * as lines: both paths return no rows, so the choice cannot change an outcome.
 */
export function isRolloutLineInput(
  input: MintedRolloutLine[] | RunRecord[],
): input is MintedRolloutLine[] {
  const first = input[0]
  if (first === undefined) return true
  return (first as { schema?: unknown }).schema === ROLLOUT_SCHEMA
}

/** `reward_source` mint writes when a record carried neither split score. */
const UNSCORED_REWARD_SOURCE = 'run-record/unscored'

/**
 * The line's reward, with `null` meaning "no verdict exists" and never "scored
 * zero".
 *
 * Mint now writes `reward: null` for an unscored record, so the primary check
 * is the reward itself. The `reward_source` marker stays as a second condition
 * for lines written by an older mint, which collapsed an unscored record to 0
 * while still labelling the source `run-record/unscored`; reading those as a
 * measured zero would train on a grade nobody ever gave.
 */
export function trainableLineReward(line: MintedRolloutLine): number | null {
  // The single reward reader on the `rl/` side, so the runtime invariant check
  // sits here and covers GRPO rows, SFT row metadata, preference ordering, and
  // the published datasheet's reward distribution in one place.
  assertRewardGate(line, 'trainable reward')
  const { reward, reward_source } = line.outcome
  if (reward === null || !Number.isFinite(reward)) return null
  if (reward_source === UNSCORED_REWARD_SOURCE) return null
  return reward
}

/** The anti-Goodhart flag as it travels on the line. */
export function isLineRealnessGated(line: MintedRolloutLine): boolean {
  return line.outcome.realness_gated === true
}
