/**
 * Milestone 3, phase 1: re-run admission over the recorded rows under the
 * current contract, and let the GATE decide what survives.
 *
 * The largest-eigenval task is not filtered out by name here. Its measured
 * oracle flips on 8 of 16 replicate units, `admitRow` reads that verdict, and
 * the rejection it returns is `task-oracle-nondeterministic`. Reporting the
 * exclusion as a gate decision is the difference between a denominator a reader
 * can check and one they have to take on trust.
 *
 * No container opens and no model runs: every input is a measurement already
 * recorded.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { admitRow } from '../src/trace-repair'
import { WORK } from './tb-repair-m2-lib'
import {
  type LegacyAdmissionEvidence,
  M3_CONTROL_POLICY,
  M3_CRITERIA,
  taskNameOf,
  upgradeEvidence,
} from './tb-repair-m3-lib'

interface LegacyRecord {
  rowId: string
  admitted: boolean
  rejection: string | null
  evidence: LegacyAdmissionEvidence | null
}

function main(): void {
  const outDir = process.env.TBR_OUT ?? join(WORK, 'out')
  const m3Dir = process.env.TBR_M3_OUT ?? '/home/drew/bench-cache/tbench-20260808/m3'
  mkdirSync(m3Dir, { recursive: true })

  const legacy = JSON.parse(readFileSync(join(outDir, 'admit.json'), 'utf8')) as {
    records: LegacyRecord[]
  }
  // The milestone-2 pre-registered subset, unchanged. It was fixed by a rule
  // written before any answer was graded and is not re-drawn here.
  const preRegistered = JSON.parse(
    readFileSync(join(outDir, 'row-subset.json'), 'utf8'),
  ) as string[]
  const preRegisteredSet = new Set(preRegistered)

  const records = legacy.records
    .filter((record) => record.evidence !== null)
    .map((record) => {
      const wasAdmitted = record.admitted
      if (!wasAdmitted) {
        return {
          rowId: record.rowId,
          taskName: taskNameOf(record.rowId),
          preRegistered: preRegisteredSet.has(record.rowId),
          m2Admitted: false,
          m2Rejection: record.rejection,
          m3Admitted: false,
          m3Rejection: record.rejection,
          oracleStable: null as boolean | null,
          oracleFlipRate: null as number | null,
        }
      }
      const decision = admitRow(upgradeEvidence(record.evidence!), M3_CRITERIA)
      return {
        rowId: record.rowId,
        taskName: taskNameOf(record.rowId),
        preRegistered: preRegisteredSet.has(record.rowId),
        m2Admitted: true,
        m2Rejection: null,
        m3Admitted: decision.admitted,
        m3Rejection: decision.admitted ? null : decision.rejection,
        oracleStable: decision.screening.oracleStable,
        oracleFlipRate: decision.screening.oracleFlipRate,
      }
    })

  const survivors = records.filter((record) => record.m3Admitted && record.preRegistered)
  const clusters = [...new Set(survivors.map((record) => record.taskName))].sort()
  const poolSurvivors = records.filter((record) => record.m3Admitted)
  const poolClusters = [...new Set(poolSurvivors.map((record) => record.taskName))].sort()

  const rejectionsByReason = new Map<string, number>()
  for (const record of records) {
    if (record.m3Admitted) continue
    const reason = record.m3Rejection ?? 'unknown'
    rejectionsByReason.set(reason, (rejectionsByReason.get(reason) ?? 0) + 1)
  }

  const report = {
    phase: 'm3-admit',
    generatedAt: new Date().toISOString(),
    controlPolicy: M3_CONTROL_POLICY,
    criteria: M3_CRITERIA,
    denominator: {
      recordedRows: records.length,
      m2Admitted: records.filter((record) => record.m2Admitted).length,
      m3AdmittedPool: poolSurvivors.length,
      m3PoolClusters: poolClusters,
      preRegistered: preRegistered.length,
      preRegisteredSurviving: survivors.length,
      survivingClusters: clusters,
      rejections: Object.fromEntries(rejectionsByReason),
    },
    rows: records,
    measurementSet: survivors.map((record) => record.rowId),
  }
  writeFileSync(join(m3Dir, 'admit-m3.json'), JSON.stringify(report, null, 2))
  writeFileSync(join(m3Dir, 'row-subset-m3.json'), JSON.stringify(report.measurementSet, null, 2))

  process.stdout.write(
    `recorded=${records.length} m2Admitted=${report.denominator.m2Admitted} ` +
      `m3Pool=${poolSurvivors.length} (${poolClusters.length} clusters) ` +
      `preRegistered=${preRegistered.length} surviving=${survivors.length} ` +
      `clusters=${clusters.length} [${clusters.join(', ')}]\n` +
      `rejections: ${JSON.stringify(Object.fromEntries(rejectionsByReason))}\n`,
  )
}

main()
