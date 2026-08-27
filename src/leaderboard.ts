/**
 * Cross-profile leaderboard — rank agent profiles (or any grouping) over a corpus
 * of RunRecords on pass-rate with a Wilson CI, joined with the cost / token /
 * latency rollup every benchmark wants next to the score.
 *
 * This is substrate, not benchmark-specific: any consumer of agent-eval gets a
 * cross-harness × model leaderboard without re-implementing grouping, binomial
 * CIs, or the observability join. The benchmark supplies only what "passed"
 * means; everything else composes existing primitives (`wilson`, the RunRecord
 * cost/token/wall fields, the AgentProfileCell grouping key).
 */
import type { RunRecord } from './run-record'
import { wilson } from './statistics'

export interface LeaderboardRow {
  /** Group key — the agent-profile cellId by default, else a caller dimension. */
  key: string
  /** Display label: `harness · model` when the profile carries them, else the key. */
  label: string
  harness?: string
  model?: string
  rank: number
  /** Measured runs in this group. */
  n: number
  passRate: number
  passRateCi95: [number, number]
  /** Observability rollup — means over the group; null when no run reported it. */
  meanCostUsd: number | null
  meanTokensIn: number | null
  meanTokensOut: number | null
  meanWallMs: number | null
}

export interface LeaderboardOptions {
  /** Per-run pass predicate — the benchmark defines what "passed" means (real-build
   *  hit-rate, test-pass, etc.). The leaderboard owns only the grouping + stats. */
  passed: (record: RunRecord) => boolean
  /** Group key. Default: the agent-profile cellId (harness × model × dimensions),
   *  so persona/harness/model sweeps separate without parsing labels. */
  groupBy?: (record: RunRecord) => string
}

function mean(xs: number[]): number | null {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null
}

/**
 * Group `records`, compute pass-rate + Wilson CI + cost/token/latency means per
 * group, and rank by pass-rate (cost as the tiebreaker — cheaper wins a tie).
 * Pure projection: no I/O, deterministic, safe to call on any RunRecord[].
 */
export function leaderboard(records: RunRecord[], opts: LeaderboardOptions): LeaderboardRow[] {
  const keyOf = opts.groupBy ?? ((r: RunRecord) => r.agentProfile?.cellId ?? 'ungrouped')
  const groups = new Map<string, RunRecord[]>()
  for (const r of records) {
    const k = keyOf(r)
    const g = groups.get(k)
    if (g) g.push(r)
    else groups.set(k, [r])
  }

  const rows: LeaderboardRow[] = [...groups.entries()].map(([key, rs]) => {
    const passes = rs.filter((r) => opts.passed(r)).length
    const ci = wilson(passes, rs.length)
    const profile = rs[0]!.agentProfile
    const harness = profile?.harness?.id
    const model = profile?.model
    return {
      key,
      label: harness && model ? `${harness} · ${model}` : key,
      ...(harness ? { harness } : {}),
      ...(model ? { model } : {}),
      rank: 0,
      n: rs.length,
      passRate: ci.estimate,
      passRateCi95: [ci.lower, ci.upper],
      meanCostUsd: mean(rs.map((r) => r.costUsd)),
      meanTokensIn: mean(rs.map((r) => r.tokenUsage.input)),
      meanTokensOut: mean(rs.map((r) => r.tokenUsage.output)),
      meanWallMs: mean(rs.map((r) => r.wallMs)),
    }
  })

  rows.sort(
    (a, b) => b.passRate - a.passRate || (a.meanCostUsd ?? Infinity) - (b.meanCostUsd ?? Infinity),
  )
  rows.forEach((row, i) => {
    row.rank = i + 1
  })
  return rows
}
