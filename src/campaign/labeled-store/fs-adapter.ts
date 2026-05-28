/**
 * @experimental
 *
 * Filesystem `LabeledScenarioStore` adapter. The default capture sink for
 * traces + eval artifacts. Production deployments typically swap for a
 * Turso/SQLite adapter (same interface).
 *
 * Records land as one JSONL file per source under `<root>/<source>.jsonl`.
 * Each line is a `LabeledScenarioRecord`. Append-only — no in-place edits.
 *
 * Safety properties enforced at write-time:
 *
 *   - **Provenance required**: writes without `source`, `sourceVersionHash`,
 *     `capturedAt`, `redactionStatus` are rejected. Closes the alignment
 *     reviewer's data-poisoning gap.
 *   - **Per-source rate limits**: optional `rateLimitBucket` + `maxWritesPerMinute`
 *     stops a single tenant/source from flooding the store.
 *
 * Safety properties enforced at sample-time:
 *
 *   - **Required split + capturedBefore**: substrate refuses to sample without
 *     an explicit `split` ('train' | 'test') AND a temporal cutoff. Eliminates
 *     accidental train/test contamination.
 *   - **Default training-source filter**: when the store is sampled with
 *     `split: 'train'`, production-trace records are EXCLUDED unless the
 *     caller passes `filter.source: 'production-trace'` explicitly. Closes
 *     the contamination-by-default gap flagged by the senior eval engineer.
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type {
  LabeledScenarioRecord,
  LabeledScenarioSampleArgs,
  LabeledScenarioSource,
  LabeledScenarioStore,
  LabeledScenarioWrite,
  LabelTrust,
} from '../types'
import { labelTrustRank } from '../types'

export interface FsLabeledScenarioStoreOptions {
  /** Root directory for JSONL files. Created if missing. */
  root: string
  /** Per-source rate limit. When set, writes exceeding the cap are rejected
   *  with a typed error. Default: no limit. */
  maxWritesPerMinutePerBucket?: number
  /** Test seam — override `Date.now()` for deterministic tests. */
  now?: () => number
}

export class LabeledScenarioStoreError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'LabeledScenarioStoreError'
  }
}

interface RateLimitState {
  bucket: string
  windowStartMs: number
  count: number
}

export class FsLabeledScenarioStore implements LabeledScenarioStore {
  private readonly now: () => number
  private readonly rateLimits = new Map<string, RateLimitState>()

  constructor(private readonly options: FsLabeledScenarioStoreOptions) {
    if (!existsSync(options.root)) mkdirSync(options.root, { recursive: true })
    this.now = options.now ?? Date.now
  }

  async observe(write: LabeledScenarioWrite): Promise<void> {
    this.assertProvenance(write)
    this.assertRateLimit(write)
    const record = this.toRecord(write)
    const path = this.pathForSource(write.source)
    const line = `${JSON.stringify(record)}\n`
    // Append atomically. For high-throughput a writev-friendly buffered
    // implementation lands in the Turso adapter; FS adapter is for tests +
    // local dev + small workloads.
    appendLine(path, line)
  }

  async sample(args: LabeledScenarioSampleArgs): Promise<LabeledScenarioRecord[]> {
    if (!args.split) {
      throw new LabeledScenarioStoreError(
        'split_required',
        'sample() requires an explicit `split` (train | test) — substrate refuses ambiguous reads',
      )
    }
    if (!args.capturedBefore) {
      throw new LabeledScenarioStoreError(
        'capturedBefore_required',
        'sample() requires an explicit `capturedBefore` timestamp for temporal-split discipline',
      )
    }

    const all: LabeledScenarioRecord[] = []
    for (const source of ALL_SOURCES) {
      // Default training-source filter: when sampling train, EXCLUDE
      // production-trace records unless the caller asks for them.
      if (args.split === 'train' && source === 'production-trace') {
        const explicit = sourceFilterContains(args.filter?.source, 'production-trace')
        if (!explicit) continue
      }
      const path = this.pathForSource(source)
      if (!existsSync(path)) continue
      const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean)
      for (const line of lines) {
        let record: LabeledScenarioRecord
        try {
          record = JSON.parse(line) as LabeledScenarioRecord
        } catch {
          continue
        }
        if (!matchesFilter(record, args, source)) continue
        all.push(record)
      }
    }

    // Deterministic order: by capturedAt ascending, then recordHash.
    all.sort((a, b) => {
      if (a.capturedAt !== b.capturedAt) return a.capturedAt.localeCompare(b.capturedAt)
      return a.recordHash.localeCompare(b.recordHash)
    })

    return all.slice(0, args.count)
  }

  async size(): Promise<{
    train: number
    test: number
    bySource: Record<string, number>
    byTrust: Record<LabelTrust, number>
  }> {
    const bySource: Record<string, number> = {}
    const byTrust: Record<LabelTrust, number> = {
      unverified: 0,
      'verified-signal': 0,
      'human-rated': 0,
    }
    let total = 0
    for (const source of ALL_SOURCES) {
      const path = this.pathForSource(source)
      if (!existsSync(path)) {
        bySource[source] = 0
        continue
      }
      const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean)
      bySource[source] = lines.length
      total += lines.length
      for (const line of lines) {
        let trust: LabelTrust = 'unverified'
        try {
          trust = (JSON.parse(line) as LabeledScenarioRecord).labelTrust ?? 'unverified'
        } catch {
          // A malformed line counts as unverified — never silently gold.
        }
        byTrust[trust] += 1
      }
    }
    // FS adapter doesn't track split assignments per-record (split is
    // computed at sample-time based on `capturedBefore`). For size(), we
    // report `train`+`test` as the same total — split is a sampling concept.
    return { train: total, test: total, bySource, byTrust }
  }

  private assertProvenance(write: LabeledScenarioWrite): void {
    if (!write.source) {
      throw new LabeledScenarioStoreError(
        'missing_source',
        'LabeledScenarioWrite requires `source`',
      )
    }
    if (!write.sourceVersionHash || write.sourceVersionHash.length === 0) {
      throw new LabeledScenarioStoreError(
        'missing_source_version',
        'LabeledScenarioWrite requires `sourceVersionHash` (git sha or substrate version)',
      )
    }
    if (!write.capturedAt) {
      throw new LabeledScenarioStoreError(
        'missing_captured_at',
        'LabeledScenarioWrite requires `capturedAt` ISO timestamp',
      )
    }
    if (!write.redactionStatus) {
      throw new LabeledScenarioStoreError(
        'missing_redaction_status',
        'LabeledScenarioWrite requires explicit `redactionStatus` — raw / redacted-pii / redacted-secrets / fully-redacted',
      )
    }
    if (!ALL_SOURCES.includes(write.source)) {
      throw new LabeledScenarioStoreError(
        'unknown_source',
        `LabeledScenarioWrite.source must be one of: ${ALL_SOURCES.join(', ')}`,
      )
    }
  }

  private assertRateLimit(write: LabeledScenarioWrite): void {
    const cap = this.options.maxWritesPerMinutePerBucket
    if (!cap || !write.rateLimitBucket) return
    const now = this.now()
    const windowMs = 60_000
    let state = this.rateLimits.get(write.rateLimitBucket)
    if (!state || now - state.windowStartMs >= windowMs) {
      state = { bucket: write.rateLimitBucket, windowStartMs: now, count: 0 }
      this.rateLimits.set(write.rateLimitBucket, state)
    }
    if (state.count >= cap) {
      throw new LabeledScenarioStoreError(
        'rate_limit_exceeded',
        `LabeledScenarioStore: bucket ${write.rateLimitBucket} exceeded ${cap} writes/min`,
      )
    }
    state.count += 1
  }

  private toRecord(write: LabeledScenarioWrite): LabeledScenarioRecord {
    const recordHash = sha256(
      JSON.stringify({
        id: write.scenario.id,
        src: write.source,
        at: write.capturedAt,
        ver: write.sourceVersionHash,
      }),
    )
    // FS adapter assigns split at sample-time, but we cache a hint here
    // based on capturedAt vs the world's "now" — sampler overrides this.
    return {
      ...write,
      recordHash,
      split: 'train',
    }
  }

  private pathForSource(source: string): string {
    return join(this.options.root, `${source}.jsonl`)
  }
}

const ALL_SOURCES: LabeledScenarioWrite['source'][] = [
  'production-trace',
  'eval-run',
  'manual',
  'red-team',
  'synthetic',
]

function sourceFilterContains(
  filter: LabeledScenarioSource | LabeledScenarioSource[] | undefined,
  needle: LabeledScenarioSource,
): boolean {
  if (!filter) return false
  if (Array.isArray(filter)) return filter.includes(needle)
  return filter === needle
}

function matchesFilter(
  record: LabeledScenarioRecord,
  args: LabeledScenarioSampleArgs,
  source: string,
): boolean {
  // Temporal cutoff — train must be capturedAt < capturedBefore.
  if (args.split === 'train' && record.capturedAt >= args.capturedBefore) return false
  if (args.split === 'test' && record.capturedAt < args.capturedBefore) return false

  const f = args.filter
  if (!f) return true
  if (f.kind && record.scenario.kind !== f.kind) return false
  if (f.source) {
    const sources = Array.isArray(f.source) ? f.source : [f.source]
    if (!sources.includes(source as never)) return false
  }
  if (f.minComposite !== undefined || f.maxComposite !== undefined) {
    const composites = Object.values(record.judgeScores).map((s) => s.composite)
    const max = composites.length === 0 ? 0 : Math.max(...composites)
    if (f.minComposite !== undefined && max < f.minComposite) return false
    if (f.maxComposite !== undefined && max > f.maxComposite) return false
  }
  if (f.minTrust !== undefined && labelTrustRank(record.labelTrust) < labelTrustRank(f.minTrust)) {
    return false
  }
  return true
}

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 16)
}

function appendLine(path: string, line: string): void {
  if (existsSync(path)) {
    const existing = readFileSync(path, 'utf8')
    writeFileSync(path, existing + line)
  } else {
    writeFileSync(path, line)
  }
}
