import { wilson } from '../../src/statistics/paired-binary'
import { type SimArtifact, type SimOptions } from './types'
import { ROOT_ARTIFACT, round } from './objective'
import { interval, clopperPearson } from './statistics'
import { memoryStore } from './store'
import { runSimulation } from './run'

// ── claims: many searches, one tally ─────────────────────────────────

export async function claims(options: SimOptions, searches: number): Promise<Record<string, unknown>> {
  const startedAt = Date.now()
  const decisions = { ship: 0, hold: 0, 'test-cannot-resolve': 0 }
  let testRan = 0
  let falseClaims = 0
  let trueClaims = 0
  let finalistsTested = 0
  let finalistsPromoted = 0
  let falsePromotions = 0
  let nodes = 0
  let cells = 0
  const finalistCounts: Record<number, number> = {}
  const powers: number[] = []
  /** The top finalist's selection delta minus its test delta: selection's optimism. */
  const optimism: number[] = []
  const falseClaimSeeds: number[] = []
  for (let index = 0; index < searches; index++) {
    const seed = options.seed + index
    const { result, summary } = await runSimulation(
      `mem://search-sim/${seed}`,
      { ...options, seed },
      memoryStore(),
    )
    const claim = summary.claim as {
      decision: keyof typeof decisions
      selected: (SimArtifact & { nodeId: string }) | null
      power: { powerAtMinimumEffect?: number }
      finalists: Array<{
        trueGain: number
        selectionDelta: number | null
        promote: boolean
        test: { delta: number } | null
      }>
    }
    decisions[claim.decision] += 1
    nodes += result.state.audit.nodes
    cells += result.state.audit.cells.allocated
    if (claim.power.powerAtMinimumEffect !== undefined)
      powers.push(claim.power.powerAtMinimumEffect)
    const top = claim.finalists[0]
    if (top?.test && top.selectionDelta !== null) optimism.push(top.selectionDelta - top.test.delta)
    const tested = claim.finalists.filter((finalist) => finalist.test !== null)
    if (tested.length > 0) {
      testRan += 1
      finalistCounts[tested.length] = (finalistCounts[tested.length] ?? 0) + 1
    }
    finalistsTested += tested.length
    for (const finalist of tested) {
      if (!finalist.promote) continue
      finalistsPromoted += 1
      if (finalist.trueGain <= 0) falsePromotions += 1
    }
    if (claim.decision === 'ship') {
      if (claim.selected!.quality - ROOT_ARTIFACT.quality > 0) trueClaims += 1
      else {
        falseClaims += 1
        falseClaimSeeds.push(seed)
      }
    }
  }
  powers.sort((a, b) => a - b)
  const quantile = (q: number): number | null =>
    powers.length === 0 ? null : powers[Math.min(powers.length - 1, Math.floor(q * powers.length))]!
  const rate = (successes: number) => ({
    count: successes,
    of: searches,
    rate: round(successes / searches),
    wilson95: interval(wilson(successes, searches, 0.95)),
    clopperPearson95: clopperPearson(successes, searches, 0.95),
  })
  return {
    searches,
    seeds: [options.seed, options.seed + searches - 1],
    design: {
      nodesPerSearch: 1 + options.population * options.expansions,
      train: options.train,
      selection: options.selection,
      test: options.test,
      reps: options.reps,
      minimumEffect: options.minEffect ?? null,
      scores: options.binary ? 'pass/fail' : 'continuous',
      direction: options.minimize ? 'minimize' : 'maximize',
      truth: options.nullSteps
        ? `no node differs from the root${options.plantGain === null ? '' : `, except root.0 at +${options.plantGain} and its descendants`}`
        : 'seeded steps',
    },
    decisions,
    testRan,
    falseClaims: rate(falseClaims),
    trueClaims: rate(trueClaims),
    falseClaimSeeds,
    finalists: {
      perSearchWhenTested: finalistCounts,
      tested: finalistsTested,
      promoted: finalistsPromoted,
      promotedWithNoTrueGain: falsePromotions,
    },
    powerAtMinimumEffect: { min: quantile(0), median: quantile(0.5), max: quantile(1) },
    topFinalistSelectionMinusTest: {
      searches: optimism.length,
      mean:
        optimism.length === 0 ? null : round(optimism.reduce((a, b) => a + b, 0) / optimism.length),
      median:
        optimism.length === 0
          ? null
          : round([...optimism].sort((a, b) => a - b)[Math.floor(optimism.length / 2)]!),
    },
    meanNodes: round(nodes / searches),
    meanCells: round(cells / searches),
    seconds: round((Date.now() - startedAt) / 1000),
  }
}

