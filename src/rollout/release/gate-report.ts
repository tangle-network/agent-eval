/**
 * Per-format accounting of the anti-Goodhart gate for one dataset release.
 *
 * The defect this exists to make impossible: a dataset card that STATES what
 * the gate does while the build does something else. A sentence in a README is
 * a claim about bytes it never reads, so it drifts the moment an exporter
 * changes — and the drift ships to whoever downloads the dataset.
 *
 * So the card is not allowed to assert anything about the gate. The build
 * measures the rows it is ABOUT TO WRITE (`measureFormatGate`), the measurement
 * is checked against the declared per-format disposition (`assertGateReport`,
 * which throws rather than warns), and the card renders only numbers handed to
 * it. A card that disagrees with its own data files cannot be produced without
 * failing the build first.
 *
 * The dispositions themselves are the release policy, stated once as data:
 *
 *   sft       EXCLUDE       — an SFT row is an imitation target. A gamed
 *                             trajectory must never be imitated, at any weight.
 *   verifiers ZERO_AND_FLAG — reward is a signed learning signal here, so a
 *                             gamed trajectory at reward 0 is a correct
 *                             negative. Dropping it would bias the negative
 *                             population toward honest failures and leave a
 *                             trainer no example of what gaming looks like
 *                             when it is penalized.
 *   rft       ZERO_AND_FLAG — RFT re-samples the completion; only the prompt
 *                             and the grader's `reference.*` verdict ship, so
 *                             nothing gamed is imitated. The flag is what lets
 *                             a grader author skip the instance.
 *   raw       ZERO_AND_FLAG — a faithful audit dump. Removing rows from it
 *                             would defeat its only purpose, and the gated
 *                             row is the one an auditor most wants.
 *
 * `ZERO_AND_FLAG` is never `reward: 0` alone. Zeroing without the label makes a
 * faked success indistinguishable from an honest failure — it hides the gamed
 * population from the buyer instead of disclosing it. Every included format
 * carries `realness_gated` on the row itself.
 */

import type { RftItem, SftRow, VerifiersRolloutOutput } from '../exporters'
import type { MintedRolloutLine } from '../schema'
import type { ReleaseFormat } from './card'

/** What a format does with a line the realness gate flagged. */
export type GateDisposition = 'exclude' | 'zero-and-flag'

export const FORMAT_GATE_DISPOSITION: Record<ReleaseFormat, GateDisposition> = {
  sft: 'exclude',
  verifiers: 'zero-and-flag',
  rft: 'zero-and-flag',
  raw: 'zero-and-flag',
}

/** The two fields the gate accounting reads off an emitted row, per format. */
export interface ReleaseRowRef {
  rollout_id: string
  reward: number | null
}

export interface FormatGateCounts {
  /** Gated lines that reached this format's exporter. */
  input: number
  /** Gated rows the format actually wrote. */
  emitted: number
  /**
   * Gated lines this format did not write. Not all of these are the gate:
   * `verifiers` also drops gap lines (empty transcript) and `rft` drops lines
   * with no prompt turn, so an excluded count can mix both causes.
   */
  excluded: number
  /** Highest reward on an emitted gated row; `null` when none was emitted. */
  maxEmittedReward: number | null
}

export interface GateReport {
  /** Gated lines in the release input, after the split/proposer filters. */
  gatedLines: number
  byFormat: Partial<Record<ReleaseFormat, FormatGateCounts>>
}

/** Rollout ids of every gated line, the key the emitted rows are matched on. */
export function gatedRolloutIds(lines: readonly MintedRolloutLine[]): Set<string> {
  return new Set(lines.filter((line) => line.outcome.realness_gated).map((line) => line.rollout_id))
}

/**
 * Row refs per format. Written as one adapter per format so that the knowledge
 * of WHERE the id and reward live in each published shape sits next to the
 * assertion that uses it — an exporter that moves either field breaks here
 * rather than silently reporting zero gated rows.
 */
export const releaseRowRefs = {
  sft: (rows: readonly SftRow[]): ReleaseRowRef[] =>
    rows.map((row) => ({ rollout_id: row.metadata.rollout_id, reward: row.metadata.reward })),
  verifiers: (rows: readonly VerifiersRolloutOutput[]): ReleaseRowRef[] =>
    rows.map((row) => ({ rollout_id: row.info.rollout_id, reward: row.reward })),
  rft: (rows: readonly RftItem[]): ReleaseRowRef[] =>
    rows.map((row) => ({ rollout_id: row.reference.rollout_id, reward: row.reference.reward })),
  raw: (lines: readonly MintedRolloutLine[]): ReleaseRowRef[] =>
    lines.map((line) => ({ rollout_id: line.rollout_id, reward: line.outcome.reward })),
}

/** Measure one format's gated rows from the refs of the rows about to be written. */
export function measureFormatGate(
  gated: ReadonlySet<string>,
  refs: readonly ReleaseRowRef[],
): FormatGateCounts {
  const emitted = refs.filter((ref) => gated.has(ref.rollout_id))
  const rewards = emitted.map((ref) => ref.reward).filter((r): r is number => r !== null)
  return {
    input: gated.size,
    emitted: emitted.length,
    excluded: gated.size - emitted.length,
    maxEmittedReward: rewards.length === 0 ? null : Math.max(...rewards),
  }
}

/**
 * Fail the build when the measurement disagrees with the declared policy.
 *
 * Throws, never filters: an emitted positive reward on a gated row means an
 * exporter upstream stopped applying the gate, and silently dropping the row
 * would hide the producer that made it — the producer is the actual defect.
 */
export function assertGateReport(report: GateReport): void {
  for (const [format, counts] of Object.entries(report.byFormat) as Array<
    [ReleaseFormat, FormatGateCounts]
  >) {
    if (counts.maxEmittedReward !== null && counts.maxEmittedReward > 0) {
      throw new Error(
        `release format "${format}": ${counts.emitted} realness-gated row(s) carry a positive ` +
          `reward (max ${counts.maxEmittedReward}). A run flagged as gamed may not ship a ` +
          'positive reward in any config.',
      )
    }
    if (FORMAT_GATE_DISPOSITION[format] === 'exclude' && counts.emitted > 0) {
      throw new Error(
        `release format "${format}" declares gated lines EXCLUDED but wrote ${counts.emitted} ` +
          'of them.',
      )
    }
  }
}
