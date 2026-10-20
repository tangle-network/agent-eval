/** Training-legal pool loading and committed spent-split identity checks. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { AnalystIssueExpectation } from '../../src/analyst/benchmark'
import { codeTraceBenchCase, type CodeTraceBenchRow } from '../../src/analyst/benchmark-datasets'
import {
  loadPublicBenchmarkRows,
  preparePublicAnalystBenchmark,
} from '../../src/analyst/benchmark-public-data'
import { sha256Digest } from '../../src/analyst/benchmark-verification-artifacts'
import { mulberry32 } from '../../src/statistics/random'
import type { TraceAnalysisStore } from '../../src/trace-analyst/store'
import {
  SMOKE,
  PLAN_ONLY,
  FAMILY,
  RUN_DIR,
  ROUND,
  SEED,
  POOLS,
  FAMILY_POOLS,
  FAMILY_TRAIN_PER_FAMILY,
  FAMILY_SELECTION_PER_FAMILY,
  FAMILY_SPLIT_PLAN_PATH,
  WIDE_MIN_BLOCK_WIDTH,
  SELECTION_TOTAL,
} from './configuration'
import type { GepaAnalystScenario, PoolProvenance } from './contract'

const storesById = new Map<string, TraceAnalysisStore>()

function seededShuffle<T>(items: readonly T[], seed: number): T[] {
  const next = mulberry32(seed)
  const out = [...items]
  for (let index = out.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(next() * (index + 1))
    ;[out[index], out[swap]] = [out[swap]!, out[index]!]
  }
  return out
}

function goldBlockWidths(expectedIssues: readonly AnalystIssueExpectation[]): number[] {
  const steps = expectedIssues
    .map((issue) => Number.parseInt(issue.id.slice(issue.id.lastIndexOf(':') + 1), 10))
    .filter((value) => Number.isSafeInteger(value) && value > 0)
    .sort((a, b) => a - b)
  if (steps.length === 0) return [0]
  const widths: number[] = []
  let run = 1
  for (let index = 1; index <= steps.length; index += 1) {
    if (index < steps.length && steps[index] === steps[index - 1]! + 1) run += 1
    else {
      widths.push(run)
      run = 1
    }
  }
  return widths
}

interface FamilyPlanRow {
  trajId: string
  family: string
  goldMass: number
  maxBlockWidth: number
  stratum: 'wide' | 'narrow'
}

interface FamilyPoolSplit {
  name: string
  labelsPath: string
  labelsSha256: string
  durableLabelsPath: string
  rowCount: number
  positiveCount: number
  train: FamilyPlanRow[]
  selection: FamilyPlanRow[]
  rowsByTrajId: Map<string, Record<string, unknown>>
}

async function computeFamilySplit(): Promise<FamilyPoolSplit[]> {
  const pools: FamilyPoolSplit[] = []
  for (const [poolIndex, pool] of FAMILY_POOLS.entries()) {
    const labelsSha256 = sha256Digest(readFileSync(pool.labelsPath, 'utf8'))
    const rows = await loadPublicBenchmarkRows(pool.labelsPath)
    const rowsByTrajId = new Map<string, Record<string, unknown>>()
    const positives: FamilyPlanRow[] = []
    for (const row of rows) {
      const benchmarkCase = codeTraceBenchCase(row as unknown as CodeTraceBenchRow, undefined)
      const trajId = String(row.traj_id)
      rowsByTrajId.set(trajId, row)
      if (benchmarkCase.labelState !== 'positive') continue
      const maxBlockWidth = Math.max(...goldBlockWidths(benchmarkCase.expectedIssues))
      positives.push({
        trajId,
        family: pool.name,
        goldMass: benchmarkCase.expectedIssues.length,
        maxBlockWidth,
        stratum: maxBlockWidth >= WIDE_MIN_BLOCK_WIDTH ? 'wide' : 'narrow',
      })
    }
    const needed = FAMILY_TRAIN_PER_FAMILY + FAMILY_SELECTION_PER_FAMILY
    if (positives.length < needed) {
      throw new Error(
        `family pool '${pool.name}' has ${positives.length} labeled-positive rows; need ${needed}`,
      )
    }
    positives.sort((left, right) => left.trajId.localeCompare(right.trajId))
    const shuffled = seededShuffle(positives, SEED + poolIndex)
    pools.push({
      name: pool.name,
      labelsPath: pool.labelsPath,
      labelsSha256,
      durableLabelsPath: pool.durableLabelsPath,
      rowCount: rows.length,
      positiveCount: positives.length,
      selection: shuffled.slice(0, FAMILY_SELECTION_PER_FAMILY),
      train: shuffled.slice(
        FAMILY_SELECTION_PER_FAMILY,
        FAMILY_SELECTION_PER_FAMILY + FAMILY_TRAIN_PER_FAMILY,
      ),
      rowsByTrajId,
    })
  }
  return pools
}

function familySplitPlanDocument(pools: readonly FamilyPoolSplit[]): Record<string, unknown> {
  return {
    kind: 'agent-eval/gepa-analyst-family-split-plan',
    round: ROUND,
    scenarioFamily: 'oht2',
    seed: SEED,
    metric:
      'plain per-case judge composite (f1 averaged with critical-step accuracy when defined); no gold-mass weighting',
    spent:
      'Every traj_id under train and selection is GEPA-SPENT: certification splits must exclude these rows.',
    trainPerFamily: FAMILY_TRAIN_PER_FAMILY,
    selectionPerFamily: FAMILY_SELECTION_PER_FAMILY,
    pools: pools.map((pool) => ({
      name: pool.name,
      labelsPath: pool.labelsPath,
      labelsSha256: pool.labelsSha256,
      durableLabelsPath: pool.durableLabelsPath,
      rowCount: pool.rowCount,
      positiveCount: pool.positiveCount,
    })),
    train: pools.flatMap((pool) => pool.train),
    selection: pools.flatMap((pool) => pool.selection),
  }
}

/** The identity of a split: seed, source label digests, exact traj_id order. */
function familySplitProjection(plan: Record<string, unknown>): string {
  const pools = (plan.pools as Array<Record<string, unknown>>).map((pool) => ({
    name: pool.name,
    labelsSha256: pool.labelsSha256,
  }))
  const ids = (rows: unknown) =>
    (rows as Array<Record<string, unknown>>).map((row) => `${row.family}:${row.trajId}`)
  return JSON.stringify({
    seed: plan.seed,
    trainPerFamily: plan.trainPerFamily,
    selectionPerFamily: plan.selectionPerFamily,
    pools,
    train: ids(plan.train),
    selection: ids(plan.selection),
  })
}

function verifyCommittedFamilySplitPlan(computed: Record<string, unknown>): void {
  if (!existsSync(FAMILY_SPLIT_PLAN_PATH)) {
    throw new Error(
      `committed family split plan is missing at ${FAMILY_SPLIT_PLAN_PATH} — ` +
        'run --scenario-family oht2 --plan and commit the result before spending',
    )
  }
  const committed = JSON.parse(readFileSync(FAMILY_SPLIT_PLAN_PATH, 'utf8')) as Record<
    string,
    unknown
  >
  if (familySplitProjection(committed) !== familySplitProjection(computed)) {
    throw new Error(
      `family split drifted from the committed plan at ${FAMILY_SPLIT_PLAN_PATH} — ` +
        'the labels, seed, or split constants changed; regenerate with --plan and re-commit deliberately',
    )
  }
}

export async function prepareCampaignScenarios(): Promise<PreparedCampaignScenarios | undefined> {
  const scenarios: GepaAnalystScenario[] = []
  const poolProvenance: PoolProvenance[] = []
  let trainScenarios: GepaAnalystScenario[]
  let selectionScenarios: GepaAnalystScenario[]
  let stratification: Record<string, unknown>
  let maxGoldMass: number

  if (FAMILY) {
    const split = await computeFamilySplit()
    const planDocument = familySplitPlanDocument(split)
    if (PLAN_ONLY) {
      mkdirSync(dirname(FAMILY_SPLIT_PLAN_PATH), { recursive: true })
      writeFileSync(FAMILY_SPLIT_PLAN_PATH, `${JSON.stringify(planDocument, null, 2)}\n`)
      writeFileSync(join(RUN_DIR, 'split-plan.json'), `${JSON.stringify(planDocument, null, 2)}\n`)
      console.log(`[gepa-analyst-r${ROUND}] plan-only: wrote ${FAMILY_SPLIT_PLAN_PATH}`)
      return
    }
    verifyCommittedFamilySplitPlan(planDocument)
    writeFileSync(join(RUN_DIR, 'split-plan.json'), `${JSON.stringify(planDocument, null, 2)}\n`)

    // Smoke touches one train + one selection row from openhands and one train
    // row from terminus2 — 3 scenarios, both families, both split roles.
    // Zero-finding runs concentrate on solved trajectories on these families,
    // so the smoke prefers unsolved rows: it must demonstrate the nonzero-score
    // path, not just the plumbing.
    const preferUnsolved = (pool: FamilyPoolSplit, rows: readonly FamilyPlanRow[]) => {
      const unsolved = rows.find(
        (row) => pool.rowsByTrajId.get(row.trajId)?.solved === false,
      )
      return unsolved ?? rows[0]!
    }
    const activeByPool = new Map<string, { train: FamilyPlanRow[]; selection: FamilyPlanRow[] }>(
      split.map((pool) => [
        pool.name,
        SMOKE
          ? {
              train: [preferUnsolved(pool, pool.train)],
              selection: pool.name === 'openhands' ? [preferUnsolved(pool, pool.selection)] : [],
            }
          : { train: [...pool.train], selection: [...pool.selection] },
      ]),
    )

    const scenarioByTrajId = new Map<string, GepaAnalystScenario>()
    for (const pool of split) {
      const active = activeByPool.get(pool.name)!
      const activeRows = [...active.train, ...active.selection]
      if (activeRows.length === 0) continue
      const filteredLabelsPath = join(RUN_DIR, 'pool-labels', `${pool.name}.json`)
      mkdirSync(dirname(filteredLabelsPath), { recursive: true })
      writeFileSync(
        filteredLabelsPath,
        `${JSON.stringify(
          activeRows.map((row) => {
            const source = pool.rowsByTrajId.get(row.trajId)
            if (!source) throw new Error(`family pool '${pool.name}' lost row '${row.trajId}'`)
            return source
          }),
          null,
          2,
        )}\n`,
      )
      const poolConfig = FAMILY_POOLS.find((candidate) => candidate.name === pool.name)!
      const prepared = await preparePublicAnalystBenchmark({
        dataset: 'codetracebench',
        labelsPath: filteredLabelsPath,
        traceDir: poolConfig.traceDir,
        artifactDir: poolConfig.artifactDir,
        limit: activeRows.length,
        seed: 0,
      })
      if (prepared.cases.length !== activeRows.length) {
        throw new Error(
          `family pool '${pool.name}' prepared ${prepared.cases.length} cases for ${activeRows.length} rows`,
        )
      }
      poolProvenance.push({
        name: pool.name,
        labelsPath: pool.labelsPath,
        labelsSha256: pool.labelsSha256,
        filteredLabelsPath,
        filteredLabelsSha256: prepared.labelsSha256,
      })
      for (const benchmarkCase of prepared.cases) {
        if (benchmarkCase.labelState !== 'positive') {
          throw new Error(`family case '${benchmarkCase.id}' is not labeled positive`)
        }
        if (!benchmarkCase.input.traceStore) {
          throw new Error(`prepared case '${benchmarkCase.id}' has no trace store`)
        }
        if (storesById.has(benchmarkCase.id)) {
          throw new Error(`scenario '${benchmarkCase.id}' appears in more than one pool`)
        }
        storesById.set(benchmarkCase.id, benchmarkCase.input.traceStore)
        const trajId = benchmarkCase.id.replace(/^codetrace:/, '')
        const planRow = activeRows.find((row) => row.trajId === trajId)
        if (!planRow) throw new Error(`prepared case '${benchmarkCase.id}' is not in the split plan`)
        const scenario: GepaAnalystScenario = {
          id: benchmarkCase.id,
          kind: 'trace-analyst',
          labelState: 'positive',
          pool: pool.name,
          trajectoryId: trajId,
          expectedIssues: [...benchmarkCase.expectedIssues],
          ...(benchmarkCase.labeledEvidence
            ? { labeledEvidence: [...benchmarkCase.labeledEvidence] }
            : {}),
          goldMass: planRow.goldMass,
          maxBlockWidth: planRow.maxBlockWidth,
          stratum: planRow.stratum,
        }
        scenarios.push(scenario)
        scenarioByTrajId.set(trajId, scenario)
      }
    }
    const resolveScenarios = (rows: readonly FamilyPlanRow[]) =>
      rows.map((row) => {
        const scenario = scenarioByTrajId.get(row.trajId)
        if (!scenario) throw new Error(`no prepared scenario for planned row '${row.trajId}'`)
        return scenario
      })
    const plannedTrain = split.flatMap((pool) => activeByPool.get(pool.name)!.train)
    const plannedSelection = split.flatMap((pool) => activeByPool.get(pool.name)!.selection)
    trainScenarios = SMOKE
      ? resolveScenarios(plannedTrain)
      : seededShuffle(resolveScenarios(plannedTrain), SEED + 2)
    selectionScenarios = SMOKE
      ? resolveScenarios(plannedSelection)
      : seededShuffle(resolveScenarios(plannedSelection), SEED + 3)
    maxGoldMass = Math.max(...scenarios.map((scenario) => scenario.goldMass))
    const describeFamilySplit = (splitScenarios: readonly GepaAnalystScenario[]) => ({
      n: splitScenarios.length,
      wide: splitScenarios.filter((scenario) => scenario.stratum === 'wide').length,
      narrow: splitScenarios.filter((scenario) => scenario.stratum === 'narrow').length,
      byFamily: Object.fromEntries(
        split.map((pool) => [
          pool.name,
          splitScenarios.filter((scenario) => scenario.pool === pool.name).length,
        ]),
      ),
      goldMass: splitScenarios.reduce((total, scenario) => total + scenario.goldMass, 0),
    })
    stratification = {
      scheme: 'per-family seeded sample over labeled-positive rows',
      trainPerFamily: FAMILY_TRAIN_PER_FAMILY,
      selectionPerFamily: FAMILY_SELECTION_PER_FAMILY,
      pools: split.map((pool) => ({
        name: pool.name,
        rowCount: pool.rowCount,
        positiveCount: pool.positiveCount,
      })),
      train: describeFamilySplit(trainScenarios),
      selection: describeFamilySplit(selectionScenarios),
    }
  } else {
    for (const pool of POOLS) {
      const prepared = await preparePublicAnalystBenchmark({
        dataset: 'codetracebench',
        labelsPath: pool.labelsPath,
        traceDir: pool.traceDir,
        artifactDir: pool.artifactDir,
        limit: 32,
        seed: 0,
      })
      poolProvenance.push({
        name: pool.name,
        labelsPath: pool.labelsPath,
        labelsSha256: sha256Digest(readFileSync(pool.labelsPath, 'utf8')),
      })
      for (const benchmarkCase of prepared.cases) {
        if (benchmarkCase.labelState !== 'positive') continue
        if (!benchmarkCase.input.traceStore) {
          throw new Error(`prepared case '${benchmarkCase.id}' has no trace store`)
        }
        if (storesById.has(benchmarkCase.id)) {
          throw new Error(`scenario '${benchmarkCase.id}' appears in more than one pool`)
        }
        storesById.set(benchmarkCase.id, benchmarkCase.input.traceStore)
        const widths = goldBlockWidths(benchmarkCase.expectedIssues)
        const maxBlockWidth = Math.max(...widths)
        scenarios.push({
          id: benchmarkCase.id,
          kind: 'trace-analyst',
          labelState: 'positive',
          pool: pool.name,
          trajectoryId: benchmarkCase.id.replace(/^codetrace:/, ''),
          expectedIssues: [...benchmarkCase.expectedIssues],
          ...(benchmarkCase.labeledEvidence
            ? { labeledEvidence: [...benchmarkCase.labeledEvidence] }
            : {}),
          goldMass: benchmarkCase.expectedIssues.length,
          maxBlockWidth,
          stratum: maxBlockWidth >= WIDE_MIN_BLOCK_WIDTH ? 'wide' : 'narrow',
        })
      }
    }
    if (scenarios.length !== 32) {
      throw new Error(
        `expected 32 labeled-positive scenarios across pools, found ${scenarios.length}`,
      )
    }
    maxGoldMass = Math.max(...scenarios.map((scenario) => scenario.goldMass))

    const wide = seededShuffle(
      scenarios.filter((scenario) => scenario.stratum === 'wide'),
      SEED,
    )
    const narrow = seededShuffle(
      scenarios.filter((scenario) => scenario.stratum === 'narrow'),
      SEED + 1,
    )
    const selectionWide = Math.min(
      wide.length,
      Math.max(1, Math.round((SELECTION_TOTAL * wide.length) / scenarios.length)),
    )
    const selectionNarrow = SELECTION_TOTAL - selectionWide
    const fullSelection = [...wide.slice(0, selectionWide), ...narrow.slice(0, selectionNarrow)]
    const fullTrain = [...wide.slice(selectionWide), ...narrow.slice(selectionNarrow)]
    trainScenarios = SMOKE
      ? [wide[selectionWide]!, narrow[selectionNarrow]!]
      : seededShuffle(fullTrain, SEED + 2)
    selectionScenarios = SMOKE ? [fullSelection[0]!] : seededShuffle(fullSelection, SEED + 3)
    const describeSplit = (split: readonly GepaAnalystScenario[]) => ({
      n: split.length,
      wide: split.filter((scenario) => scenario.stratum === 'wide').length,
      narrow: split.filter((scenario) => scenario.stratum === 'narrow').length,
      dev32: split.filter((scenario) => scenario.pool === 'dev32').length,
      holdout1: split.filter((scenario) => scenario.pool === 'holdout1').length,
      goldMass: split.reduce((total, scenario) => total + scenario.goldMass, 0),
    })
    stratification = {
      wideMinBlockWidth: WIDE_MIN_BLOCK_WIDTH,
      pool: describeSplit(scenarios),
      train: describeSplit(trainScenarios),
      selection: describeSplit(selectionScenarios),
      maxGoldMass,
    }

    if (PLAN_ONLY) {
      const plan = {
        kind: 'agent-eval/gepa-analyst-campaign-plan',
        round: ROUND,
        seed: SEED,
        pools: poolProvenance,
        stratification,
        trainScenarios: trainScenarios.map((scenario) => ({
          id: scenario.id,
          pool: scenario.pool,
          stratum: scenario.stratum,
          goldMass: scenario.goldMass,
          maxBlockWidth: scenario.maxBlockWidth,
        })),
        selectionScenarios: selectionScenarios.map((scenario) => ({
          id: scenario.id,
          pool: scenario.pool,
          stratum: scenario.stratum,
          goldMass: scenario.goldMass,
          maxBlockWidth: scenario.maxBlockWidth,
        })),
        weighting: {
          scheme: 'goldMass / maxGoldMass over the full 32-scenario pool',
          maxGoldMass,
        },
      }
      writeFileSync(join(RUN_DIR, 'split-plan.json'), `${JSON.stringify(plan, null, 2)}\n`)
      console.log(`[gepa-analyst-r${ROUND}] plan-only: wrote ${join(RUN_DIR, 'split-plan.json')}`)
      return
    }
  }
  console.log(`[gepa-analyst-r${ROUND}] stratification ${JSON.stringify(stratification)}`)
  return { scenarios, poolProvenance, trainScenarios, selectionScenarios, stratification, maxGoldMass, storesById }
}

export interface PreparedCampaignScenarios {
  scenarios: GepaAnalystScenario[]
  poolProvenance: PoolProvenance[]
  trainScenarios: GepaAnalystScenario[]
  selectionScenarios: GepaAnalystScenario[]
  stratification: Record<string, unknown>
  maxGoldMass: number
  storesById: Map<string, TraceAnalysisStore>
}
