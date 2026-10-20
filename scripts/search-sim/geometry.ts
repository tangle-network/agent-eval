import { type LandscapeData, type LandscapeEmbedding, landscape, lineEditDistance } from '../../src/search/lenses/landscape'
import { skillCalibration, skillManifold } from '../../src/search/lenses/skill-manifold'
import { wilson } from '../../src/statistics/paired-binary'
import { type SimArtifact, type SimOptions } from './types'
import { round } from './objective'
import { memoryStore } from './store'
import { runSimulation } from './run'
import { interval, pairedReport } from './statistics'

/** Line edits between two sim artifacts' profile texts: the distance the
 * `landscape` lens reads from blobs in `search show`. */
function simTextEdits(truth: (nodeId: string) => SimArtifact): LandscapeEmbedding {
  return {
    kind: 'distance',
    name: 'sim-text-edits',
    method: 'line insertions plus deletions between the sim artifacts’ profile lines (Myers diff)',
    distance(a, b) {
      const left = truth(a.nodeId).lines
      const right = truth(b.nodeId).lines
      return left && right ? lineEditDistance(left, right) : null
    },
  }
}

/** Whether the landscape drew its kriged surface, and if not, why: `flat`
 * when node scores vary no more than their noise, `uncorrelated` when they
 * vary but distance in the embedding does not predict them. */
function surfaceKind(
  data: LandscapeData,
): 'drawn' | 'flat' | 'uncorrelated' | 'insufficient' {
  if (data.grid !== null) return 'drawn'
  const reason = data.gridInsufficient ?? ''
  if (reason.includes('vary no more than their noise')) return 'flat'
  if (reason.includes('do not correlate with distance')) return 'uncorrelated'
  return 'insufficient'
}

/**
 * The plateau trigger, paired by seed: each seed runs `incumbent` and
 * `draftOnPlateau(incumbent)` on in-memory ledgers with everything else
 * equal. Reports, per arm, the kept node's true quality, the best true
 * quality registered, drafts, cells, and the landscape lens on the closed
 * ledger (plateau score and basin count on profile line edits); then the
 * paired differences, draft-on-plateau minus incumbent. Run it with and
 * without `--ceiling`: with a ceiling the root's lineage cannot pass it and a
 * draft's can climb 0.25 higher, so drafting is the only way up; without one
 * a draft is no better than the root's lineage, so the trigger's cost shows.
 */
export async function plateau(options: SimOptions, seeds: number) {
  interface ArmRow {
    kept: number
    best: number
    drafts: number
    cells: number
    nodes: number
    ledgerOk: boolean
    plateau: number | null
    plateauInsufficient: string | null
    basins: number | null
    surface: ReturnType<typeof surfaceKind>
    firedAt: number[]
  }
  const arms = ['incumbent', 'draft-on-plateau'] as const
  const rows: Array<{ seed: number } & Record<(typeof arms)[number], ArmRow>> = []
  for (let seed = options.seed; seed < options.seed + seeds; seed++) {
    const row = { seed } as { seed: number } & Record<(typeof arms)[number], ArmRow>
    for (const policy of arms) {
      const { result, summary, truth } = await runSimulation(
        `mem://search-sim/${seed}/${policy}`,
        { ...options, seed, policy },
        memoryStore(),
      )
      const lens = landscape(result.state, simTextEdits(truth))
      const drafts = summary.drafts as Array<{ evidence: Record<string, number> | null }>
      row[policy] = {
        kept: (summary.kept as { quality: number }).quality,
        best: summary.bestQuality as number,
        drafts: drafts.length,
        cells: result.state.audit.cells.allocated,
        nodes: result.state.audit.nodes,
        ledgerOk: (summary.ledgerChecks as { ok: boolean }).ok,
        plateau: lens.signal.value,
        plateauInsufficient: lens.signal.insufficient,
        basins: lens.data.basins.count,
        surface: surfaceKind(lens.data),
        firedAt: drafts.map((draft) => draft.evidence?.accepted ?? -1),
      }
    }
    rows.push(row)
  }
  const arm = (name: (typeof arms)[number]) => {
    const list = rows.map((row) => row[name])
    const mean = (values: readonly number[]) =>
      values.length === 0 ? null : round(values.reduce((sum, value) => sum + value, 0) / values.length)
    const basins: Record<string, number> = {}
    for (const entry of list) {
      const key = entry.basins === null ? 'insufficient' : String(entry.basins)
      basins[key] = (basins[key] ?? 0) + 1
    }
    const plateaus = list.flatMap((entry) => (entry.plateau === null ? [] : [entry.plateau]))
    return {
      meanKept: mean(list.map((entry) => entry.kept)),
      meanBest: mean(list.map((entry) => entry.best)),
      meanCells: mean(list.map((entry) => entry.cells)),
      meanNodes: mean(list.map((entry) => entry.nodes)),
      drafts: {
        total: list.reduce((sum, entry) => sum + entry.drafts, 0),
        searchesWithDraft: list.filter((entry) => entry.drafts > 0).length,
      },
      /** The landscape lens on each closed ledger. */
      finalPlateau: {
        measured: plateaus.length,
        belowOne: plateaus.filter((value) => value < 1).length,
        median: plateaus.length === 0 ? null : [...plateaus].sort((a, b) => a - b)[Math.floor(plateaus.length / 2)]!,
      },
      basins,
      surfaces: list.reduce<Record<string, number>>((counts, entry) => {
        counts[entry.surface] = (counts[entry.surface] ?? 0) + 1
        return counts
      }, {}),
      ledgerAuditsPassed: list.filter((entry) => entry.ledgerOk).length,
    }
  }
  return {
    ok: rows.every((row) => arms.every((name) => row[name].ledgerOk)),
    seeds: rows.length,
    design: {
      ceiling: options.ceiling,
      selection: options.selection,
      train: options.train,
      population: options.population,
      expansions: options.expansions,
      allocation: options.allocation,
    },
    incumbent: arm('incumbent'),
    draftOnPlateau: arm('draft-on-plateau'),
    /** Draft-on-plateau minus incumbent, paired by seed. */
    keptQuality: pairedReport(rows.map((row) => row['draft-on-plateau'].kept - row.incumbent.kept)),
    bestQuality: pairedReport(rows.map((row) => row['draft-on-plateau'].best - row.incumbent.best)),
    cells: pairedReport(
      rows.map((row) => row['draft-on-plateau'].cells - row.incumbent.cells),
      'lower',
    ),
    perSeed: rows.map((row) => ({
      seed: row.seed,
      incumbent: [row.incumbent.kept, row.incumbent.plateau, row.incumbent.basins],
      draftOnPlateau: [
        row['draft-on-plateau'].kept,
        row['draft-on-plateau'].drafts,
        row['draft-on-plateau'].firedAt,
        row['draft-on-plateau'].basins,
      ],
    })),
  }
}

/**
 * The landscape lens under the null: `--null` makes every node as good as the
 * root, so the landscape is flat and only cell noise varies. Runs one search
 * per seed and reports how many basins the lens counts (the method promises
 * one on at least 95% of flat landscapes), whether it drew a surface, and
 * the plateau score, which should read "on a plateau" when nothing improves.
 */
export async function lensNull(options: SimOptions, seeds: number) {
  if (!options.nullSteps) throw new Error('lens-null needs --null')
  const basins: Record<string, number> = {}
  const surfaces = { drawn: 0, flat: 0, uncorrelated: 0, insufficient: 0 }
  const plateaus: number[] = []
  let plateauInsufficient = 0
  let nodes = 0
  for (let seed = options.seed; seed < options.seed + seeds; seed++) {
    // A ceiling of 1 is inert for scores in [0, 1]; it gives every artifact
    // profile lines, so the lens measures line edits.
    const { result, truth } = await runSimulation(
      `mem://search-sim/${seed}/lens-null`,
      { ...options, seed, ceiling: options.ceiling ?? 1 },
      memoryStore(),
    )
    nodes += result.state.audit.nodes
    const lens = landscape(result.state, simTextEdits(truth))
    const key = lens.data.basins.count === null ? 'insufficient' : String(lens.data.basins.count)
    basins[key] = (basins[key] ?? 0) + 1
    surfaces[surfaceKind(lens.data)] += 1
    if (lens.signal.value === null) plateauInsufficient += 1
    else plateaus.push(lens.signal.value)
  }
  const oneBasin = basins['1'] ?? 0
  const counted = seeds - (basins.insufficient ?? 0)
  return {
    seeds,
    meanNodes: round(nodes / seeds),
    basins,
    oneBasin: { count: oneBasin, of: counted, wilson95: interval(wilson(oneBasin, counted, 0.95)) },
    surfaces,
    plateau: {
      measured: plateaus.length,
      insufficient: plateauInsufficient,
      belowOne: plateaus.filter((value) => value < 1).length,
      max: plateaus.length === 0 ? null : Math.max(...plateaus),
    },
  }
}

/**
 * Calibrate, then test adaptively. One `uniform` search over a pool
 * (`calibrationSeed`, the same task bank) measures every node on every unit;
 * `skillManifold` fits its unit loadings and `skillCalibration` keeps them.
 * Then, once per seed, the same pool search runs under `asha` and under
 * `asha-adaptive`, whose rungs add the units that best separate the leaders
 * on those loadings. Reports cells, the kept node's true quality, the regret
 * against the best node each search registered, and the ledger audits.
 */
export async function adaptive(options: SimOptions, seeds: number, calibrationSeed: number) {
  if (options.skills < 2 || options.poolGap === null) {
    throw new Error('adaptive needs --skills 2 or more and --pool-gap')
  }
  const calibrationRun = await runSimulation(
    `mem://search-sim/calibration/${calibrationSeed}`,
    { ...options, seed: calibrationSeed, allocation: 'uniform', policy: 'incumbent' },
    memoryStore(),
  )
  const lens = skillManifold(calibrationRun.result.state, 'auto')
  const calibration = skillCalibration(lens)
  const calibrationReport = {
    seed: calibrationSeed,
    nodes: lens.data.matrix.rows,
    units: lens.data.matrix.units,
    intrinsicDimension: lens.data.intrinsicDimension.value,
    curve: lens.data.intrinsicDimension.curve,
    rank: lens.data.model?.rank ?? null,
    noiseVariance: lens.data.noiseVariance,
  }
  if (calibration === null) {
    return { ok: false, calibration: calibrationReport, reason: lens.data.insufficient }
  }
  interface ArmRow {
    cells: number
    kept: string
    quality: number
    best: number
    planted: boolean
    ledgerOk: boolean
  }
  const rows: Array<{ seed: number; asha: ArmRow; adaptive: ArmRow }> = []
  for (let seed = options.seed; seed < options.seed + seeds; seed++) {
    const arms = {} as Record<'asha' | 'adaptive', ArmRow>
    for (const arm of ['asha', 'adaptive'] as const) {
      const { result, summary } = await runSimulation(
        `mem://search-sim/${seed}/${arm}`,
        {
          ...options,
          seed,
          allocation: arm === 'asha' ? 'asha' : 'asha-adaptive',
          calibration,
        },
        memoryStore(),
      )
      const kept = summary.kept as { name: string; quality: number; planted: boolean }
      arms[arm] = {
        cells: result.state.audit.cells.allocated,
        kept: kept.name,
        quality: kept.quality,
        best: summary.bestQuality as number,
        planted: kept.planted,
        ledgerOk: (summary.ledgerChecks as { ok: boolean }).ok,
      }
    }
    rows.push({ seed, ...arms })
  }
  const arm = (name: 'asha' | 'adaptive') => {
    const list = rows.map((row) => row[name])
    const keptBest = list.filter((row) => row.quality >= row.best - 1e-12).length
    return {
      cells: list.reduce((sum, row) => sum + row.cells, 0),
      keptBest: {
        count: keptBest,
        of: list.length,
        wilson95: interval(wilson(keptBest, list.length, 0.95)),
      },
      keptPlanted: list.filter((row) => row.planted).length,
      meanRegret: round(list.reduce((sum, row) => sum + (row.best - row.quality), 0) / list.length),
      meanKeptQuality: round(list.reduce((sum, row) => sum + row.quality, 0) / list.length),
      ledgerAuditsPassed: list.filter((row) => row.ledgerOk).length,
    }
  }
  const ashaArm = arm('asha')
  const adaptiveArm = arm('adaptive')
  const paired = rows.map((row) => row.adaptive.quality - row.asha.quality)
  return {
    ok: ashaArm.ledgerAuditsPassed === rows.length && adaptiveArm.ledgerAuditsPassed === rows.length,
    seeds: rows.length,
    design: {
      skills: options.skills,
      bankSeed: options.bankSeed,
      selection: options.selection,
      population: options.population,
      expansions: options.expansions,
      poolGap: options.poolGap,
      binary: options.binary,
    },
    calibration: { ...calibrationReport, source: calibration.source },
    asha: ashaArm,
    adaptive: adaptiveArm,
    /** Kept quality, adaptive minus asha, paired by seed. */
    keptQuality: pairedReport(paired),
    /** Cells allocated, adaptive minus asha, paired by seed. */
    cells: pairedReport(
      rows.map((row) => row.adaptive.cells - row.asha.cells),
      'lower',
    ),
    differing: rows
      .filter((row) => row.asha.kept !== row.adaptive.kept)
      .map((row) => ({
        seed: row.seed,
        best: row.asha.best,
        asha: { kept: row.asha.kept, quality: row.asha.quality, cells: row.asha.cells },
        adaptive: { kept: row.adaptive.kept, quality: row.adaptive.quality, cells: row.adaptive.cells },
      })),
  }
}
