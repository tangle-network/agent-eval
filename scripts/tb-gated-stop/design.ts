import { readFileSync } from 'node:fs'
import { clusteredPower, defineExperiment, type EvidenceRecord } from '../../src/experiment'
import { parseTaskOracleRegistry, stratumOf } from '../../src/trace-repair'
import { TASK_ORACLES_PATH, MODEL, STEP_ALLOTMENT, ROWS_PER_CLUSTER, ADMITTED_STRATA } from './settings'
import { type CorpusRow, loadCorpus, admissionRecord, canonicalTrialRowIds, endStateScreen, divergenceRatio } from './corpus'

// ── The registered design ────────────────────────────────────────────

/**
 * The effect grid the power gate is judged on.
 *
 * These are the per-row net win rates the reallocation mechanism can plausibly
 * produce: the freed budget is bounded by how often a row clears the check
 * early, and one extra step on a row that eight did not fix is not a coin
 * flip. A grid that reached 0.5 would let the gate pass on an effect nothing
 * in this mechanism can generate, which is the failure the gate exists to stop.
 */
export const REGISTERED_EFFECT_GRID = [0.05, 0.1, 0.15, 0.2]

export const POWER_TARGET = 0.8

export const POWER_SIM = { trials: 3000, resamples: 3000, seed: 20260814 }

/**
 * The effect the confirmatory draw is sized against.
 *
 * 0.05 is below what this mechanism can generate and 0.15 would buy a draw too
 * small to read a plausible effect, so the grid's second point is the one the
 * row count is chosen on.
 */
export const SETTLING_EFFECT = 0.1

/**
 * Trials for the settling search only.
 *
 * The registered gate is judged at `POWER_SIM`. Choosing the row count on that
 * many trials would pick a draw whose margin over the target is Monte Carlo
 * luck: at 3000 trials the standard error near 0.8 is about 0.007, which is
 * wider than the gap between adjacent draws. The search runs hotter, and the
 * chosen draw is then re-checked at the registered parameters.
 */
const SETTLING_TRIALS = 15_000

/**
 * Rows each cluster contributes when the registered round-robin takes `take`.
 *
 * The selection cycles tasks in lexical order and takes one row per pass, so
 * the structure a smaller draw carries follows from the registered rule rather
 * than from a second rule invented for the search.
 */
function roundRobinSizes(
  clusters: readonly { taskName: string; rowIds: readonly string[] }[],
  take: number,
): number[] {
  const ordered = [...clusters].sort((a, b) => a.taskName.localeCompare(b.taskName))
  const counts = new Map<string, number>()
  let taken = 0
  for (let pass = 0; taken < take; pass += 1) {
    let progressed = false
    for (const cluster of ordered) {
      if (taken >= take) break
      if (pass >= cluster.rowIds.length) continue
      counts.set(cluster.taskName, (counts.get(cluster.taskName) ?? 0) + 1)
      taken += 1
      progressed = true
    }
    if (!progressed) break
  }
  return [...counts.values()]
}

function powerAt(sizes: readonly number[], effect: number, trials: number): number {
  return clusteredPower({
    clusterSizes: [...sizes],
    effects: [effect],
    minimumEffect: effect,
    seed: POWER_SIM.seed,
    trials,
    resamples: POWER_SIM.resamples,
    targetPower: POWER_TARGET,
    baseWinRate: 0.05,
    baseLossRate: 0.05,
  }).curve[0]!.power
}

export interface SettlingDraw {
  effect: number
  target: number
  trials: number
  /** Smallest draw whose power clears the target at `effect`. */
  rows: number
  power: number
  /** The same draw re-checked at the registered gate's simulation parameters. */
  powerAtRegisteredSim: number
  /** The largest draw searched, and its power — the ceiling the corpus offers. */
  maxRows: number
  maxPower: number
  /** Every draw the search evaluated, so the curve is auditable. */
  scanned: { rows: number; power: number; registered: number | null }[]
}

/**
 * The smallest confirmatory draw that clears the power target.
 *
 * Taking every admitted row spends rows the design does not need. The search
 * walks the draw upward and returns the first that clears, so the run buys the
 * power the design registered and nothing beyond it.
 */
export function settlingDraw(
  clusters: readonly { taskName: string; rowIds: readonly string[] }[],
  maxTake: number,
): SettlingDraw {
  const clusterCount = clusters.length
  const scanned: { rows: number; power: number; registered: number | null }[] = []
  const evaluate = (rows: number): number => {
    const found = scanned.find((point) => point.rows === rows)
    if (found !== undefined) return found.power
    const power = powerAt(roundRobinSizes(clusters, rows), SETTLING_EFFECT, SETTLING_TRIALS)
    scanned.push({ rows, power, registered: null })
    return power
  }
  /**
   * The registered gate re-check.
   *
   * The search runs hotter than the gate, so near the floor the two estimates
   * straddle the target. A draw chosen only on the hotter estimate would carry
   * a gate that reads below the floor on the same draw, so a draw must clear
   * the target under both before it is chosen.
   */
  const registeredCheck = (rows: number): number => {
    const point = scanned.find((entry) => entry.rows === rows)!
    if (point.registered === null) {
      point.registered = powerAt(roundRobinSizes(clusters, rows), SETTLING_EFFECT, POWER_SIM.trials)
    }
    return point.registered
  }
  const clears = (rows: number): boolean =>
    evaluate(rows) >= POWER_TARGET && registeredCheck(rows) >= POWER_TARGET
  // Bracket on a coarse grid, then refine by one row at a time.
  let bracket = maxTake
  for (let rows = clusterCount; rows <= maxTake; rows += clusterCount) {
    if (clears(rows)) {
      bracket = rows
      break
    }
  }
  let chosen = bracket
  for (let rows = Math.max(clusterCount, bracket - clusterCount + 1); rows <= bracket; rows += 1) {
    if (clears(rows)) {
      chosen = rows
      break
    }
  }
  scanned.sort((a, b) => a.rows - b.rows)
  return {
    effect: SETTLING_EFFECT,
    target: POWER_TARGET,
    trials: SETTLING_TRIALS,
    rows: chosen,
    power: evaluate(chosen),
    powerAtRegisteredSim: registeredCheck(chosen),
    maxRows: maxTake,
    maxPower: evaluate(maxTake),
    scanned,
  }
}

export function buildSpec(certifiedTasks: string[], sealedRowIds: string[], take: number, pilotExposed: string[]) {
  return defineExperiment({
    id: 'gated-stop-vs-blind-continue-tb-repair-v1',
    hypothesis:
      'At one matched realized-token budget, an agent that may stop only after an executable ' +
      'held-out check passes finishes more rows than the same agent spending the identical ' +
      'budget on unconditional continuation. The mechanism is budget allocation: budget freed ' +
      'by an early clear pays for extra steps on rows that have not cleared.',
    arms: [
      {
        id: 'blind-continue',
        role: 'control',
        pins: {
          model: MODEL,
          stepAllotment: STEP_ALLOTMENT,
          stopRule: 'spend-the-allotment-unconditionally',
          gradedAt: 'best-intermediate-state',
          temperature: 0,
          scaffold: 'mini-swe-agent',
        },
      },
      {
        id: 'gated-continue',
        role: 'treatment',
        pins: {
          model: MODEL,
          stepAllotment: STEP_ALLOTMENT,
          stopRule: 'stop-when-held-out-check-passes',
          reallocation: 'unspent-budget-to-rows-still-failing',
          gradedAt: 'best-intermediate-state',
          temperature: 0,
          scaffold: 'mini-swe-agent',
        },
      },
    ],
    outcome: {
      kind: 'binary',
      source: 'injected-suite',
      digestVerified: true,
      pass: 'reward-file-contains-1',
      droppedRollouts: 'forbidden',
    },
    admission: {
      population:
        'terminalbench-trajectories, mini-swe-agent rows with reward 0, on tasks whose oracle certification is checked in',
      stages: [
        {
          id: 'certified-deterministic-oracle',
          keep: { kind: 'in', field: 'taskName', values: [...certifiedTasks] },
        },
        {
          id: 'replayable-commands-and-final-returncode',
          keep: {
            kind: 'all',
            of: [
              { kind: 'compare', field: 'placeholderCommands', op: 'eq', value: 0 },
              { kind: 'compare', field: 'finalReturncodeKnown', op: 'eq', value: true },
            ],
          },
        },
        {
          id: 'stratum-carries-a-repairable-failure',
          keep: { kind: 'in', field: 'stratum', values: ['clean-exit', 'command-error'] },
        },
        {
          id: 'unknown-returncode-ratio-at-most-25pct',
          keep: { kind: 'compare', field: 'unknownRatio', op: 'lte', value: 0.25 },
        },
        {
          id: 'recorded-commands-at-most-25',
          keep: { kind: 'compare', field: 'recordedCommands', op: 'lte', value: 25 },
        },
        {
          // A pinned digest is a fact of the repository. Whether that image sits
          // in one machine's docker store is a fact of the machine, and a funnel
          // gated on it reports a different denominator after an eviction. The
          // pull is a prerequisite of execution, and a row nothing executed on
          // leaves at the end-state stage as unscreened.
          id: 'image-pinned-by-digest',
          keep: { kind: 'compare', field: 'imagePinned', op: 'eq', value: true },
        },
        {
          id: 'one-row-per-recorded-trial',
          keep: { kind: 'compare', field: 'canonicalTrialRow', op: 'eq', value: true },
        },
        {
          id: 'recorded-end-state-fails-its-own-suite',
          keep: { kind: 'compare', field: 'recordedEndStateFails', op: 'eq', value: true },
        },
        {
          id: 'prefix-divergence-at-most-10pct',
          keep: { kind: 'compare', field: 'prefixDivergenceRatio', op: 'lte', value: 0.1 },
        },
        {
          id: 'not-exposed-by-the-mechanism-pilot',
          keep: { kind: 'not', of: { kind: 'in', field: 'rowId', values: [...pilotExposed] } },
        },
        {
          id: 'task-carries-at-least-two-rows',
          keep: { kind: 'compare', field: 'clusterSize', op: 'gte', value: ROWS_PER_CLUSTER },
        },
      ],
    },
    selections: {
      confirmatory: {
        kind: 'round-robin',
        groupBy: 'taskName',
        groupOrder: 'lex-asc',
        withinOrder: { field: 'rowId', dir: 'asc' },
        take,
        reads: ['taskName', 'rowId'],
      },
    },
    estimands: {
      pairedContrast: {
        kind: 'paired-mean-diff',
        armField: 'arm',
        treatment: 'gated-continue',
        control: 'blind-continue',
        pairBy: 'rowId',
        value: 'passed',
        missing: 'zero-diff',
      },
    },
    intervals: {
      pairedContrast95: {
        kind: 'cluster-bootstrap',
        clusterBy: 'taskName',
        value: 'diff',
        resamples: 10_000,
        seed: 20260814,
        level: 0.95,
        method: 'percentile',
      },
    },
    gates: {
      powerFloor: {
        kind: 'power-floor',
        target: POWER_TARGET,
        minimumEffect: SETTLING_EFFECT,
        effectGrid: [...REGISTERED_EFFECT_GRID],
        sim: { ...POWER_SIM },
      },
      servedModel: { kind: 'identity', field: 'served-model', op: 'basename-eq', onFail: 'abort' },
    },
    halt: {
      when: { kind: 'any-gate-failed', gates: ['powerFloor'] },
      action: 'refuse-spend',
      report: 'settling-n',
    },
    matchedBudget: {
      measure: 'realized-tokens',
      tolerance: 0.05,
      onFail: 'refuse-contrast',
    },
    decision: {
      kind: 'table',
      branches: [
        {
          when: {
            kind: 'all',
            of: [
              { kind: 'interval-excludes-zero', interval: 'pairedContrast95', sign: 'positive' },
              { kind: 'obligation-met', obligation: 'matched-realized-tokens' },
            ],
          },
          verdict: 'gated-stop-survives',
          report: ['pairedContrast', 'pairedContrast95'],
        },
        {
          when: {
            kind: 'all',
            of: [
              { kind: 'interval-excludes-zero', interval: 'pairedContrast95', sign: 'negative' },
              { kind: 'obligation-met', obligation: 'matched-realized-tokens' },
            ],
          },
          verdict: 'gated-stop-dies',
          report: ['pairedContrast', 'pairedContrast95'],
        },
        {
          when: { kind: 'interval-includes-zero', interval: 'pairedContrast95' },
          verdict: 'no-effect-resolved-at-this-n',
          report: ['pairedContrast', 'pairedContrast95'],
        },
        {
          when: { kind: 'not', of: { kind: 'obligation-met', obligation: 'matched-realized-tokens' } },
          verdict: 'contrast-refused-unmatched-budget',
          report: ['pairedContrast95'],
        },
      ],
    },
    sealedSubsets: { confirmatoryRows: sealedRowIds },
    seedDerivation: { from: ['seed', 'rowId', 'rolloutIndex'] },
    seed: 20260814,
    obligations: [
      {
        id: 'matched-realized-tokens',
        appliesToVerdicts: ['gated-stop-survives', 'gated-stop-dies'],
        control:
          'realized prompt+completion tokens agree within 5 % between arms, verified by the registered matched-budget rule',
      },
    ],
  })
}

// ── Design ───────────────────────────────────────────────────────────

interface Design {
  certifiedTasks: string[]
  records: EvidenceRecord[]
  clusters: { taskName: string; rowIds: string[] }[]
  rows: CorpusRow[]
  take: number
}

/**
 * Rows and their cluster structure, prepared for the sealed admission rule.
 *
 * Nothing here decides admission: the predicates live in the spec and run
 * through `openSealedExperiment().admit`, so the funnel a report prints is the
 * funnel the seal registered.
 */
export function prepare(assumeScreened: boolean): Design {
  const corpus = loadCorpus()
  const registry = parseTaskOracleRegistry(JSON.parse(readFileSync(TASK_ORACLES_PATH, 'utf8')))
  const certifiedTasks = [...registry.values()]
    .filter((verdict) => verdict.stable)
    .map((verdict) => verdict.taskName)
    .sort()

  // Rows that would survive the row-level predicates, counted per task, so the
  // cluster-size field the last stage reads is a property of the population.
  const canonical = canonicalTrialRowIds(corpus)
  const screen = endStateScreen()
  // Every stage above the cluster count, including the end-state screen. A
  // task whose second row the screen removes is not a cluster of two, and a
  // cluster of one carries no paired contrast for the bootstrap to resample.
  const eligible = corpus.filter(
    (row) =>
      certifiedTasks.includes(row.taskName) &&
      row.placeholderCommands === 0 &&
      row.finalReturncode !== null &&
      row.unknownRatio <= 0.25 &&
      row.recordedCommands <= 25 &&
      row.imagePinned &&
      ADMITTED_STRATA.includes(stratumOf(row.finalReturncode) ?? 'unreadable') &&
      canonical.has(row.rowId) &&
      (assumeScreened || screen[row.rowId]?.endStatePassed === false) &&
      (assumeScreened || divergenceRatio(screen[row.rowId]) <= 0.1),
  )
  const sizes = new Map<string, number>()
  for (const row of eligible) sizes.set(row.taskName, (sizes.get(row.taskName) ?? 0) + 1)
  const records = corpus.map((row) =>
    admissionRecord(
      row,
      sizes.get(row.taskName) ?? 0,
      assumeScreened ? true : screen[row.rowId]?.endStatePassed === false,
      canonical.has(row.rowId),
      assumeScreened ? 0 : divergenceRatio(screen[row.rowId]),
    ),
  )
  const clusterRows = [...sizes.values()].filter((n) => n >= ROWS_PER_CLUSTER)
  return {
    certifiedTasks,
    records,
    clusters: [],
    rows: corpus,
    take: clusterRows.reduce((total, n) => total + n, 0),
  }
}
