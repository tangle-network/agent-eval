// The check a conversation engine runs against the golden records.
//
// The harness owns the whole comparison: it builds the scenario, runs the
// engine, normalizes what came back exactly as the recorder did, and reports
// every field that moved. It asserts through a thrown error rather than a test
// framework, so a consumer on vitest, node:test, or a plain script all use the
// same call.

import type { RunMultishotMatrixResult } from '../matrix'
import { compareJson } from './compare'
import type { MultishotGoldenEngine, MultishotMatrixGoldenEngine } from './engine'
import {
  type MultishotMatrixGoldenScenario,
  multishotMatrixGoldenScenarios,
} from './matrix-scenarios'
import {
  readRunDir,
  recordError,
  recordResult,
  sortJudgeRequests,
  stripVolatile,
} from './recording'
import { goldenRecords } from './records'
import { type MultishotGoldenScenario, multishotGoldenScenarios } from './scenarios'
import type {
  MultishotGoldenRecord,
  MultishotGoldenRecordSet,
  MultishotMatrixGoldenRecord,
} from './types'

export interface MultishotGoldenScenarioReport {
  id: string
  description: string
  ok: boolean
  mismatches: string[]
}

export interface MultishotGoldenReport {
  version: string
  recordedFrom: string
  ok: boolean
  scenarios: MultishotGoldenScenarioReport[]
}

export class MultishotGoldenMismatchError extends Error {
  constructor(
    readonly scenarioId: string,
    readonly mismatches: string[],
    readonly version: string,
  ) {
    super(
      [
        `multishot golden ${version} — scenario "${scenarioId}" diverged from the record:`,
        ...mismatches.map((line) => `  - ${line}`),
      ].join('\n'),
    )
    this.name = 'MultishotGoldenMismatchError'
  }
}

function requireRecord(records: MultishotGoldenRecordSet, id: string): MultishotGoldenRecord {
  const record = records.scenarios.find((entry) => entry.id === id)
  if (!record) {
    throw new Error(
      `multishot golden ${records.version} holds no record for scenario "${id}" — regenerate the fixture for the new scenario`,
    )
  }
  return record
}

function requireMatrixRecord(
  records: MultishotGoldenRecordSet,
  id: string,
): MultishotMatrixGoldenRecord {
  const record = records.matrixScenarios.find((entry) => entry.id === id)
  if (!record) {
    throw new Error(
      `multishot golden ${records.version} holds no matrix record for scenario "${id}" — regenerate the fixture for the new scenario`,
    )
  }
  return record
}

/** Run one scenario and report every field that diverged from the record. */
export async function checkMultishotGoldenScenario(opts: {
  engine: MultishotGoldenEngine
  scenario: MultishotGoldenScenario
  records?: MultishotGoldenRecordSet
}): Promise<MultishotGoldenScenarioReport> {
  const records = opts.records ?? goldenRecords()
  const record = requireRecord(records, opts.scenario.id)
  const runCase = opts.scenario.build()

  let observed: MultishotGoldenRecord['outcome']
  const mismatches: string[] = []
  try {
    const result = await opts.engine(runCase.options)
    observed = { kind: 'result', result: recordResult(result) }
    // durationMs is wall clock and is excluded from the record, but it is still
    // part of the contract: a result must report a usable duration. It joins the
    // other mismatches rather than replacing them, so one bad field cannot hide
    // the rest of a divergent run.
    if (!isUsableDuration(result.durationMs)) {
      mismatches.push(
        `durationMs: expected a finite number >= 0, received ${String(result.durationMs)}`,
      )
    }
  } catch (err) {
    observed = { kind: 'error', error: recordError(err) }
  }

  mismatches.push(
    ...compareJson(record.outcome, observed, 'outcome'),
    ...compareJson(record.requests, runCase.requests, 'requests'),
  )
  return {
    id: opts.scenario.id,
    description: opts.scenario.description,
    ok: mismatches.length === 0,
    mismatches,
  }
}

/** Same as `checkMultishotGoldenScenario`, but throws on divergence. */
export async function assertMultishotGoldenScenario(opts: {
  engine: MultishotGoldenEngine
  scenario: MultishotGoldenScenario
  records?: MultishotGoldenRecordSet
}): Promise<void> {
  const records = opts.records ?? goldenRecords()
  const report = await checkMultishotGoldenScenario({ ...opts, records })
  if (!report.ok) {
    throw new MultishotGoldenMismatchError(report.id, report.mismatches, records.version)
  }
}

/** Run every shot scenario. Never throws on divergence — read `ok`. */
export async function checkMultishotGolden(opts: {
  engine: MultishotGoldenEngine
  records?: MultishotGoldenRecordSet
  only?: string[]
}): Promise<MultishotGoldenReport> {
  const records = opts.records ?? goldenRecords()
  const catalog = multishotGoldenScenarios()
  const wanted = opts.only ? new Set(opts.only) : undefined
  if (wanted) {
    // An id that names no scenario would silently shrink the run, and a run of
    // zero scenarios reports ok. A stale id after a rename must stop the check,
    // not green it.
    const unknown = [...wanted].filter((id) => !catalog.some((s) => s.id === id)).sort()
    if (unknown.length > 0) {
      throw new Error(
        `multishot golden: \`only\` names ${unknown.length === 1 ? 'a scenario' : 'scenarios'} the catalog does not hold: ${unknown.join(', ')}`,
      )
    }
  }
  const scenarios = catalog.filter((s) => !wanted || wanted.has(s.id))
  const reports: MultishotGoldenScenarioReport[] = []
  for (const scenario of scenarios) {
    reports.push(await checkMultishotGoldenScenario({ engine: opts.engine, scenario, records }))
  }
  return {
    version: records.version,
    recordedFrom: records.recordedFrom,
    ok: reports.every((report) => report.ok),
    scenarios: reports,
  }
}

/** Run one matrix scenario against `runDir` and report every divergence. */
export async function checkMultishotMatrixGoldenScenario(opts: {
  engine: MultishotMatrixGoldenEngine
  scenario: MultishotMatrixGoldenScenario
  /** An empty directory the engine may write its per-cell files into. */
  runDir: string
  records?: MultishotGoldenRecordSet
}): Promise<MultishotGoldenScenarioReport> {
  const records = opts.records ?? goldenRecords()
  const record = requireMatrixRecord(records, opts.scenario.id)
  const runCase = opts.scenario.build(opts.runDir)
  const restore = runCase.installJudgeWire()
  let matrix: RunMultishotMatrixResult
  try {
    matrix = await opts.engine(runCase.options)
  } finally {
    restore()
  }

  const mismatches = [
    ...compareJson(record.matrix, stripVolatile(matrix.matrix), 'matrix'),
    ...compareJson(record.requests, runCase.requests, 'requests'),
    ...compareJson(record.judgeRequests, sortJudgeRequests(runCase.judgeRequests), 'judgeRequests'),
    ...compareJson(record.files, readRunDir(opts.runDir), 'files'),
  ]
  return {
    id: opts.scenario.id,
    description: opts.scenario.description,
    ok: mismatches.length === 0,
    mismatches,
  }
}

export async function assertMultishotMatrixGoldenScenario(opts: {
  engine: MultishotMatrixGoldenEngine
  scenario: MultishotMatrixGoldenScenario
  runDir: string
  records?: MultishotGoldenRecordSet
}): Promise<void> {
  const records = opts.records ?? goldenRecords()
  const report = await checkMultishotMatrixGoldenScenario({ ...opts, records })
  if (!report.ok) {
    throw new MultishotGoldenMismatchError(report.id, report.mismatches, records.version)
  }
}

/** A duration a caller can read: finite and not negative. */
export function isUsableDuration(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

export { multishotGoldenScenarios, multishotMatrixGoldenScenarios }
