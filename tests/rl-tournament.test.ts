import { describe, expect, it } from 'vitest'
import {
  applyEloUpdate,
  buildPairwiseFromCampaign,
  fitBradleyTerry,
} from '../src/rl/tournament'

describe('Bradley-Terry MLE', () => {
  it('recovers the dominance order on a transitive set', () => {
    // a beats b, b beats c, a beats c — strict total order.
    const fit = fitBradleyTerry([
      { winner: 'a', loser: 'b' },
      { winner: 'b', loser: 'c' },
      { winner: 'a', loser: 'c' },
      { winner: 'a', loser: 'b' },
      { winner: 'b', loser: 'c' },
    ])
    expect(fit.converged).toBe(true)
    expect(fit.ratings.map((r) => r.candidateId)).toEqual(['a', 'b', 'c'])
    expect(fit.ratings[0]!.strength).toBeGreaterThan(fit.ratings[1]!.strength)
    expect(fit.ratings[1]!.strength).toBeGreaterThan(fit.ratings[2]!.strength)
  })

  it('handles draws via half-credit', () => {
    const fit = fitBradleyTerry([
      { winner: 'a', loser: 'b', draw: true },
      { winner: 'a', loser: 'b', draw: true },
      { winner: 'a', loser: 'b' },
    ])
    // 2.5 wins for a, 0.5 wins for b → a should be favored.
    expect(fit.ratings[0]!.candidateId).toBe('a')
    expect(fit.ratings[0]!.strength).toBeGreaterThan(fit.ratings[1]!.strength)
  })

  it('respects pairwise weights so wider score gaps move ratings further', () => {
    const fitTight = fitBradleyTerry([
      { winner: 'a', loser: 'b', weight: 0.1 },
    ], { smoothing: 0.5 })
    const fitWide = fitBradleyTerry([
      { winner: 'a', loser: 'b', weight: 10 },
    ], { smoothing: 0.5 })
    // Bigger weight = bigger strength gap.
    const tightRatio = fitTight.ratings[0]!.strength / fitTight.ratings[1]!.strength
    const wideRatio = fitWide.ratings[0]!.strength / fitWide.ratings[1]!.strength
    expect(wideRatio).toBeGreaterThan(tightRatio)
  })

  it('returns empty when no comparisons exist', () => {
    const fit = fitBradleyTerry([])
    expect(fit.ratings).toEqual([])
  })
})

describe('Elo updates', () => {
  it('moves the winner up and the loser down', () => {
    const ratings = new Map<string, number>()
    ratings.set('a', 1500)
    ratings.set('b', 1500)
    const delta = applyEloUpdate(ratings, { winner: 'a', loser: 'b' })
    expect(ratings.get('a')!).toBeGreaterThan(1500)
    expect(ratings.get('b')!).toBeLessThan(1500)
    expect(delta.winnerDelta).toBeGreaterThan(0)
    expect(delta.loserDelta).toBeLessThan(0)
    // Conservation: winner gain ≈ -loser loss.
    expect(delta.winnerDelta).toBeCloseTo(-delta.loserDelta, 5)
  })

  it('upset: weaker player beating stronger player gives bigger movement', () => {
    const ratings1 = new Map([['weak', 1200], ['strong', 1800]])
    const ratings2 = new Map([['weak', 1200], ['strong', 1800]])
    const expected = applyEloUpdate(ratings2, { winner: 'strong', loser: 'weak' })
    const upset = applyEloUpdate(ratings1, { winner: 'weak', loser: 'strong' })
    expect(upset.winnerDelta).toBeGreaterThan(Math.abs(expected.winnerDelta))
  })

  it('draws mid-shift the ratings toward equality', () => {
    const ratings = new Map([['a', 1600], ['b', 1400]])
    applyEloUpdate(ratings, { winner: 'a', loser: 'b', draw: true })
    expect(ratings.get('a')!).toBeLessThan(1600)
    expect(ratings.get('b')!).toBeGreaterThan(1400)
  })
})

describe('buildPairwiseFromCampaign', () => {
  it('extracts pairs per matched scenario, weighting by margin', () => {
    const out = buildPairwiseFromCampaign({
      runs: [
        { candidateId: 'a', matchKey: 's1', score: 0.5 },
        { candidateId: 'b', matchKey: 's1', score: 0.7 },
        { candidateId: 'a', matchKey: 's2', score: 0.4 },
        { candidateId: 'b', matchKey: 's2', score: 0.45 },
      ],
      drawMargin: 0,
    })
    expect(out).toHaveLength(2)
    expect(out[0]!.weight).toBeCloseTo(0.2, 5)
    expect(out[0]!.winner).toBe('b')
  })

  it('drawMargin folds tight comparisons into draws', () => {
    const out = buildPairwiseFromCampaign({
      runs: [
        { candidateId: 'a', matchKey: 's1', score: 0.5 },
        { candidateId: 'b', matchKey: 's1', score: 0.51 },
      ],
      drawMargin: 0.05,
    })
    expect(out).toHaveLength(1)
    expect(out[0]!.draw).toBe(true)
  })
})
