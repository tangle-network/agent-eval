/**
 * EvalTraceStore — JSONL save / query / compare over the analysis-time
 * `RunRecord` row.
 *
 * `FileSystemTraceStore` (in `./trace/store`) persists the rich TraceSchema-v1
 * span corpus — runs, spans, events, artifacts — the runtime emits live. That
 * is NOT the thing three consumers hand-roll in `tests/eval/lib/trace-store.ts`.
 * What they hand-roll is the *analysis* layer: append each finished run as one
 * JSONL line keyed by scenario/candidate, then query it ("every run where score
 * < 50"), pick the best run for a scenario (few-shot seeding), and compare two
 * candidates on matched scenarios.
 *
 * The substrate already has the canonical analysis-time row — `RunRecord` — so
 * this is that query/compare API expressed over `RunRecord[]`, with a
 * JSONL-backed store. It does NOT fork `FileSystemTraceStore`; it sits beside it
 * for the analysis projection.
 */

import { ValidationError } from './errors'
import { isRealnessGated, trainingScore } from './rollout/reward'
import { isRunRecord, type RunRecord, type RunSplitTag, validateRunRecord } from './run-record'

/**
 * The score the query/compare layer ranks on: holdout when present, else
 * search, with the anti-Goodhart gate applied — a run flagged as gamed reads 0
 * however high it claims to have scored.
 *
 * The gate is load-bearing here and this function did not previously apply it,
 * despite saying it did. `getBest` is few-shot exemplar selection: whatever it
 * returns is pasted into the next agent's prompt as an example to imitate.
 * Ranking on the raw number handed the highest-scoring gamed trajectory to
 * every subsequent run — propagation through the context window rather than
 * through a gradient, but propagation all the same.
 *
 * Analysis that needs to SEE the inflated number (reward-hack detection,
 * per-run reporting) reads `observedScore` from `rollout/reward.ts` directly.
 *
 * Throws when a record carries neither score — a RunRecord is invalid without
 * at least one, but a hand-built object might be.
 */
export function runScore(record: RunRecord): number {
  const score = trainingScore(record)
  if (score === undefined) {
    throw new ValidationError(
      `EvalTraceStore: run ${record.runId} has neither holdoutScore nor searchScore`,
    )
  }
  return score
}

export interface RunRecordFilter {
  experimentId?: string
  candidateId?: string
  scenarioId?: string
  model?: string
  splitTag?: RunSplitTag
  /** Inclusive lower bound on `runScore`. */
  minScore?: number
  /** Inclusive upper bound on `runScore`. */
  maxScore?: number
  /** Match a single tag in `outcome.raw` by exact numeric value. */
  rawEquals?: { key: string; value: number }
  /** Custom predicate, ANDed with the structured filters. */
  where?: (record: RunRecord) => boolean
}

function matches(record: RunRecord, f: RunRecordFilter): boolean {
  if (f.experimentId && record.experimentId !== f.experimentId) return false
  if (f.candidateId && record.candidateId !== f.candidateId) return false
  if (f.scenarioId && record.scenarioId !== f.scenarioId) return false
  if (f.model && record.model !== f.model) return false
  if (f.splitTag && record.splitTag !== f.splitTag) return false
  if (f.minScore !== undefined && runScore(record) < f.minScore) return false
  if (f.maxScore !== undefined && runScore(record) > f.maxScore) return false
  if (f.rawEquals && record.outcome.raw[f.rawEquals.key] !== f.rawEquals.value) return false
  if (f.where && !f.where(record)) return false
  return true
}

export interface CandidateComparison {
  a: string
  b: string
  /** Scenario ids present for BOTH candidates — the paired comparison set. */
  pairedScenarioIds: string[]
  /** Mean `runScore` for candidate a over the paired scenarios. */
  meanA: number
  /** Mean `runScore` for candidate b over the paired scenarios. */
  meanB: number
  /** meanB − meanA. Positive ⇒ b scored higher on the matched scenarios. */
  meanDelta: number
  /** Scenarios where b beat a (strictly), tied, and a beat b. */
  bWins: number
  ties: number
  aWins: number
  /**
   * Runs of either candidate excluded from the comparison because the
   * authenticity gate flagged them (`outcome.realness.gated`).
   *
   * Excluded rather than scored 0: `runScore` is gated, so leaving them in
   * would have entered a gamed run as a silent zero, which reads as "this
   * candidate failed the scenario" when what happened is "this candidate's
   * result is not evidence". A non-zero count here is itself the finding — a
   * comparison drawn over a shrunken scenario set has to say so.
   */
  realnessGatedRuns: number
}

/**
 * Backing persistence for `EvalTraceStore`. The in-memory store is the default;
 * the JSONL file store appends one validated `RunRecord` per line. Both keep an
 * append order so `getBest` / `compareRuns` are reproducible.
 */
export interface RunRecordBackend {
  append(record: RunRecord): Promise<void>
  load(): Promise<RunRecord[]>
}

export function inMemoryRunRecordBackend(initial: RunRecord[] = []): RunRecordBackend {
  const rows = initial.map((r) => validateRunRecord(r))
  return {
    async append(record) {
      rows.push(record)
    },
    async load() {
      return [...rows]
    },
  }
}

/**
 * JSONL-backed store at `path`, one `RunRecord` per line. Malformed lines fail
 * loud on load (a corrupt corpus must not silently shrink the analysis set);
 * pass `skipInvalid` only for forensics on a known-bad file.
 */
export function jsonlRunRecordBackend(
  path: string,
  opts: { skipInvalid?: boolean } = {},
): RunRecordBackend {
  return {
    async append(record) {
      const fs = await import('node:fs/promises')
      const pathMod = await import('node:path')
      await fs.mkdir(pathMod.dirname(path), { recursive: true })
      await fs.appendFile(path, `${JSON.stringify(record)}\n`, 'utf8')
    },
    async load() {
      const fs = await import('node:fs/promises')
      let raw: string
      try {
        raw = await fs.readFile(path, 'utf8')
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
        throw err
      }
      const out: RunRecord[] = []
      let lineNo = 0
      for (const line of raw.split('\n')) {
        lineNo++
        if (!line.trim()) continue
        let parsed: unknown
        try {
          parsed = JSON.parse(line)
        } catch (err) {
          if (opts.skipInvalid) continue
          throw new ValidationError(`EvalTraceStore: ${path}:${lineNo} is not valid JSON`)
        }
        if (opts.skipInvalid) {
          if (isRunRecord(parsed)) out.push(parsed)
          continue
        }
        try {
          out.push(validateRunRecord(parsed))
        } catch (err) {
          throw new ValidationError(
            `EvalTraceStore: ${path}:${lineNo} is not a valid RunRecord — ${(err as Error).message}`,
          )
        }
      }
      return out
    },
  }
}

/**
 * Query / compare layer over a `RunRecord` corpus. Append finished runs, query
 * with a structured filter, take the best run for a scenario, and compare two
 * candidates on their matched scenarios. Persistence is injected via
 * `RunRecordBackend` (in-memory by default, JSONL file via
 * `jsonlRunRecordBackend`).
 */
export class EvalTraceStore {
  private readonly backend: RunRecordBackend

  constructor(backend: RunRecordBackend = inMemoryRunRecordBackend()) {
    this.backend = backend
  }

  /** Validate and append one run. Throws on an invalid record — the corpus
   *  stays paper-grade. */
  async append(record: RunRecord): Promise<void> {
    await this.backend.append(validateRunRecord(record))
  }

  async all(): Promise<RunRecord[]> {
    return this.backend.load()
  }

  async query(filter: RunRecordFilter = {}): Promise<RunRecord[]> {
    const rows = await this.backend.load()
    return rows.filter((r) => matches(r, filter))
  }

  /**
   * Highest-scoring run for a scenario (optionally restricted to a candidate).
   * Returns null when no run matches. Ties resolve to the earliest-appended run
   * so the result is stable.
   *
   * Runs flagged as gamed are DROPPED, not zeroed. The caller's use for this is
   * few-shot seeding — the returned trajectory becomes an example to copy — so
   * the same rule as SFT applies: a faked success must not be in the candidate
   * set at all. When every run for the scenario is gated the honest answer is
   * `null` (no exemplar), never the least-bad fake.
   */
  async getBest(
    scenarioId: string,
    opts: { candidateId?: string; splitTag?: RunSplitTag } = {},
  ): Promise<RunRecord | null> {
    const rows = (
      await this.query({
        scenarioId,
        candidateId: opts.candidateId,
        splitTag: opts.splitTag,
      })
    ).filter((r) => !isRealnessGated(r))
    if (rows.length === 0) return null
    let best = rows[0]!
    let bestScore = runScore(best)
    for (let i = 1; i < rows.length; i++) {
      const s = runScore(rows[i]!)
      if (s > bestScore) {
        best = rows[i]!
        bestScore = s
      }
    }
    return best
  }

  /**
   * Compare two candidates on the scenarios they BOTH ran. When a candidate
   * ran a scenario more than once, its best `runScore` for that scenario is
   * used. Throws when there is no paired scenario — an unpaired "comparison" is
   * not one.
   *
   * Realness-gated runs are excluded and counted in `realnessGatedRuns`, never
   * folded in as a zero.
   */
  async compareRuns(candidateA: string, candidateB: string): Promise<CandidateComparison> {
    if (candidateA === candidateB) {
      throw new ValidationError(
        `EvalTraceStore.compareRuns: candidates must differ ("${candidateA}")`,
      )
    }
    const rows = await this.backend.load()
    let realnessGatedRuns = 0
    const bestByScenario = (candidate: string): Map<string, number> => {
      const m = new Map<string, number>()
      for (const r of rows) {
        if (r.candidateId !== candidate) continue
        const sid = r.scenarioId
        if (!sid) continue
        if (isRealnessGated(r)) {
          realnessGatedRuns++
          continue
        }
        const s = runScore(r)
        const prev = m.get(sid)
        if (prev === undefined || s > prev) m.set(sid, s)
      }
      return m
    }
    const aScores = bestByScenario(candidateA)
    const bScores = bestByScenario(candidateB)
    const paired = [...aScores.keys()].filter((sid) => bScores.has(sid)).sort()
    if (paired.length === 0) {
      throw new ValidationError(
        `EvalTraceStore.compareRuns: "${candidateA}" and "${candidateB}" share no scenario (need scenarioId on records)`,
      )
    }
    let sumA = 0
    let sumB = 0
    let bWins = 0
    let aWins = 0
    let ties = 0
    for (const sid of paired) {
      const sa = aScores.get(sid)!
      const sb = bScores.get(sid)!
      sumA += sa
      sumB += sb
      if (sb > sa) bWins++
      else if (sb < sa) aWins++
      else ties++
    }
    const meanA = sumA / paired.length
    const meanB = sumB / paired.length
    return {
      a: candidateA,
      b: candidateB,
      pairedScenarioIds: paired,
      meanA,
      meanB,
      meanDelta: meanB - meanA,
      bWins,
      ties,
      aWins,
      realnessGatedRuns,
    }
  }
}
