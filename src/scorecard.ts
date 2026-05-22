/**
 * @stable
 *
 * Eval scorecard — the persistent (persona × profile) score timeline.
 *
 * Every benchmark run folds into per-cell entries; a cell is
 * `(scenarioId, profileHash)` and its timeline carries one entry per commit.
 * The scorecard answers the question a single run cannot: did THIS change
 * regress persona P on profile F, even while the aggregate improved?
 *
 * Storage is an append-only JSONL log — one line per (cell, commit). Appends
 * never read-modify-write, so concurrent campaign runs cannot clobber each
 * other; `loadScorecard` folds the log into the queryable `Scorecard`, and a
 * malformed line never breaks the read. `diffScorecard` compares the latest
 * entry of each cell against its predecessor with Cohen's d + Welch's t-test.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { AgentProfile } from './agent-profile'
import { agentProfileHash } from './agent-profile'
import { welchsTTest } from './baseline'
import type { RunRecord } from './run-record'
import { cohensD } from './statistics'

// ── Types ────────────────────────────────────────────────────────────

/** One commit's measurement of one (scenario, profile) cell. */
export interface ScorecardEntry {
  commitSha: string
  /** ISO timestamp the entry was recorded. */
  timestamp: string
  /** Per-seed (or per-rep) scores for this cell at this commit. */
  scores: number[]
  /** Median of `scores` — the cell's headline score for the commit. */
  composite: number
  /** Per-dimension means, when the runs carried a judge breakdown. */
  perDimension?: Record<string, number>
  /** RunRecord ids folded into this entry — provenance. */
  runIds: string[]
}

/** A (scenario, profile) cell and its commit-ordered score timeline. */
export interface ScorecardCell {
  scenarioId: string
  profileHash: string
  /** Model id — denormalised from the profile for readable filtering. */
  model: string
  timeline: ScorecardEntry[]
}

/** The folded scorecard: every cell, plus the profile definitions by hash. */
export interface Scorecard {
  cells: ScorecardCell[]
  /** Profile definitions seen — keeps the scorecard self-describing. */
  profiles: Record<string, AgentProfile>
}

/** One append-only log line — a single cell's entry for a single commit. */
export interface ScorecardLogLine {
  scenarioId: string
  profileHash: string
  model: string
  profile: AgentProfile
  entry: ScorecardEntry
}

// ── Recording ────────────────────────────────────────────────────────

export interface RecordRunsOptions {
  /** The profile that produced these runs — keys the cell. */
  profile: AgentProfile
  commitSha: string
  /** Defaults to `new Date().toISOString()`. */
  timestamp?: string
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0
  const sorted = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!
}

/** The split score the run actually carries (`holdout` runs fill holdoutScore). */
function runScore(run: RunRecord): number | undefined {
  return run.outcome.holdoutScore ?? run.outcome.searchScore
}

/** Mean of each judge dimension across the runs that reported one. */
function aggregatePerDimension(runs: RunRecord[]): Record<string, number> | undefined {
  const sums = new Map<string, { total: number; count: number }>()
  for (const run of runs) {
    const dims = run.outcome.judgeScores?.perDimMean
    if (!dims) continue
    for (const [dim, value] of Object.entries(dims)) {
      if (!Number.isFinite(value)) continue
      const acc = sums.get(dim) ?? { total: 0, count: 0 }
      acc.total += value
      acc.count += 1
      sums.set(dim, acc)
    }
  }
  if (sums.size === 0) return undefined
  const out: Record<string, number> = {}
  for (const [dim, acc] of sums) out[dim] = acc.total / acc.count
  return out
}

/**
 * Fold a benchmark's `RunRecord[]` into per-cell scorecard log lines — one
 * line per scenario the runs cover. All runs are attributed to the single
 * `profile` in `opts` (the harness ran them under it); the cell key is
 * `(scenarioId, agentProfileHash(profile))`.
 */
export function recordRuns(runs: RunRecord[], opts: RecordRunsOptions): ScorecardLogLine[] {
  const profileHash = agentProfileHash(opts.profile)
  const timestamp = opts.timestamp ?? new Date().toISOString()

  const byScenario = new Map<string, RunRecord[]>()
  for (const run of runs) {
    const scenarioId = run.scenarioId
    if (!scenarioId) continue // un-keyed run — cannot place it in a cell
    const bucket = byScenario.get(scenarioId)
    if (bucket) bucket.push(run)
    else byScenario.set(scenarioId, [run])
  }

  const lines: ScorecardLogLine[] = []
  for (const [scenarioId, scenarioRuns] of byScenario) {
    const scored = scenarioRuns
      .map((run) => ({ run, score: runScore(run) }))
      .filter((s): s is { run: RunRecord; score: number } => s.score !== undefined)
    if (scored.length === 0) continue
    const scores = scored.map((s) => s.score)
    const entry: ScorecardEntry = {
      commitSha: opts.commitSha,
      timestamp,
      scores,
      composite: median(scores),
      runIds: scored.map((s) => s.run.runId),
    }
    const perDimension = aggregatePerDimension(scenarioRuns)
    if (perDimension) entry.perDimension = perDimension
    lines.push({
      scenarioId,
      profileHash,
      model: opts.profile.model,
      profile: opts.profile,
      entry,
    })
  }
  return lines
}

// ── Storage ──────────────────────────────────────────────────────────

/** Append cell entries to the JSONL scorecard log. Creates the file/dir. */
export function appendScorecard(logPath: string, lines: ScorecardLogLine[]): void {
  if (lines.length === 0) return
  mkdirSync(dirname(logPath), { recursive: true })
  appendFileSync(logPath, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`)
}

/** Record runs and append them to the log in one call. Returns the lines. */
export function recordRunsToScorecard(
  logPath: string,
  runs: RunRecord[],
  opts: RecordRunsOptions,
): ScorecardLogLine[] {
  const lines = recordRuns(runs, opts)
  appendScorecard(logPath, lines)
  return lines
}

/**
 * Fold the JSONL log into a queryable `Scorecard`. A missing file yields an
 * empty scorecard; a malformed line is skipped — a corrupt append never
 * breaks the read. Each cell's timeline is sorted chronologically.
 */
export function loadScorecard(logPath: string): Scorecard {
  if (!existsSync(logPath)) return { cells: [], profiles: {} }
  const cells = new Map<string, ScorecardCell>()
  const profiles: Record<string, AgentProfile> = {}

  for (const raw of readFileSync(logPath, 'utf8').split('\n')) {
    const line = raw.trim()
    if (!line) continue
    let parsed: ScorecardLogLine
    try {
      parsed = JSON.parse(line) as ScorecardLogLine
    } catch {
      continue // skip a malformed line rather than failing the whole read
    }
    if (!parsed?.scenarioId || !parsed.profileHash || !parsed.entry) continue
    const key = `${parsed.scenarioId}::${parsed.profileHash}`
    let cell = cells.get(key)
    if (!cell) {
      cell = {
        scenarioId: parsed.scenarioId,
        profileHash: parsed.profileHash,
        model: parsed.model,
        timeline: [],
      }
      cells.set(key, cell)
    }
    cell.timeline.push(parsed.entry)
    if (parsed.profile) profiles[parsed.profileHash] = parsed.profile
  }

  for (const cell of cells.values()) {
    cell.timeline.sort((a, b) => a.timestamp.localeCompare(b.timestamp))
  }
  return { cells: [...cells.values()], profiles }
}

// ── Diff ─────────────────────────────────────────────────────────────

export type CellVerdict = 'improved' | 'regressed' | 'flat' | 'new'

export interface ScorecardCellDiff {
  scenarioId: string
  profileHash: string
  model: string
  verdict: CellVerdict
  /** Composite of the latest entry. */
  current: number
  /** Composite of the comparison entry — `null` when `verdict === 'new'`. */
  baseline: number | null
  /** `current − baseline` — `null` when new. */
  delta: number | null
  /** Cohen's d of current vs baseline samples — `null` when new or n < 2. */
  cohensD: number | null
  /** Welch's t-test p-value — `null` when new or n < 2. */
  pValue: number | null
  currentCommit: string
  baselineCommit: string | null
}

export interface ScorecardDiff {
  cells: ScorecardCellDiff[]
  summary: { improved: number; regressed: number; flat: number; new: number }
}

export interface DiffScorecardOptions {
  /** Compare each cell against this commit instead of its immediate predecessor. */
  baselineCommit?: string
  /** |Cohen's d| at/above which a move counts as real. Default 0.5. */
  minEffect?: number
  /** p-value at/below which a move is significant. Default 0.05. */
  maxP?: number
  /**
   * |delta| at/above which a move counts when statistics are unavailable
   * (a cell with fewer than 2 samples on either side). Default 0.05.
   */
  minDelta?: number
}

/**
 * Compare the latest entry of every cell against its predecessor (or against
 * `baselineCommit`) and classify the move. A move is `improved`/`regressed`
 * only when it clears both the effect-size and significance gates; otherwise
 * `flat`. Cells with no prior entry are `new`.
 */
export function diffScorecard(
  scorecard: Scorecard,
  opts: DiffScorecardOptions = {},
): ScorecardDiff {
  const minEffect = opts.minEffect ?? 0.5
  const maxP = opts.maxP ?? 0.05
  const minDelta = opts.minDelta ?? 0.05

  const cells: ScorecardCellDiff[] = []
  for (const cell of scorecard.cells) {
    const timeline = cell.timeline
    if (timeline.length === 0) continue
    const current = timeline[timeline.length - 1]!

    const baseline = opts.baselineCommit
      ? [...timeline].reverse().find((e) => e.commitSha === opts.baselineCommit && e !== current)
      : timeline[timeline.length - 2]

    const base: Omit<
      ScorecardCellDiff,
      'verdict' | 'baseline' | 'delta' | 'cohensD' | 'pValue' | 'baselineCommit'
    > = {
      scenarioId: cell.scenarioId,
      profileHash: cell.profileHash,
      model: cell.model,
      current: current.composite,
      currentCommit: current.commitSha,
    }

    if (!baseline) {
      cells.push({
        ...base,
        verdict: 'new',
        baseline: null,
        delta: null,
        cohensD: null,
        pValue: null,
        baselineCommit: null,
      })
      continue
    }

    const delta = current.composite - baseline.composite
    const canStat = baseline.scores.length >= 2 && current.scores.length >= 2
    let d: number | null = null
    let p: number | null = null
    let verdict: CellVerdict

    if (canStat) {
      d = cohensD(baseline.scores, current.scores)
      const t = welchsTTest(baseline.scores, current.scores)
      p = Number.isFinite(t.p) ? t.p : null
      const significant = Math.abs(d) >= minEffect && p !== null && p <= maxP
      verdict = significant ? (delta > 0 ? 'improved' : 'regressed') : 'flat'
    } else {
      // Too few samples for a real test — fall back to a raw-delta threshold.
      verdict = Math.abs(delta) >= minDelta ? (delta > 0 ? 'improved' : 'regressed') : 'flat'
    }

    cells.push({
      ...base,
      verdict,
      baseline: baseline.composite,
      delta,
      cohensD: d,
      pValue: p,
      baselineCommit: baseline.commitSha,
    })
  }

  const summary = { improved: 0, regressed: 0, flat: 0, new: 0 }
  for (const cell of cells) summary[cell.verdict] += 1
  return { cells, summary }
}

/**
 * Render a scorecard diff as a human-readable report — the block a feature
 * PR prints. Regressions are listed first; flat cells are summarised, not
 * enumerated.
 */
export function formatScorecardDiff(diff: ScorecardDiff): string {
  const lines: string[] = []
  const { summary } = diff
  lines.push(
    `Scorecard: ${summary.regressed} regressed · ${summary.improved} improved · ` +
      `${summary.flat} flat · ${summary.new} new`,
  )

  const fmt = (n: number) => n.toFixed(3)
  const noteworthy = diff.cells
    .filter((c) => c.verdict === 'regressed' || c.verdict === 'improved')
    .sort((a, b) => {
      // Regressions first, then by magnitude of delta.
      if (a.verdict !== b.verdict) return a.verdict === 'regressed' ? -1 : 1
      return Math.abs(b.delta ?? 0) - Math.abs(a.delta ?? 0)
    })

  for (const cell of noteworthy) {
    const mark = cell.verdict === 'regressed' ? 'REGRESSED' : 'improved'
    const deltaStr =
      cell.delta !== null ? (cell.delta >= 0 ? `+${fmt(cell.delta)}` : fmt(cell.delta)) : '—'
    const stat =
      cell.cohensD !== null
        ? ` (d=${cell.cohensD.toFixed(2)}${cell.pValue !== null ? `, p=${cell.pValue.toFixed(3)}` : ''})`
        : ''
    lines.push(
      `  ${mark}  ${cell.scenarioId} · ${cell.model} · ${cell.profileHash.slice(0, 8)}  ` +
        `${fmt(cell.baseline ?? 0)} → ${fmt(cell.current)}  ${deltaStr}${stat}`,
    )
  }

  return lines.join('\n')
}
