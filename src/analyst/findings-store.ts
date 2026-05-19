/**
 * FindingsStore — durable persistence for AnalystFinding rows + a diff
 * helper so we can answer "what changed since the last run?" without
 * recomputing analysts.
 *
 * On-disk shape is JSONL: one finding per line, append-only, locked via
 * LockedJsonlAppender. Operators get crash-safety (no partial JSON),
 * cheap reads (sequential parse), and trivial backup (rsync the file).
 *
 * Reads are non-locking: a reader sees a consistent snapshot of all
 * fully-written lines and skips an incomplete trailing line if the
 * writer is mid-append. Cross-process locking is intentionally out of
 * scope (see locked-jsonl-appender.ts).
 *
 * The store is run-scoped: callers pass `runId` on append and on load,
 * which keeps multi-run files cleanly partitioned. The `diffFindings`
 * helper compares two run-id sets using stable `finding_id` semantics —
 * the diff is the cross-run signal the regression dashboard renders.
 */

import { readFileSync, existsSync } from 'node:fs'

import { LockedJsonlAppender } from '../locked-jsonl-appender'
import type { AnalystFinding } from './types'

/**
 * One persisted row. We attach `run_id` on disk so a single file can
 * hold multiple runs and the diff helper can query without re-walking
 * separate files.
 */
export interface PersistedFinding extends AnalystFinding {
  run_id: string
}

export class FindingsStore {
  private readonly appender: LockedJsonlAppender

  constructor(public readonly path: string) {
    this.appender = new LockedJsonlAppender(path)
  }

  async append(runId: string, findings: AnalystFinding[]): Promise<void> {
    for (const f of findings) {
      const row: PersistedFinding = { ...f, run_id: runId }
      await this.appender.append(row)
    }
  }

  /** Load every persisted finding. Discards malformed trailing lines silently. */
  loadAll(): PersistedFinding[] {
    if (!existsSync(this.path)) return []
    const raw = readFileSync(this.path, 'utf8')
    if (!raw) return []
    const out: PersistedFinding[] = []
    for (const line of raw.split('\n')) {
      if (!line) continue
      try {
        out.push(JSON.parse(line) as PersistedFinding)
      } catch {
        // Skip torn trailing line — the lock guarantees no torn lines
        // mid-file, only at EOF when a writer is in-flight.
      }
    }
    return out
  }

  /** Filter to a single run. */
  loadRun(runId: string): PersistedFinding[] {
    return this.loadAll().filter((r) => r.run_id === runId)
  }
}

// ── Cross-run diff ──────────────────────────────────────────────────

export interface FindingsDiff {
  /** New finding ids in `current` that weren't in `previous`. */
  appeared: PersistedFinding[]
  /** Finding ids in `previous` that aren't in `current`. */
  disappeared: PersistedFinding[]
  /** Same finding id present in both runs and unchanged per the materiality test. */
  persisted: PersistedFinding[]
  /**
   * Same finding id in both runs but at least one non-identity field
   * shifted per `DiffPolicy.isMaterial`. Reported as [previous, current].
   */
  changed: Array<{ previous: PersistedFinding; current: PersistedFinding }>
}

export interface DiffPolicy {
  /**
   * Predicate that decides whether two findings (same finding_id) count
   * as a material change. Defaults to {@link defaultIsMaterial}: severity
   * shift, confidence Δ > 0.05, or evidence count change. Compliance /
   * perf consumers MAY supply a stricter predicate (e.g. rationale text
   * diff, metric Δ thresholds).
   */
  isMaterial?: (previous: AnalystFinding, current: AnalystFinding) => boolean
}

/**
 * Default materiality test. Deliberately narrow so LLM-reword churn
 * doesn't flood the diff. Stricter tests are opt-in via DiffPolicy.
 */
export function defaultIsMaterial(a: AnalystFinding, b: AnalystFinding): boolean {
  if (a.severity !== b.severity) return true
  if (Math.abs((a.confidence ?? 0) - (b.confidence ?? 0)) > 0.05) return true
  if (a.evidence_refs.length !== b.evidence_refs.length) return true
  return false
}

/**
 * Diff two findings sets by stable finding_id. Callers typically load
 * the two run-id slices from the same store and pass them in.
 */
export function diffFindings(
  previous: PersistedFinding[],
  current: PersistedFinding[],
  policy: DiffPolicy = {},
): FindingsDiff {
  const isMaterial = policy.isMaterial ?? defaultIsMaterial
  const prevById = new Map(previous.map((f) => [f.finding_id, f]))
  const curById = new Map(current.map((f) => [f.finding_id, f]))

  const appeared: PersistedFinding[] = []
  const disappeared: PersistedFinding[] = []
  const persisted: PersistedFinding[] = []
  const changed: FindingsDiff['changed'] = []

  for (const [id, cur] of curById) {
    const prev = prevById.get(id)
    if (!prev) {
      appeared.push(cur)
      continue
    }
    if (isMaterial(prev, cur)) {
      changed.push({ previous: prev, current: cur })
    } else {
      persisted.push(cur)
    }
  }
  for (const [id, prev] of prevById) {
    if (!curById.has(id)) disappeared.push(prev)
  }
  return { appeared, disappeared, persisted, changed }
}
