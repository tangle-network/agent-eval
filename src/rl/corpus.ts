/**
 * RL corpus — the durable, append-only accumulation of graded RunRecords that
 * every eval run deposits BY DEFAULT.
 *
 * The dataset is the free exhaust of the normal eval process: we run evals
 * constantly to get an agent production-ready, and those runs already produce
 * graded trajectories. Instead of writing them to an ephemeral run dir and
 * throwing them away, `appendToCorpus` accumulates them into a durable corpus;
 * `buildDatasetFromCorpus` later harvests the whole corpus into a publishable
 * bundle. No separate data-collection campaign — the data accrues from work we
 * do anyway. This is the "best things for free by our process" layer.
 *
 * Trajectory text rides on the record as top-level `prompt` / `completion`
 * (what the eval harnesses capture; the RunRecord validator ignores the extra
 * keys). The harvest reads them directly — no trace store round-trip needed.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { mintRolloutRows } from '../rollout/mint'
import { trainingScore } from '../rollout/reward'
import type { RunRecord } from '../run-record'
import { InMemoryTraceStore } from '../trace/store'
import { buildRlDataset, type RlDatasetBundle, type RlDatasetConfig } from './dataset'

/** A corpus record is a RunRecord carrying the trajectory text the harness
 *  captured. `prompt`/`completion` are top-level (the validator ignores extras). */
export type CorpusRecord = RunRecord & { prompt?: string; completion?: string }

export interface CorpusAppendResult {
  appended: number
  /** Skipped because a record with the same runId was already in the corpus
   *  (idempotent appends — NOT re-run collapsing; re-runs get fresh runIds). */
  skipped: number
  total: number
}

/**
 * Append graded records to the corpus (append-only JSONL). Deduplicates by
 * `runId` against what's already on disk so re-running the same harness is
 * idempotent. Creates the file and parent dir. This is the call every eval
 * harness makes by default after producing its records.
 */
export function appendToCorpus(records: CorpusRecord[], corpusPath: string): CorpusAppendResult {
  mkdirSync(dirname(corpusPath), { recursive: true })
  const existing = existsSync(corpusPath) ? readCorpus(corpusPath) : []
  const seen = new Set(existing.map((r) => r.runId))
  const lines: string[] = []
  let appended = 0
  let skipped = 0
  for (const r of records) {
    if (seen.has(r.runId)) {
      skipped++
      continue
    }
    seen.add(r.runId)
    lines.push(JSON.stringify(r))
    appended++
  }
  if (lines.length > 0) appendFileSync(corpusPath, `${lines.join('\n')}\n`)
  return { appended, skipped, total: existing.length + appended }
}

/** Read the full corpus. Returns [] if the corpus does not exist yet. */
export function readCorpus(corpusPath: string): CorpusRecord[] {
  if (!existsSync(corpusPath)) return []
  const out: CorpusRecord[] = []
  for (const line of readFileSync(corpusPath, 'utf8').split('\n')) {
    if (line.trim()) out.push(JSON.parse(line) as CorpusRecord)
  }
  return out
}

/**
 * The harvest's score reader is GATED: a gamed run reads 0, so it cannot buy
 * its way past `minScore` into the published bundle with its claimed score.
 * `null` = unscored (a labeled gap, dropped before packaging, never a 0).
 */
function rewardOf(r: CorpusRecord): number | null {
  const v = trainingScore(r)
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

export interface HarvestOptions {
  /** Keep only records scoring >= this (rejection-sampling for SFT). */
  minScore?: number
  /** Keep only these source splits. Held-out rows still require the explicit override below. */
  splits?: RunRecord['splitTag'][]
  /** Permit held-out rows in training files. Default false. */
  allowHeldOutTrainingData?: boolean
}

/**
 * Harvest the accumulated corpus into a publishable RL dataset bundle. Reads
 * trajectory text from each record's top-level `prompt`/`completion`; records
 * missing either are excluded (a graded score with no trajectory can't train).
 * Optionally filters by score / split. Throws (via buildRlDataset) if nothing
 * survives — an empty dataset must never be published.
 *
 * `minScore` is applied to the GATED reward (`trainingScore`), so a gamed run
 * cannot buy its way into the published bundle with its claimed score —
 * `minScore` is exactly the door a reward-hacked run would otherwise clear for
 * SFT. Unscored records are dropped before packaging: a missing label is not a
 * zero, and it is not publishable either.
 */
export async function buildDatasetFromCorpus(
  corpusPath: string,
  config: RlDatasetConfig,
  opts: HarvestOptions = {},
): Promise<RlDatasetBundle> {
  let records = readCorpus(corpusPath).filter(
    (r) => typeof r.prompt === 'string' && typeof r.completion === 'string',
  )
  if (opts.splits) records = records.filter((r) => opts.splits!.includes(r.splitTag))
  records = records.filter((r) => rewardOf(r) !== null)
  if (opts.minScore != null) {
    records = records.filter((r) => {
      const reward = rewardOf(r)
      return reward !== null && reward >= opts.minScore!
    })
  }

  const text = new Map(
    records.map((r) => [r.runId, { prompt: r.prompt!, completion: r.completion! }]),
  )
  const lookups = {
    promptOf: (id: string) => text.get(id)?.prompt ?? '',
    completionOf: (id: string) => text.get(id)?.completion ?? '',
    allowHeldOutTrainingData: opts.allowHeldOutTrainingData,
  }
  const { rows } = await mintRolloutRows(records, new InMemoryTraceStore())
  return buildRlDataset(rows, lookups, config)
}
