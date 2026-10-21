/** Aggregate supervisor reports while retaining missing-measurement denominators. */
import { roundDecimal as round } from '../math/round-decimal'
import type { Measured, RollupCellRow, SupervisorRunReport, SupervisorRunRollup } from './types'
import { isUnavailable, SUPERVISOR_RUN_ROLLUP_SCHEMA, unavailable } from './types'

/**
 * Aggregate many supervisor-run reports. A metric no run could measure stays
 * `unavailable` rather than becoming a 0-valued mean, and cells whose steer
 * count was unavailable are counted separately from cells that measured zero.
 */
export function rollupSupervisorRuns(reports: readonly SupervisorRunReport[]): SupervisorRunRollup {
  const known = <T>(vals: readonly Measured<T>[]): T[] =>
    vals.filter((v): v is T => !isUnavailable(v))
  const steerVals = known(reports.map((r) => r.orchestration.steers))
  const waveVals = known(reports.map((r) => r.orchestration.waves))
  const concVals = known(reports.map((r) => r.orchestration.maxConcurrency))
  const utilVals = known(reports.map((r) => r.orchestration.workerUtilization))
  const idleVals = known(reports.map((r) => r.orchestration.idlePct))
  const spawnVals = known(reports.map((r) => r.orchestration.workersSpawned))
  const acceptVals = known(reports.map((r) => r.decision.accepted))
  const usdVals = known(reports.map((r) => r.economics.totalUsd))
  const journalSpendVals = known(reports.map((r) => r.economics.spend.journalDerived.usd))
  const closeSpendVals = known(reports.map((r) => r.economics.spend.closeRecord.usd))
  const resolvedVals = known(reports.map((r) => r.outcome.judgeResolved))
  const sum = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0)
  const mean = (xs: readonly number[]): Measured<number> =>
    xs.length === 0 ? unavailable('no cell reported this metric') : round(sum(xs) / xs.length, 3)

  const perCell: RollupCellRow[] = reports.map((r) => ({
    instanceId: r.instanceId,
    arm: r.arm,
    steers: r.orchestration.steers,
    waves: r.orchestration.waves,
    utilization: r.orchestration.workerUtilization,
    idlePct: r.orchestration.idlePct,
    resolved: r.outcome.judgeResolved,
    usd: r.economics.totalUsd,
    ...(r.economics.resourceRecords === undefined
      ? {}
      : { resourceRecords: r.economics.resourceRecords }),
  }))

  return {
    schema: SUPERVISOR_RUN_ROLLUP_SCHEMA,
    cells: reports.length,
    steersTotal:
      steerVals.length === 0 ? unavailable('no cell reported a steer count') : sum(steerVals),
    cellsWithSteers:
      steerVals.length === 0
        ? unavailable('no cell reported a steer count')
        : steerVals.filter((n) => n > 0).length,
    cellsWithUnavailableSteers: reports.filter((r) => isUnavailable(r.orchestration.steers)).length,
    wavesMean: mean(waveVals),
    maxConcurrencyMax:
      concVals.length === 0 ? unavailable('no cell reported concurrency') : Math.max(...concVals),
    utilizationMean: mean(utilVals),
    idlePctMean: mean(idleVals),
    workersSpawnedTotal:
      spawnVals.length === 0 ? unavailable('no cell reported spawns') : sum(spawnVals),
    acceptedTotal:
      acceptVals.length === 0 ? unavailable('no cell reported acceptance') : sum(acceptVals),
    usdTotal: usdVals.length === 0 ? unavailable('no cell reported spend') : round(sum(usdVals), 6),
    spendUsd: {
      journalDerived: {
        value:
          journalSpendVals.length === 0
            ? unavailable('no cell measured journal-derived spend')
            : round(sum(journalSpendVals), 6),
        runs: journalSpendVals.length,
      },
      closeRecord: {
        value:
          closeSpendVals.length === 0
            ? unavailable('no cell carried a close record')
            : round(sum(closeSpendVals), 6),
        runs: closeSpendVals.length,
      },
    },
    resolvedCount:
      resolvedVals.length === 0
        ? unavailable('no cell reported a judge verdict')
        : resolvedVals.filter((v) => v === true).length,
    perCell,
  }
}
