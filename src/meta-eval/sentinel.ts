/**
 * Judge sentinel — eval trustworthiness as a continuously measured,
 * alarmed trend.
 *
 * Judges are models; models change underneath us; calibration decays.
 * This module composes three existing instruments into one loop:
 *
 *   snapshot — adapters turn real instrument outputs (`calibrateJudge` /
 *              `calibrateJudgeContinuous`, `corpusInterRaterAgreement` /
 *              `continuousAgreement`, a rerun sentinel golden set) into
 *              `SentinelSnapshot`s
 *   series   — `analyzeSeries` (src/series-convergence) classifies each
 *              judge×metric history as stabilized / drifting / noisy
 *   alarm    — `judgeSentinelReport` turns trends + thresholds into named
 *              alarms; `evalHealthStamp` is the tiny object a campaign
 *              attaches to its verdicts
 *
 * Alarm conditions:
 *   - convergence state `drifting-down` on any tracked metric
 *   - irr below `minIrr`
 *   - calibrationKappa / sentinelPassRate dropped vs the series baseline
 *     beyond `maxKappaDrop` / `maxSentinelDrop`
 *   - judge model changed with no post-change golden-grounded snapshot
 *     (the silent-upgrade trap: judges agreeing with each other after a
 *     model swap proves nothing — only re-measuring against gold does)
 *   - newest snapshot older than `staleAfterDays` relative to `asOf`
 *
 * Wire-in: run the snapshot adapters from a post-campaign hook or a
 * nightly job, append to a `SentinelStore`, then compute
 * `judgeSentinelReport(await store.history(), { asOf })` with `asOf` =
 * the campaign timestamp. Attach `evalHealthStamp(report)` to campaign
 * verdicts: an alarmed sentinel means every downstream verdict carries
 * an integrity warning until the judge is recalibrated.
 *
 * The module is clock-free — every timestamp (`at`, `asOf`) is
 * caller-supplied ISO-8601, so reports are reproducible.
 */

import { ValidationError } from '../errors'
import type {
  CalibrationResult,
  CandidateScore,
  ContinuousAgreement,
  ContinuousCalibrationResult,
  GoldenItem,
} from '../judge-calibration'
import {
  analyzeSeries,
  type SeriesConvergenceOptions,
  type SeriesConvergenceResult,
} from '../series-convergence'
import type { CorpusAgreementReport } from '../statistics'

export const SENTINEL_METRIC_NAMES = ['irr', 'calibrationKappa', 'sentinelPassRate'] as const

export type SentinelMetricName = (typeof SENTINEL_METRIC_NAMES)[number]

export interface SentinelMetrics {
  /** Inter-rater reliability — ICC(2,1) from agreement instruments. */
  irr?: number
  /** Weighted κ vs the human golden set (`calibrateJudge*`). */
  calibrationKappa?: number
  /** Fraction of a fixed sentinel golden set the judge still scores within tolerance. */
  sentinelPassRate?: number
}

export interface SentinelSnapshot {
  /** Caller-supplied ISO-8601 timestamp — the module never reads a clock. */
  at: string
  judgeId: string
  /** Exact model identity behind the judge (pin the full version string). */
  judgeModel: string
  /**
   * Metrics measured at `at`. May be empty: an empty-metrics snapshot is a
   * model-change marker — it records the new `judgeModel` immediately and
   * the silent-upgrade alarm stays raised until a golden-grounded snapshot
   * (calibrationKappa or sentinelPassRate) follows.
   */
  metrics: SentinelMetrics
}

/** Identity + timestamp the caller supplies alongside an instrument output. */
export interface SnapshotMeta {
  at: string
  judgeId: string
  judgeModel: string
}

function parseIso(value: string, label: string): number {
  const ms = typeof value === 'string' ? Date.parse(value) : NaN
  if (!Number.isFinite(ms)) {
    throw new ValidationError(
      `judge-sentinel: ${label} is not a parseable ISO timestamp: ${JSON.stringify(value)}`,
    )
  }
  return ms
}

/** Shape guard for snapshots crossing a boundary (store append, JSONL load, report input). */
export function validateSentinelSnapshot(snapshot: SentinelSnapshot, source = 'snapshot'): void {
  parseIso(snapshot.at, `${source}.at`)
  if (typeof snapshot.judgeId !== 'string' || snapshot.judgeId.length === 0) {
    throw new ValidationError(`judge-sentinel: ${source}.judgeId must be a non-empty string`)
  }
  if (typeof snapshot.judgeModel !== 'string' || snapshot.judgeModel.length === 0) {
    throw new ValidationError(`judge-sentinel: ${source}.judgeModel must be a non-empty string`)
  }
  if (snapshot.metrics === null || typeof snapshot.metrics !== 'object') {
    throw new ValidationError(`judge-sentinel: ${source}.metrics must be an object (may be empty)`)
  }
  for (const [key, value] of Object.entries(snapshot.metrics)) {
    if (!(SENTINEL_METRIC_NAMES as readonly string[]).includes(key)) {
      // A typo'd key would silently never trend — reject instead.
      throw new ValidationError(
        `judge-sentinel: ${source}.metrics carries unknown key "${key}" — known: ${SENTINEL_METRIC_NAMES.join(', ')}`,
      )
    }
    if (value !== undefined && !Number.isFinite(value)) {
      throw new ValidationError(
        `judge-sentinel: ${source}.metrics.${key} is not a finite number: ${String(value)}`,
      )
    }
  }
}

// ── Snapshot adapters — real instrument output → SentinelSnapshot ───

/**
 * From `calibrateJudge` / `calibrateJudgeContinuous` output. Prefers the
 * un-rounded continuous κ_w when the report carries one (integer κ
 * discards information for [0,1] judges).
 */
export function snapshotFromCalibration(
  report: CalibrationResult | ContinuousCalibrationResult,
  meta: SnapshotMeta,
): SentinelSnapshot {
  const kappa = 'weightedKappaContinuous' in report ? report.weightedKappaContinuous : report.kappa
  if (!Number.isFinite(kappa)) {
    throw new ValidationError(
      `snapshotFromCalibration: κ is not finite (n=${report.n}) — calibrate against ≥2 joined golden items before snapshotting`,
    )
  }
  const snapshot: SentinelSnapshot = { ...meta, metrics: { calibrationKappa: kappa } }
  validateSentinelSnapshot(snapshot)
  return snapshot
}

/**
 * From `corpusInterRaterAgreement` (statistics.ts) or `continuousAgreement`
 * (judge-calibration.ts) output. IRR = ICC(2,1) — the reliability
 * coefficient both instruments compute. For ensemble-level agreement,
 * `meta.judgeId` names the ensemble and `meta.judgeModel` pins its
 * composition (e.g. a joined list of member model strings).
 */
export function snapshotFromAgreement(
  report: CorpusAgreementReport | ContinuousAgreement,
  meta: SnapshotMeta,
): SentinelSnapshot {
  const irr = 'overallIcc' in report ? report.overallIcc : report.icc
  if (!Number.isFinite(irr)) {
    throw new ValidationError(
      'snapshotFromAgreement: ICC is not finite — agreement needs ≥2 raters and ≥2 complete items',
    )
  }
  const snapshot: SentinelSnapshot = { ...meta, metrics: { irr } }
  validateSentinelSnapshot(snapshot)
  return snapshot
}

export interface SentinelSetOptions {
  /** Max |judge − human| for an item to count as passed. Default 0.1 (tuned for [0,1] scores). */
  tolerance?: number
}

/**
 * From a rerun of a fixed sentinel golden set: the same `GoldenItem`s the
 * judge was originally calibrated on, re-scored periodically. Pass rate =
 * fraction of joined items where the judge stays within `tolerance` of the
 * human score. Items the judge didn't score are excluded from the
 * denominator; zero joined items is an error, not a 0% pass rate.
 */
export function snapshotFromSentinelSet(
  scores: CandidateScore[],
  golden: GoldenItem[],
  meta: SnapshotMeta,
  options: SentinelSetOptions = {},
): SentinelSnapshot {
  const tolerance = options.tolerance ?? 0.1
  if (!Number.isFinite(tolerance) || tolerance < 0) {
    throw new ValidationError(
      `snapshotFromSentinelSet: tolerance must be a finite number ≥ 0, got ${tolerance}`,
    )
  }
  const goldenById = new Map<string, number>()
  for (const item of golden) {
    if (!Number.isFinite(item.humanScore)) {
      throw new ValidationError(
        `snapshotFromSentinelSet: golden item "${item.itemId}" has a non-finite humanScore`,
      )
    }
    if (goldenById.has(item.itemId)) {
      throw new ValidationError(`snapshotFromSentinelSet: duplicate golden itemId "${item.itemId}"`)
    }
    goldenById.set(item.itemId, item.humanScore)
  }
  let joined = 0
  let passed = 0
  for (const s of scores) {
    const human = goldenById.get(s.itemId)
    if (human === undefined) continue
    if (!Number.isFinite(s.score)) {
      throw new ValidationError(
        `snapshotFromSentinelSet: judge score for item "${s.itemId}" is not finite`,
      )
    }
    joined++
    if (Math.abs(s.score - human) <= tolerance) passed++
  }
  if (joined === 0) {
    throw new ValidationError(
      'snapshotFromSentinelSet: no judge scores joined the golden set — itemIds mismatch or empty sentinel run',
    )
  }
  const snapshot: SentinelSnapshot = { ...meta, metrics: { sentinelPassRate: passed / joined } }
  validateSentinelSnapshot(snapshot)
  return snapshot
}

// ── Persistence ──────────────────────────────────────────────────────

export interface SentinelStore {
  append(snapshot: SentinelSnapshot): Promise<void>
  /** All snapshots (optionally for one judge), in append order. */
  history(judgeId?: string): Promise<SentinelSnapshot[]>
}

export function inMemorySentinelStore(initial: SentinelSnapshot[] = []): SentinelStore {
  for (const s of initial) validateSentinelSnapshot(s)
  const items = initial.map((s) => ({ ...s, metrics: { ...s.metrics } }))
  return {
    async append(snapshot) {
      validateSentinelSnapshot(snapshot)
      items.push({ ...snapshot, metrics: { ...snapshot.metrics } })
    },
    async history(judgeId) {
      const all = items.map((s) => ({ ...s, metrics: { ...s.metrics } }))
      return judgeId === undefined ? all : all.filter((s) => s.judgeId === judgeId)
    },
  }
}

/**
 * JSONL store — one snapshot per line, appended atomically per call.
 * A corrupt or shape-invalid line is a loud error naming the file and
 * line number: a sentinel history that silently drops records would
 * defeat the drift detection it exists to provide.
 */
export function fileSentinelStore(path: string): SentinelStore {
  return {
    async append(snapshot) {
      validateSentinelSnapshot(snapshot)
      const fs = await import('node:fs/promises')
      const pathMod = await import('node:path')
      await fs.mkdir(pathMod.dirname(path), { recursive: true })
      await fs.appendFile(path, `${JSON.stringify(snapshot)}\n`, 'utf8')
    },
    async history(judgeId) {
      const fs = await import('node:fs/promises')
      let raw: string
      try {
        raw = await fs.readFile(path, 'utf8')
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
        throw err
      }
      const lines = raw.split('\n')
      const snapshots: SentinelSnapshot[] = []
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!
        if (line.trim().length === 0) continue
        let parsed: unknown
        try {
          parsed = JSON.parse(line)
        } catch (err) {
          throw new ValidationError(
            `judge-sentinel: store at ${path} has a corrupt JSONL line ${i + 1}: ${(err as Error).message}`,
          )
        }
        const snapshot = parsed as SentinelSnapshot
        validateSentinelSnapshot(snapshot, `${path}:${i + 1}`)
        snapshots.push(snapshot)
      }
      return judgeId === undefined ? snapshots : snapshots.filter((s) => s.judgeId === judgeId)
    },
  }
}

// ── Trend report ─────────────────────────────────────────────────────

export interface SentinelThresholds {
  /** Floor for irr — below it the judge ensemble is unreliable regardless of trend. Default 0.6. */
  minIrr?: number
  /** Max tolerated calibrationKappa drop vs the series baseline. Default 0.15. */
  maxKappaDrop?: number
  /** Max tolerated sentinelPassRate drop vs the series baseline. Default 0.1. */
  maxSentinelDrop?: number
  /** Newest snapshot older than this (days, vs asOf) = the sentinel itself went blind. Default 30. */
  staleAfterDays?: number
}

export interface JudgeSentinelOptions {
  /** Caller-supplied ISO timestamp staleness is measured against. */
  asOf: string
  thresholds?: SentinelThresholds
  /** Forwarded to `analyzeSeries` (window, stableCv, driftRun). */
  convergence?: SeriesConvergenceOptions
}

export interface SentinelTrend {
  judgeId: string
  metric: SentinelMetricName
  /** Verbatim `analyzeSeries` state for this judge×metric history. */
  state: SeriesConvergenceResult['state']
  /** Newest value in the series. */
  current: number
  /** Oldest value in the series — the reference the drop thresholds compare against. */
  baseline: number
  /** current − baseline (signed; negative = decayed). */
  drift: number
  alarmed: boolean
  reason?: string
}

export interface SentinelReport {
  perJudge: SentinelTrend[]
  alarms: string[]
  healthy: boolean
  /**
   * `judgeId:metric` pairs with too few snapshots for the convergence
   * machine. Named, not counted — a blind spot you can't see is a blind
   * spot you won't fix. Floor/drop checks still apply to thin series, so
   * insufficient history alone never masks an alarm.
   */
  insufficientHistory: string[]
}

const MS_PER_DAY = 86_400_000

export function judgeSentinelReport(
  history: SentinelSnapshot[],
  opts: JudgeSentinelOptions,
): SentinelReport {
  const asOfMs = parseIso(opts.asOf, 'asOf')
  const minIrr = opts.thresholds?.minIrr ?? 0.6
  const maxKappaDrop = opts.thresholds?.maxKappaDrop ?? 0.15
  const maxSentinelDrop = opts.thresholds?.maxSentinelDrop ?? 0.1
  const staleAfterDays = opts.thresholds?.staleAfterDays ?? 30

  const byJudge = new Map<string, Array<SentinelSnapshot & { atMs: number }>>()
  for (const snapshot of history) {
    validateSentinelSnapshot(snapshot)
    const atMs = parseIso(snapshot.at, `snapshot.at (judge "${snapshot.judgeId}")`)
    const arr = byJudge.get(snapshot.judgeId) ?? []
    arr.push({ ...snapshot, atMs })
    byJudge.set(snapshot.judgeId, arr)
  }

  const perJudge: SentinelTrend[] = []
  const alarms: string[] = []
  const insufficientHistory: string[] = []

  for (const judgeId of [...byJudge.keys()].sort()) {
    const snaps = byJudge.get(judgeId)!.sort((a, b) => a.atMs - b.atMs)
    const newest = snaps[snaps.length - 1]!

    const ageDays = (asOfMs - newest.atMs) / MS_PER_DAY
    if (ageDays > staleAfterDays) {
      alarms.push(
        `judge "${judgeId}": stale — newest snapshot ${newest.at} is ${ageDays.toFixed(1)}d old vs asOf (limit ${staleAfterDays}d)`,
      )
    }

    // Silent-upgrade trap: only the latest model change matters for current
    // trust, and only golden-grounded metrics clear it — irr alone proves
    // judges still agree with each other, not that they're still right.
    let changeIdx = -1
    for (let i = 1; i < snaps.length; i++) {
      if (snaps[i]!.judgeModel !== snaps[i - 1]!.judgeModel) changeIdx = i
    }
    if (changeIdx >= 0) {
      const recalibrated = snaps
        .slice(changeIdx)
        .some(
          (s) =>
            Number.isFinite(s.metrics.calibrationKappa) ||
            Number.isFinite(s.metrics.sentinelPassRate),
        )
      if (!recalibrated) {
        alarms.push(
          `judge "${judgeId}": model changed "${snaps[changeIdx - 1]!.judgeModel}" → "${snaps[changeIdx]!.judgeModel}" at ${snaps[changeIdx]!.at} with no post-change calibration snapshot — silent-upgrade trap; rerun calibrateJudge or the sentinel set against the new model`,
        )
      }
    }

    for (const metric of SENTINEL_METRIC_NAMES) {
      const values = snaps
        .filter((s) => typeof s.metrics[metric] === 'number')
        .map((s) => s.metrics[metric]!)
      if (values.length === 0) continue

      const convergence = analyzeSeries(values, opts.convergence)
      if (convergence.state === 'insufficient-data')
        insufficientHistory.push(`${judgeId}:${metric}`)

      const current = values[values.length - 1]!
      const baseline = values[0]!
      const drift = current - baseline
      const reasons: string[] = []
      if (convergence.state === 'drifting-down') {
        reasons.push(
          `convergence state drifting-down (tail run ${convergence.tailRun}, window mean ${convergence.windowMean.toFixed(3)})`,
        )
      }
      if (metric === 'irr' && current < minIrr) {
        reasons.push(`irr ${current.toFixed(3)} below floor ${minIrr}`)
      }
      if (metric === 'calibrationKappa' && baseline - current > maxKappaDrop) {
        reasons.push(
          `calibrationKappa dropped ${(baseline - current).toFixed(3)} from baseline ${baseline.toFixed(3)} (limit ${maxKappaDrop})`,
        )
      }
      if (metric === 'sentinelPassRate' && baseline - current > maxSentinelDrop) {
        reasons.push(
          `sentinelPassRate dropped ${(baseline - current).toFixed(3)} from baseline ${baseline.toFixed(3)} (limit ${maxSentinelDrop})`,
        )
      }

      const alarmed = reasons.length > 0
      const trend: SentinelTrend = {
        judgeId,
        metric,
        state: convergence.state,
        current,
        baseline,
        drift,
        alarmed,
      }
      if (alarmed) {
        trend.reason = reasons.join('; ')
        alarms.push(`judge "${judgeId}" ${metric}: ${trend.reason}`)
      }
      perJudge.push(trend)
    }
  }

  return { perJudge, alarms, healthy: alarms.length === 0, insufficientHistory }
}

// ── Verdict stamp ────────────────────────────────────────────────────

export interface EvalHealthStamp {
  healthy: boolean
  alarms: string[]
}

/**
 * The object a campaign attaches to its verdicts. Compute it from the
 * sentinel report in a post-campaign hook (or a nightly job feeding the
 * next day's campaigns) and store it alongside the verdict payload.
 * `healthy: false` means the judges that produced those verdicts have an
 * unresolved drift / decay / silent-upgrade / staleness alarm — treat the
 * verdicts as carrying an integrity warning until recalibration clears it.
 */
export function evalHealthStamp(report: SentinelReport): EvalHealthStamp {
  return { healthy: report.healthy, alarms: [...report.alarms] }
}
