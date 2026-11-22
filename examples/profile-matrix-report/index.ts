/**
 * Render the profile-matrix decision page from cells you already ran.
 *
 * Run with:
 *   pnpm tsx examples/profile-matrix-report/index.ts <rows-dir> --truth <truth.json> \
 *     --label <field> --slice <field> --cluster <field> --baseline <cell> --out <page.html> \
 *     [--min-coverage <share of the baseline's cases a panel cell must have scored, default 0.9>]
 *
 * `<rows-dir>` holds one JSONL file per cell, named `<harness>-<model>-<effort>[-<instructions>].jsonl`
 * with no hyphen inside a level; the name gives the cell's factor levels. Each row is one case:
 * `{ case, label, seconds, tokens: { input, output, reasoning, cache_read }, model, served?, probs? }`,
 * where `probs` maps each label to the cell's forecast for it; the forecast for the label it
 * answered is its forecast that it is right, which the calibration panel reads.
 * A row without a label is a failed attempt; for a case answered more than once the last
 * labelled row counts. `<truth.json>` maps each case to an object holding the true label
 * and the slice and cluster fields named by the flags.
 *
 * The converter is the adapter a product writes: it maps its own rows onto `RunRecord`, and
 * the page reads only that contract. No model is called.
 */

import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { parseArgs } from 'node:util'
import {
  analyzeProfileMatrix,
  type ProfileMatrixReportOptions,
} from '../../src/campaign/presets/profile-matrix-analysis'
import { renderProfileMatrixReport } from '../../src/campaign/presets/profile-matrix-report'
import type { RunRecord } from '../../src/run-record'

interface Row {
  case?: string
  label?: string | null
  seconds?: number
  tokens?: { input?: number; output?: number; reasoning?: number; cache_read?: number }
  model?: string
  served?: string
  probs?: Record<string, number> | null
}

type Truth = Record<string, Record<string, string>>

function readCell(path: string): Row[] {
  const rows = new Map<string, Row>()
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line.trim() === '') continue
    let row: Row
    try {
      row = JSON.parse(line) as Row
    } catch {
      continue // a row still being written
    }
    if (typeof row.case !== 'string') continue
    if (row.label || !rows.has(row.case)) rows.set(row.case, row)
  }
  return [...rows.values()]
}

/**
 * One row as a RunRecord. Tokens follow `RunTokenUsage`: `output` holds every generated
 * token with reasoning counted once, and `cached` holds prompt tokens served from cache.
 * A source that reports reasoning outside output shows it on rows whose reasoning exceeds
 * output; those cells add reasoning into output.
 *
 * The rows name the model as served under a moving alias, so these records keep that name
 * and carry no snapshot: they serve analysis, and `validateRunRecord` would refuse them as
 * release evidence. Flat-rate seats have no marginal dollar cost, so cost stays uncaptured.
 */
function toRecord(
  cell: string,
  row: Row,
  truth: Truth,
  labelField: string,
  reasoningOutsideOutput: boolean,
): RunRecord {
  const caseId = row.case!
  const tokens = row.tokens ?? {}
  const reasoning = tokens.reasoning ?? 0
  const expected = truth[caseId]?.[labelField]
  if (expected === undefined)
    throw new Error(`case ${caseId} has no '${labelField}' in the truth file`)
  const score = row.label ? (row.label === expected ? 1 : 0) : undefined
  const pRight = row.label ? row.probs?.[row.label] : undefined
  const configHash = createHash('sha256').update(cell).digest('hex')
  return {
    runId: `${cell}:${caseId}`,
    experimentId: 'profile-matrix-report-example',
    candidateId: cell,
    seed: 0,
    model: row.served ?? row.model ?? 'unknown',
    promptHash: configHash,
    configHash,
    commitSha: 'external-rows',
    wallMs: Math.round((row.seconds ?? 0) * 1000),
    costUsd: null,
    costProvenance: { kind: 'uncaptured', usd: null },
    tokenUsage: {
      input: tokens.input ?? 0,
      output: (tokens.output ?? 0) + (reasoningOutsideOutput ? reasoning : 0),
      reasoning,
      cached: tokens.cache_read ?? 0,
    },
    terminalOutcome: score === undefined ? 'failed' : 'succeeded',
    outcome: {
      raw: typeof pRight === 'number' ? { p_right: pRight } : {},
      ...(score === undefined ? {} : { searchScore: score }),
    },
    splitTag: 'search',
    scenarioId: caseId,
  }
}

function main(): void {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      truth: { type: 'string' },
      label: { type: 'string' },
      slice: { type: 'string' },
      cluster: { type: 'string' },
      baseline: { type: 'string' },
      out: { type: 'string' },
      'min-coverage': { type: 'string' },
      title: { type: 'string', default: 'Profile matrix' },
    },
  })
  const [rowsDir] = positionals
  const { truth: truthPath, label, slice, cluster, baseline, out } = values
  if (!rowsDir || !truthPath || !label || !slice || !cluster || !baseline || !out) {
    throw new Error(
      'usage: index.ts <rows-dir> --truth <file> --label <field> --slice <field> --cluster <field> --baseline <cell> --out <file>',
    )
  }
  const truth = JSON.parse(readFileSync(truthPath, 'utf8')) as Truth
  const records: RunRecord[] = []
  const factors: Record<string, Record<string, string>> = {}
  for (const file of readdirSync(rowsDir)
    .filter((name) => name.endsWith('.jsonl'))
    .sort()) {
    const cell = basename(file, '.jsonl')
    const rows = readCell(join(rowsDir, file))
    const outside = rows.some((row) => (row.tokens?.reasoning ?? 0) > (row.tokens?.output ?? 0))
    records.push(...rows.map((row) => toRecord(cell, row, truth, label, outside)))
    const [harness, model, effort, ...instructions] = cell.split('-')
    if (!harness || !model || !effort)
      throw new Error(`cell name ${cell} is not <harness>-<model>-<effort>`)
    factors[cell] = { harness, model, effort, instructions: instructions.join('-') || 'default' }
    console.log(`${cell}: ${rows.length} cases${outside ? ', reasoning added into output' : ''}`)
  }
  const caseIds = [...new Set(records.map((record) => record.scenarioId))]
  const field = (name: string, missing?: string) =>
    Object.fromEntries(
      caseIds.map((caseId) => {
        const value = truth[caseId]?.[name] ?? missing
        if (value === undefined)
          throw new Error(`case ${caseId} has no '${name}' in the truth file`)
        return [caseId, String(value)]
      }),
    )
  const options: ProfileMatrixReportOptions = {
    source: records,
    baseline,
    clusters: field(cluster),
    slices: field(slice, 'unlabelled'),
    factors,
    ...(values['min-coverage'] === undefined
      ? {}
      : { minCoverage: Number(values['min-coverage']) }),
    probabilityOf: (record) => record.outcome.raw.p_right,
    title: values.title,
  }
  const analysis = analyzeProfileMatrix(options)
  writeFileSync(out, renderProfileMatrixReport(options))

  console.log(
    `\npanel: ${analysis.panelProfiles.length} cells on ${analysis.commonCases.length} common cases ` +
      `in ${analysis.commonClusters} clusters; page written to ${out}`,
  )
  console.log(
    'cell                          scored  cover  panel  own acc  common acc  paired n  diff vs baseline [95%]      p50 s  mean tokens',
  )
  for (const p of analysis.profiles) {
    const vs = p.vsBaseline
    const diff = vs
      ? `${vs.estimate.toFixed(4)} [${vs.low?.toFixed(3) ?? '—'}, ${vs.high?.toFixed(3) ?? '—'}]`
      : 'baseline'
    console.log(
      `${p.profileId.padEnd(29)} ${String(p.casesScored).padStart(6)}  ${p.coverage.toFixed(2)}  ` +
        `${(p.panel ? 'yes' : 'no').padEnd(5)}  ${p.ownQuality?.estimate.toFixed(4) ?? '—     '}   ` +
        `${p.quality?.estimate.toFixed(4) ?? '—     '}      ${String(p.pairedN).padStart(8)}  ${diff.padEnd(26)} ` +
        `${p.latency?.p50.toFixed(1).padStart(5) ?? '    —'}  ${p.costPerCase.tokens === null ? '—' : Math.round(p.costPerCase.tokens)}`,
    )
  }
}

main()
