import { wilson } from '../../src/statistics/paired-binary'
import { type SimOptions, type SimPolicy, isSimPolicy } from './types'
import { ROOT, round, plantedName } from './objective'
import { memoryStore } from './store'
import { runSimulation } from './run'
import { interval, exactSignTest } from './statistics'

/**
 * The same search under each arm (`policy+allocation`), once per seed from
 * `options.seed`: cells each allocated, the node each kept, whether it was the
 * planted node, and the units each measured edge pairs on. Every later arm is
 * paired with the first by seed. Ledgers and blobs are held in memory; every
 * run's ledger audit must pass.
 */
export async function compare(options: SimOptions, seeds: number, arms: readonly Arm[]) {
  interface ArmRow {
    cells: number
    nodes: number
    kept: string
    quality: number
    planted: boolean
    reached: boolean
    ledgerOk: boolean
    edgePairs: Record<string, number>
    advancedTo: Record<string, number>
    statuses: Record<string, number>
    operators: Record<string, number>
    maxDepth: number
  }
  const startedAt = Date.now()
  const rows: Array<{ seed: number; arms: ArmRow[] }> = []
  for (let seed = options.seed; seed < options.seed + seeds; seed++) {
    const runs: ArmRow[] = []
    for (const arm of arms) {
      const { result, summary } = await runSimulation(
        `mem://search-sim/${seed}/${arm.policy}+${arm.allocation}`,
        { ...options, seed, policy: arm.policy, allocation: arm.allocation },
        memoryStore(),
      )
      const kept = summary.kept as { name: string; quality: number; planted: boolean }
      const checks = summary.ledgerChecks as {
        ok: boolean
        edgePairs: Record<string, number>
        advancedTo: Record<string, number>
        statuses: Record<string, number>
        operators: Record<string, number>
        maxDepth: number
      }
      runs.push({
        cells: result.state.audit.cells.allocated,
        nodes: result.state.audit.nodes,
        kept: kept.name,
        quality: kept.quality,
        planted: kept.planted,
        reached: summary.reachedPlant as boolean,
        ledgerOk: checks.ok,
        edgePairs: checks.edgePairs,
        advancedTo: checks.advancedTo,
        statuses: checks.statuses,
        operators: checks.operators,
        maxDepth: checks.maxDepth,
      })
    }
    rows.push({ seed, arms: runs })
  }
  const add = (into: Record<string, number>, from: Record<string, number>): void => {
    for (const [key, value] of Object.entries(from)) into[key] = (into[key] ?? 0) + value
  }
  const planted = plantedName(options) !== null
  /** Half the planted gain above the root: a kept node at or above it carries
   * the gain, whether it is the planted node or a descendant that lost little. */
  const halfGain = ROOT.quality + (options.deepGain ?? options.poolGap ?? 0) / 2
  const summarize = (index: number) => {
    const list = rows.map((row) => row.arms[index]!)
    const cells = list.map((row) => row.cells).sort((a, b) => a - b)
    const nodes = list.map((row) => row.nodes).sort((a, b) => a - b)
    const edgePairs: Record<string, number> = {}
    const advancedTo: Record<string, number> = {}
    const statuses: Record<string, number> = {}
    const operators: Record<string, number> = {}
    const maxDepth: Record<string, number> = {}
    for (const row of list) {
      add(edgePairs, row.edgePairs)
      add(advancedTo, row.advancedTo)
      add(statuses, row.statuses)
      add(operators, row.operators)
      maxDepth[row.maxDepth] = (maxDepth[row.maxDepth] ?? 0) + 1
    }
    const pairCounts = Object.keys(edgePairs).map(Number)
    const found = list.filter((row) => row.planted).length
    const gained = list.filter((row) => row.quality >= halfGain - 1e-9).length
    return {
      arm: `${arms[index]!.policy}+${arms[index]!.allocation}`,
      cells: {
        total: cells.reduce((sum, value) => sum + value, 0),
        min: cells[0],
        median: cells[Math.floor(cells.length / 2)],
        max: cells.at(-1),
      },
      nodes: {
        total: nodes.reduce((sum, value) => sum + value, 0),
        min: nodes[0],
        median: nodes[Math.floor(nodes.length / 2)],
        max: nodes.at(-1),
      },
      ...(planted
        ? {
            /** Searches that kept the planted node. */
            findRate: {
              count: found,
              of: list.length,
              rate: round(found / list.length),
              wilson95: interval(wilson(found, list.length, 0.95)),
            },
            /** Searches that kept a node at least half the planted gain above
             * the root: the planted node, or a descendant that kept the gain. */
            gainRate: {
              count: gained,
              of: list.length,
              rate: round(gained / list.length),
              wilson95: interval(wilson(gained, list.length, 0.95)),
            },
            /** Searches that registered the planted node at all. */
            reachedPlant: list.filter((row) => row.reached).length,
            missedPlantedSeeds: rows.filter((row) => !row.arms[index]!.planted).map((row) => row.seed),
          }
        : {}),
      meanKeptQuality: round(list.reduce((sum, row) => sum + row.quality, 0) / list.length),
      keptBetterThanRoot: list.filter((row) => row.quality > ROOT.quality).length,
      ledgerAuditsPassed: list.filter((row) => row.ledgerOk).length,
      /** Measured edges by the units they pair on against their parent. */
      edgePairs,
      minEdgePairs: pairCounts.length === 0 ? null : Math.min(...pairCounts),
      /** `advanced` decisions by the rung they opened. */
      advancedTo,
      /** Final node statuses across the searches. */
      statuses,
      /** Edges by operator across the searches. */
      operators,
      /** Searches by the depth of their deepest node. */
      maxDepth,
    }
  }
  const summaries = arms.map((_, index) => summarize(index))
  const versusFirst = arms.slice(1).map((_, offset) => {
    const index = offset + 1
    const only = rows.filter((row) => row.arms[index]!.planted && !row.arms[0]!.planted).length
    const firstOnly = rows.filter((row) => !row.arms[index]!.planted && row.arms[0]!.planted).length
    const gains = (row: (typeof rows)[number], at: number): boolean =>
      row.arms[at]!.quality >= halfGain - 1e-9
    const gainOnly = rows.filter((row) => gains(row, index) && !gains(row, 0)).length
    const gainFirstOnly = rows.filter((row) => !gains(row, index) && gains(row, 0)).length
    return {
      arm: summaries[index]!.arm,
      against: summaries[0]!.arm,
      sameKept: rows.filter((row) => row.arms[index]!.kept === row.arms[0]!.kept).length,
      fewerCells: rows.filter((row) => row.arms[index]!.cells < row.arms[0]!.cells).length,
      cellShare: round(summaries[index]!.cells.total / summaries[0]!.cells.total),
      ...(planted
        ? {
            /** Seeds where only this arm kept the planted node, and where only the first did. */
            plantedOnlyHere: only,
            plantedOnlyInFirst: firstOnly,
            signTestP: round(exactSignTest(only, firstOnly)),
            /** The same pairing on keeping at least half the planted gain. */
            gainOnlyHere: gainOnly,
            gainOnlyInFirst: gainFirstOnly,
            gainSignTestP: round(exactSignTest(gainOnly, gainFirstOnly)),
          }
        : {}),
    }
  })
  return {
    ok: summaries.every((summary) => summary.ledgerAuditsPassed === rows.length),
    seeds: rows.length,
    firstSeed: options.seed,
    design: {
      train: options.train,
      selection: options.selection,
      population: options.population,
      maxCells: options.maxCells,
      plant:
        options.deepGain !== null
          ? { kind: 'deep', gain: options.deepGain, depth: options.deepDepth, ramp: options.deepRamp }
          : options.poolGap !== null
            ? { kind: 'pool', gain: options.poolGap }
            : null,
      defectRate: options.defectRate,
      faultRate: options.faultRate,
    },
    arms: summaries,
    versusFirst,
    seconds: round((Date.now() - startedAt) / 1000),
    perSeed: rows.map((row) => ({
      seed: row.seed,
      /** Per arm: kept node, its true quality, kept the plant, reached the plant, cells, nodes. */
      arms: row.arms.map((arm) => [
        arm.kept,
        arm.quality,
        arm.planted ? 1 : 0,
        arm.reached ? 1 : 0,
        arm.cells,
        arm.nodes,
      ]),
    })),
  }
}

interface Arm {
  policy: SimPolicy
  allocation: SimOptions['allocation']
}

export function parseArms(text: string): Arm[] {
  return text.split(',').map((entry) => {
    const [policy, allocation] = entry.split('+')
    if (!isSimPolicy(policy)) {
      throw new Error(`--arms: unknown policy ${String(policy)} in ${entry}`)
    }
    if (allocation !== 'uniform' && allocation !== 'asha') {
      throw new Error(`--arms: unknown allocation ${String(allocation)} in ${entry}`)
    }
    return { policy, allocation }
  })
}
