/**
 * JudgeAgreementView — pairwise agreement between judges across the
 * corpus, grouped by dimension.
 *
 * Output drives two workflows:
 *   - Judge robustness audit: "does Claude agree with GPT at κ ≥ 0.6?"
 *   - Calibration tracking: κ vs golden human labels over time (by
 *     providing a `humanGoldenJudgeId`).
 */

import { interRaterReliability } from '../statistics'
import type { JudgeSpan } from '../trace/schema'
import type { TraceStore } from '../trace/store'

export interface JudgePair {
  judgeA: string
  judgeB: string
  dimension: string
  /** Number of (targetSpanId, dimension) tuples both judges scored. */
  commonItems: number
  pearson: number
  krippendorff: number
}

export interface JudgeAgreementReport {
  pairs: JudgePair[]
  dimensions: string[]
  judgeIds: string[]
}

export async function judgeAgreementView(store: TraceStore): Promise<JudgeAgreementReport> {
  const all = (await store.spans({ kind: 'judge' })).filter(
    (s): s is JudgeSpan => s.kind === 'judge',
  )
  if (all.length === 0) return { pairs: [], dimensions: [], judgeIds: [] }

  const byDimension = new Map<string, JudgeSpan[]>()
  for (const s of all) {
    const arr = byDimension.get(s.dimension) ?? []
    arr.push(s)
    byDimension.set(s.dimension, arr)
  }

  const judgeIds = [...new Set(all.map((s) => s.judgeId))].sort()
  const pairs: JudgePair[] = []
  for (const [dim, spans] of byDimension) {
    const byJudge = new Map<string, Map<string, number>>()
    for (const s of spans) {
      const m = byJudge.get(s.judgeId) ?? new Map<string, number>()
      m.set(s.targetSpanId, s.score)
      byJudge.set(s.judgeId, m)
    }
    const judgesHere = [...byJudge.keys()]
    for (let i = 0; i < judgesHere.length; i++) {
      for (let j = i + 1; j < judgesHere.length; j++) {
        const judgeI = judgesHere[i]!
        const judgeJ = judgesHere[j]!
        const a = byJudge.get(judgeI)!
        const b = byJudge.get(judgeJ)!
        const common: Array<[number, number]> = []
        for (const [target, scoreA] of a) {
          const scoreB = b.get(target)
          if (scoreB !== undefined) common.push([scoreA, scoreB])
        }
        if (common.length < 2) continue
        const judgeScores = common.map(
          ([scoreA, scoreB]) =>
            [
              { judgeName: judgeI, dimension: dim, score: scoreA, reasoning: '' },
              { judgeName: judgeJ, dimension: dim, score: scoreB, reasoning: '' },
            ] as const,
        )
        const k = interRaterReliability(
          judgeScores[0]!.map((_, k2) => judgeScores.map((pair) => pair[k2]!)),
        )
        pairs.push({
          judgeA: judgeI,
          judgeB: judgeJ,
          dimension: dim,
          commonItems: common.length,
          pearson: pearson(
            common.map((c) => c[0]),
            common.map((c) => c[1]),
          ),
          krippendorff: k,
        })
      }
    }
  }

  return {
    pairs: pairs.sort((a, b) => b.commonItems - a.commonItems),
    dimensions: [...byDimension.keys()].sort(),
    judgeIds,
  }
}

function pearson(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length < 2) return NaN
  const mA = a.reduce((s, v) => s + v, 0) / a.length
  const mB = b.reduce((s, v) => s + v, 0) / b.length
  let num = 0,
    denA = 0,
    denB = 0
  for (let i = 0; i < a.length; i++) {
    const dA = a[i]! - mA
    const dB = b[i]! - mB
    num += dA * dB
    denA += dA * dA
    denB += dB * dB
  }
  if (denA === 0 || denB === 0) return denA === 0 && denB === 0 ? 1 : 0
  return num / Math.sqrt(denA * denB)
}
