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
 *
 * And `ZERO_AND_FLAG` means the whole outcome, not the scalar. A gated row that
 * ships `reward: 0` beside the per-layer verifier scores the reward was
 * computed from has not been zeroed in any sense a trainer respects; the
 * accounting therefore measures every reward-derived number each format writes,
 * not just the one field.
 */

import type { RftItem, SftRow, VerifiersRolloutOutput } from '../exporters'
import {
  GATE_CHECK_IDS,
  GATE_POLICIES,
  type GateCheckId,
  undeclaredStepPayload,
} from '../gate-checks'
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

/** What the gate accounting reads off an emitted row, per format. */
export interface ReleaseRowRef {
  rollout_id: string
  reward: number | null
  /**
   * The rest of the row that was DERIVED from the reward — the per-layer score
   * dict, the judge verdict record, whatever this format ships beside the
   * scalar. Walked for positive numbers, so the certification is about the
   * whole outcome rather than one field.
   *
   * Absent when the format's row carries nothing but the scalar. NOT the whole
   * row: `cost.tokens_in`, `wall_s` and `total_steps` are positive numbers that
   * have nothing to do with the reward, and a certification that flags them is
   * a certification nobody can act on.
   */
  evidence?: unknown
  /**
   * The screen claim AS EMITTED — read off the row, not off the line it came
   * from, because what ships is what matters. Required, not optional: an
   * optional field is how a format quietly opts out of the check that reads it,
   * and every emitted row shape carries `RealnessLabels` precisely so no adapter
   * has to.
   */
  realness_screened: boolean | null
  /**
   * The part of an emitted `steps[]` the wire format does not declare.
   *
   * Separate from `evidence` because the declared step fields are FULL of
   * legitimate positive numbers — `durationMs`, `llm_call_count`,
   * `prompt_token_ids` — and a certification that flags those is one nobody can
   * act on. Only the undeclared remainder is unclassified reward-bearing
   * payload, which is the same partition the check applies.
   *
   * Set only by formats whose row carries steps: today `raw` alone.
   */
  stepEvidence?: unknown
}

/** A positive number found inside an emitted gated row, with where it was. */
export interface EmittedEvidence {
  /** JSON-ish path from the row's evidence root, e.g. `metrics['layer.tests']`. */
  path: string
  value: number
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
  /**
   * The largest positive number found in the reward-DERIVED payload of an
   * emitted gated row, and its path; `null` when there is none.
   *
   * This column exists because the release once certified CLEAN while leaking.
   * `assertGateReport` inspected `outcome.reward` alone, so a gated row shipping
   * `reward: 0` next to `metrics['layer.tests']: 1` — the deterministic verifier
   * score the reward was computed from, and the per-rubric score dict of the
   * Prime Intellect verifiers format — passed, and the card rendered "max reward
   * | 0" over a file that carried the gamed signal at full value. A wrong
   * certification is worse than the leak: it is the leak plus a document saying
   * there isn't one.
   */
  maxEmittedEvidence: EmittedEvidence | null
  /**
   * Rows this format wrote carrying a positive reward whose producer DECLARED
   * that no authenticity screen ever ran on it (`realness_screened: false`).
   *
   * Measured over EVERY emitted row, not just the gated ones: an unscreened
   * reward is by definition one the gate never had a verdict on, so it is not in
   * the gated set and a measurement scoped to that set would report 0 forever.
   * `assertMinted` already refuses these, which is exactly why the release still
   * measures them — the last door before a public dataset does not get to assume
   * the earlier doors held.
   */
  unscreenedPositiveRows: number
  /** Highest reward on such a row; `null` when there is none. */
  maxUnscreenedReward: number | null
  /**
   * The largest positive number found in an emitted gated row's UNDECLARED
   * per-step payload, and its path; `null` when there is none.
   *
   * The column exists because the gate read `outcome` and nothing else for
   * three rounds, so a gated line shipping `steps: [{kind, name, reward: 0.86}]`
   * certified clean — the release accounting agreed with the exporter that a
   * per-step reward was not a reward.
   */
  maxEmittedStepEvidence: EmittedEvidence | null
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
  // An SFT row is `{messages, metadata}` and `metadata` holds ids plus the
  // scalar — no reward-derived payload beyond `reward` itself, and the gated
  // disposition is EXCLUDE anyway.
  sft: (rows: readonly SftRow[]): ReleaseRowRef[] =>
    rows.map((row) => ({
      rollout_id: row.metadata.rollout_id,
      reward: row.metadata.reward,
      realness_screened: row.metadata.realness_screened,
    })),
  // `metrics` IS the per-rubric score dict in the Prime Intellect verifiers
  // format — the same numbers the reward was computed from. This is the leak
  // that shipped.
  verifiers: (rows: readonly VerifiersRolloutOutput[]): ReleaseRowRef[] =>
    rows.map((row) => ({
      rollout_id: row.info.rollout_id,
      reward: row.reward,
      evidence: row.metrics,
      realness_screened: row.info.realness_screened,
    })),
  // RFT re-samples the completion, but the grader reads `item.reference.*`, so
  // the verbatim judge verdict is a reward-bearing field on the row.
  rft: (rows: readonly RftItem[]): ReleaseRowRef[] =>
    rows.map((row) => ({
      rollout_id: row.reference.rollout_id,
      reward: row.reference.reward,
      evidence: row.reference.verdict,
      realness_screened: row.reference.realness_screened,
    })),
  raw: (lines: readonly MintedRolloutLine[]): ReleaseRowRef[] =>
    lines.map((line) => ({
      rollout_id: line.rollout_id,
      reward: line.outcome.reward,
      // `provenance.gated_evidence` is deliberately NOT walked: relocating the
      // diagnostics there is what the gate DOES, and the raw config is the
      // audit dump those diagnostics exist for.
      evidence: { metrics: line.outcome.metrics, verdict: line.outcome.verdict },
      // `raw` is the only config that writes the whole line, so it is the only
      // one whose rows can carry a per-step reward.
      stepEvidence: undeclaredStepPayload(line.steps),
      realness_screened: line.outcome.realness_screened ?? null,
    })),
}

/** Every positive finite number inside a row's reward-derived payload, with its path. */
function positiveNumbersIn(value: unknown, path: string): EmittedEvidence[] {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 ? [{ path, value }] : []
  }
  if (Array.isArray(value)) {
    return value.flatMap((item, i) => positiveNumbersIn(item, `${path}[${i}]`))
  }
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).flatMap(([key, child]) =>
      positiveNumbersIn(child, path === '' ? key : `${path}.${key}`),
    )
  }
  return []
}

/** Measure one format's gated rows from the refs of the rows about to be written. */
export function measureFormatGate(
  gated: ReadonlySet<string>,
  refs: readonly ReleaseRowRef[],
): FormatGateCounts {
  const emitted = refs.filter((ref) => gated.has(ref.rollout_id))
  const rewards = emitted.map((ref) => ref.reward).filter((r): r is number => r !== null)
  const evidence = emitted.flatMap((ref) => positiveNumbersIn(ref.evidence, ''))
  const stepEvidence = emitted.flatMap((ref) => positiveNumbersIn(ref.stepEvidence, 'steps'))
  const unscreened = refs
    .filter((ref) => ref.realness_screened === false)
    .map((ref) => ref.reward)
    .filter((r): r is number => r !== null && r > 0)
  return {
    input: gated.size,
    emitted: emitted.length,
    excluded: gated.size - emitted.length,
    maxEmittedReward: rewards.length === 0 ? null : Math.max(...rewards),
    maxEmittedEvidence: evidence.reduce<EmittedEvidence | null>(
      (best, found) => (best === null || found.value > best.value ? found : best),
      null,
    ),
    unscreenedPositiveRows: unscreened.length,
    maxUnscreenedReward: unscreened.length === 0 ? null : Math.max(...unscreened),
    maxEmittedStepEvidence: stepEvidence.reduce<EmittedEvidence | null>(
      (best, found) => (best === null || found.value > best.value ? found : best),
      null,
    ),
  }
}

/**
 * The measured form of each canonical gate check, over the rows a release is
 * ABOUT TO WRITE. Returns the failure message, or `null` when the format is
 * clean on that check.
 *
 * TOTAL over `GateCheckId` — this map and `GATE_POLICIES.assertGateReport` are
 * the two things a new check breaks here, so the release certifier cannot be
 * left behind by a check added anywhere else in the package. That is the whole
 * point: for four rounds each guard composed its own subset by hand, and a
 * release certifying CLEAN while leaking is the most expensive version of that
 * mistake, because it is the leak plus a document saying there isn't one.
 */
const REPORT_MEASURES: {
  readonly [K in GateCheckId]: (format: ReleaseFormat, counts: FormatGateCounts) => string | null
} = {
  'reward-relationship': (format, counts) =>
    counts.maxEmittedReward === null || counts.maxEmittedReward <= 0
      ? null
      : `release format "${format}": ${counts.emitted} realness-gated row(s) carry a positive ` +
        `reward (max ${counts.maxEmittedReward}). A run flagged as gamed may not ship a ` +
        'positive reward in any config.',
  'gated-evidence': (format, counts) => {
    if (counts.maxEmittedEvidence === null) return null
    const { path, value } = counts.maxEmittedEvidence
    return (
      `release format "${format}": ${counts.emitted} realness-gated row(s) carry a positive ` +
      `reward-derived number (${path} = ${value}). Zeroing the scalar is not enough — the ` +
      'per-layer scores and judge verdict a fabricated reward was computed FROM are the ' +
      'same signal in component form, and in this format they are read as training input. ' +
      'They belong in `provenance.gated_evidence` (see `gateGamedOutcome`), not on the row.'
    )
  },
  'undeclared-step-payload': (format, counts) => {
    if (counts.maxEmittedStepEvidence === null) return null
    const { path, value } = counts.maxEmittedStepEvidence
    return (
      `release format "${format}": ${counts.emitted} realness-gated row(s) carry a positive ` +
      `per-step number under a field \`tangle.rollout.v1\` does not declare (${path} = ${value}). ` +
      'A per-step reward is the same training signal as the scalar, in credit-assignment form, ' +
      'and the exporters copy `steps` through verbatim — so the row ships it beside a `reward` ' +
      'of 0. It belongs in `provenance.gated_evidence.steps` (see `gateGamedOutcome`).'
    )
  },
  'unscreened-reward': (format, counts) =>
    counts.maxUnscreenedReward === null
      ? null
      : `release format "${format}": ${counts.unscreenedPositiveRows} row(s) carry a positive ` +
        `reward (max ${counts.maxUnscreenedReward}) whose producer declares that NO authenticity ` +
        'screen ran on it (`realness_screened: false`). Nothing has established those successes ' +
        'are real, and a published dataset may not present an unqualified verdict as a measured ' +
        'one. Screen the runs, or publish them at `reward: null`.',
}

/**
 * Fail the build when the measurement disagrees with the declared policy.
 *
 * Throws, never filters: an emitted positive reward on a gated row means an
 * exporter upstream stopped applying the gate, and silently dropping the row
 * would hide the producer that made it — the producer is the actual defect.
 *
 * Certifies the whole emitted outcome, not `reward` alone. The earlier version
 * checked one field and therefore certified a release CLEAN while its
 * `verifiers/train.jsonl` shipped the gamed run's per-layer scores at 1.0 in
 * the top-level `metrics` dict — the card then rendered "max reward | 0" over
 * exactly that file. A certification that is wrong is worse than an
 * uncertified leak, so the checks it runs are no longer written down here at
 * all: it iterates `GATE_CHECK_IDS` under its own declared policy.
 */
export function assertGateReport(report: GateReport): void {
  for (const [format, counts] of Object.entries(report.byFormat) as Array<
    [ReleaseFormat, FormatGateCounts]
  >) {
    for (const id of GATE_CHECK_IDS) {
      if (GATE_POLICIES.assertGateReport[id].kind !== 'enforce') continue
      const failure = REPORT_MEASURES[id](format, counts)
      if (failure !== null) throw new Error(failure)
    }
    // Not a gate check: this one is the RELEASE POLICY (`FORMAT_GATE_DISPOSITION`)
    // rather than the anti-Goodhart invariant — it asks whether the format did
    // what it said it would with gated rows, not whether a row is poisoned.
    if (FORMAT_GATE_DISPOSITION[format] === 'exclude' && counts.emitted > 0) {
      throw new Error(
        `release format "${format}" declares gated lines EXCLUDED but wrote ${counts.emitted} ` +
          'of them.',
      )
    }
  }
}
