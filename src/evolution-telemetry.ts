/**
 * evolution-telemetry — durable JSONL/JSON sinks for the evolution loop.
 *
 * `runPromptEvolution` exposes generation-level events but doesn't persist
 * the per-mutation, per-trial, lineage, or cost breakdown. These four
 * sinks fill that gap so a finished autoresearch run leaves a forensically
 * complete trail under one directory:
 *
 *   - `mutations.jsonl` — every mutate attempt (success + failure) with
 *     latency, agent steps, diff stats, cost.
 *   - `trials.jsonl` — every TrialResult including cache hits, with
 *     provenance (channel, runtime slot, generation).
 *   - `lineage.json` — variant tree {id → {parent, generation, kind, …}},
 *     incremental upsert.
 *   - `cost-ledger.json` — running $ totals per source (mutator-prompt,
 *     mutator-code, scorer-prompt, scorer-code) plus pool utilisation.
 *
 * All writes are mutex-serialised. The append-only sinks (mutations,
 * trials) survive a hard kill; the snapshot sinks (lineage, cost-ledger)
 * rewrite on every update so the latest state is always on disk.
 *
 * Generic over a payload P so any consumer of `runPromptEvolution<P>` can
 * record lineage without leaking domain types.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { Mutex } from './concurrency'
import { LockedJsonlAppender } from './locked-jsonl-appender'
import type { PromptVariant } from './prompt-evolution'

// ─── mutation telemetry ──────────────────────────────────────────────────

export type MutationChannel = 'prompt' | 'code'

export interface MutationAttempt {
  ts: number
  channel: MutationChannel
  generation: number
  parentId: string
  /** Successful child variant id, or null if the attempt failed. */
  childId: string | null
  ok: boolean
  /**
   * One of: 'parse_failure' | 'typecheck_failure' | 'no_changes' |
   * 'agent_error' | 'commit_failure' | 'no_api_key' | 'no_valid_proposals'
   * | 'reproduce_parent_failed' | 'branch_failed' | 'other'.
   * Free-form to allow consumer-specific reasons.
   */
  failureReason?: string
  /** Free-form description of what the agent said it did. */
  description?: string
  /** Latency of the LLM call (ms). */
  latencyMs: number
  /** Bytes of generated diff (code channel only). */
  diffBytes?: number
  /** Files touched (code channel only). */
  filesTouched?: number
  /** Steps the agent ran (tool calls). */
  agentSteps?: number
  /** Approx $ spent on this mutation (LLM tokens). */
  costUsd?: number
  /** Runtime slot used (code channel only). */
  runtimeSandboxId?: string
}

export class MutationTelemetry {
  private readonly appender: LockedJsonlAppender
  constructor(path: string) {
    this.appender = new LockedJsonlAppender(path)
  }
  async record(attempt: MutationAttempt): Promise<void> {
    await this.appender.append(attempt)
  }
}

// ─── trial telemetry ─────────────────────────────────────────────────────

export interface TrialAttempt {
  ts: number
  channel: MutationChannel
  generation: number
  variantId: string
  scenarioId: string
  rep: number
  ok: boolean
  score: number
  costUsd: number
  durationMs: number
  cached: boolean
  runtimeSandboxId?: string
  error?: string
  metrics?: Record<string, number>
}

export class TrialTelemetry {
  private readonly appender: LockedJsonlAppender
  constructor(path: string) {
    this.appender = new LockedJsonlAppender(path)
  }
  async record(attempt: TrialAttempt): Promise<void> {
    await this.appender.append(attempt)
  }
}

// ─── lineage ─────────────────────────────────────────────────────────────

export type LineageKind = 'seed' | 'prompt' | 'code'

export interface LineageNode {
  id: string
  parentId: string | null
  generation: number
  kind: LineageKind
  rationale?: string
  /** Filled when scoring lands. */
  meanScore?: number
  promotedToFrontier?: boolean
}

/**
 * `kindOf` decides whether a variant is a seed (no parent), code mutation,
 * or prompt mutation. Default looks at `variant.payload.codeMutation` —
 * that field is part of the audit-bench convention but cheap enough to
 * accept any payload that mirrors it. Override by passing your own.
 */
export type LineageKindResolver<P> = (variant: PromptVariant<P>) => LineageKind

/**
 * Persistence shape:
 *
 *   `<path>`           — JSONL of upserts (event log). Each line is a
 *                        partial node; replay folds them into the current
 *                        state. Append-only, so cost is O(1) per upsert
 *                        instead of the previous O(n²) full rewrite.
 *   `<path>.snapshot`  — Optional consolidated snapshot, written on
 *                        demand via `compact()` (e.g. at end of run).
 *                        Read by external tools that don't want to
 *                        replay the log.
 *
 * Loaded at construction time: if `<path>.snapshot` exists, parse it
 * first; then replay any newer log lines on top. Falls back to log-only
 * when no snapshot is present.
 */
export class LineageRecorder<P = unknown> {
  private readonly path: string
  private readonly snapshotPath: string
  private readonly mutex = new Mutex()
  private readonly nodes: Map<string, LineageNode> = new Map()
  private readonly kindOf: LineageKindResolver<P>

  constructor(path: string, kindOf?: LineageKindResolver<P>) {
    this.path = path
    this.snapshotPath = `${path}.snapshot`
    this.kindOf = kindOf ?? defaultKindOf<P>
    mkdirSync(dirname(path), { recursive: true })

    // 1. Load consolidated snapshot if present.
    if (existsSync(this.snapshotPath)) {
      try {
        const parsed = JSON.parse(readFileSync(this.snapshotPath, 'utf-8')) as LineageNode[]
        for (const n of parsed) this.nodes.set(n.id, n)
      } catch {
        // tolerate corrupt snapshot; the log replay below covers it.
      }
    }

    // 2. Replay event log (newer writes override snapshot state).
    if (existsSync(path)) {
      try {
        for (const line of readFileSync(path, 'utf-8').split('\n')) {
          if (!line.trim()) continue
          try {
            const entry = JSON.parse(line) as LineageNode
            const prev = this.nodes.get(entry.id)
            this.nodes.set(entry.id, { ...prev, ...entry })
          } catch {
            // skip torn/partial lines (hard-kill tail).
          }
        }
      } catch {
        // unreadable log → start fresh; snapshot state remains.
      }
    }

    // Back-compat: if the file at `path` is a JSON ARRAY (from the old
    // snapshot-on-every-upsert format), load it as the seed snapshot
    // and convert. The next upsert will start the new event log.
    if (existsSync(path) && this.nodes.size === 0) {
      try {
        const raw = readFileSync(path, 'utf-8').trim()
        if (raw.startsWith('[')) {
          const parsed = JSON.parse(raw) as LineageNode[]
          for (const n of parsed) this.nodes.set(n.id, n)
          // Truncate the legacy array file by writing a snapshot and
          // resetting the log on first upsert. Defer the rewrite — we
          // don't want construction to do disk I/O on the happy path.
        }
      } catch {
        // ignore.
      }
    }
  }

  async upsert(node: LineageNode): Promise<void> {
    await this.mutex.runExclusive(() => {
      const prev = this.nodes.get(node.id)
      this.nodes.set(node.id, { ...prev, ...node })
      // Append to event log. Snapshot is rewritten only on compact().
      // Fall back to a fresh log file if it currently holds a legacy
      // JSON array (see back-compat note above).
      try {
        if (existsSync(this.path)) {
          const head = readFileSync(this.path, { encoding: 'utf-8', flag: 'r' }).slice(0, 1)
          if (head === '[') {
            // Legacy array file — replace with event log starting fresh.
            writeFileSync(this.path, '')
          }
        }
      } catch {
        // unreadable: just start writing.
      }
      appendFileSync(this.path, `${JSON.stringify(this.nodes.get(node.id))}\n`)
    })
  }

  async upsertVariant(variant: PromptVariant<P>): Promise<void> {
    await this.upsert({
      id: variant.id,
      parentId: variant.parentId ?? null,
      generation: variant.generation,
      kind: this.kindOf(variant),
      ...(variant.rationale ? { rationale: variant.rationale } : {}),
    })
  }

  snapshot(): LineageNode[] {
    return [...this.nodes.values()]
  }

  /**
   * Write the current consolidated state to `<path>.snapshot` so external
   * tools can read it without replaying the event log. Idempotent.
   */
  async compact(): Promise<void> {
    await this.mutex.runExclusive(() => {
      writeFileSync(this.snapshotPath, JSON.stringify([...this.nodes.values()], null, 2))
    })
  }
}

function defaultKindOf<P>(variant: PromptVariant<P>): LineageKind {
  if (variant.parentId === undefined) return 'seed'
  const payload = variant.payload as { codeMutation?: unknown } | null | undefined
  if (payload && typeof payload === 'object' && payload.codeMutation) return 'code'
  return 'prompt'
}

// ─── cost ledger ─────────────────────────────────────────────────────────

/** Per-generation cost rollup. Same shape as the totals, scoped to one gen. */
export interface CostLedgerGeneration {
  generation: number
  mutatorPromptUsd: number
  mutatorCodeUsd: number
  scorerPromptUsd: number
  scorerCodeUsd: number
  trialsCounted: number
  cachedTrials: number
}

export interface CostLedgerSnapshot {
  totalUsd: number
  mutatorPromptUsd: number
  mutatorCodeUsd: number
  scorerPromptUsd: number
  scorerCodeUsd: number
  trialsCounted: number
  cachedTrials: number
  poolBusyMs?: number
  poolUtilizationPct?: number
  /** Per-generation breakdown, sorted ascending. Empty when generations
   *  weren't supplied to addMutation/addTrial. */
  byGeneration: CostLedgerGeneration[]
}

interface CostLedgerState {
  mutatorPromptUsd: number
  mutatorCodeUsd: number
  scorerPromptUsd: number
  scorerCodeUsd: number
  trialsCounted: number
  cachedTrials: number
  poolBusyMs: number
  poolUtilizationPct: number
  /** Generation-keyed accumulators. Keys are `${generation}` so it
   *  serialises cleanly to JSON. */
  byGeneration: Record<string, Omit<CostLedgerGeneration, 'generation'>>
}

function emptyGenBucket(): Omit<CostLedgerGeneration, 'generation'> {
  return {
    mutatorPromptUsd: 0,
    mutatorCodeUsd: 0,
    scorerPromptUsd: 0,
    scorerCodeUsd: 0,
    trialsCounted: 0,
    cachedTrials: 0,
  }
}

export class CostLedger {
  private totals: CostLedgerState = {
    mutatorPromptUsd: 0,
    mutatorCodeUsd: 0,
    scorerPromptUsd: 0,
    scorerCodeUsd: 0,
    trialsCounted: 0,
    cachedTrials: 0,
    poolBusyMs: 0,
    poolUtilizationPct: 0,
    byGeneration: {},
  }
  private readonly path: string
  private readonly mutex = new Mutex()

  constructor(path: string) {
    this.path = path
    if (existsSync(path)) {
      try {
        const loaded = JSON.parse(readFileSync(path, 'utf-8')) as Partial<CostLedgerState>
        // Overlay only known keys; ignore unknown ones from older versions.
        for (const k of Object.keys(this.totals) as (keyof CostLedgerState)[]) {
          if (k === 'byGeneration') {
            if (loaded.byGeneration && typeof loaded.byGeneration === 'object') {
              this.totals.byGeneration = loaded.byGeneration
            }
            continue
          }
          const v = loaded[k]
          if (typeof v === 'number' && Number.isFinite(v)) {
            (this.totals as unknown as Record<string, number>)[k] = v
          }
        }
      } catch {
        // corrupt → start fresh.
      }
    } else {
      mkdirSync(dirname(path), { recursive: true })
    }
  }

  private genBucket(generation: number | undefined): Omit<CostLedgerGeneration, 'generation'> | null {
    if (generation === undefined) return null
    const key = String(generation)
    if (!this.totals.byGeneration[key]) {
      this.totals.byGeneration[key] = emptyGenBucket()
    }
    return this.totals.byGeneration[key]
  }

  async addMutation(
    channel: MutationChannel,
    usd: number,
    opts: { generation?: number } = {},
  ): Promise<void> {
    await this.mutex.runExclusive(() => {
      const bucket = this.genBucket(opts.generation)
      if (channel === 'prompt') {
        this.totals.mutatorPromptUsd += usd
        if (bucket) bucket.mutatorPromptUsd += usd
      } else {
        this.totals.mutatorCodeUsd += usd
        if (bucket) bucket.mutatorCodeUsd += usd
      }
      this.persist()
    })
  }

  async addTrial(
    channel: MutationChannel,
    usd: number,
    cached: boolean,
    opts: { generation?: number } = {},
  ): Promise<void> {
    await this.mutex.runExclusive(() => {
      const bucket = this.genBucket(opts.generation)
      if (cached) {
        this.totals.cachedTrials++
        this.totals.trialsCounted++
        if (bucket) {
          bucket.cachedTrials++
          bucket.trialsCounted++
        }
        this.persist()
        return
      }
      if (channel === 'prompt') {
        this.totals.scorerPromptUsd += usd
        if (bucket) bucket.scorerPromptUsd += usd
      } else {
        this.totals.scorerCodeUsd += usd
        if (bucket) bucket.scorerCodeUsd += usd
      }
      this.totals.trialsCounted++
      if (bucket) bucket.trialsCounted++
      this.persist()
    })
  }

  async setPoolUtilization(busyMs: number, totalMs: number): Promise<void> {
    await this.mutex.runExclusive(() => {
      this.totals.poolBusyMs = busyMs
      this.totals.poolUtilizationPct = totalMs > 0 ? (100 * busyMs) / totalMs : 0
      this.persist()
    })
  }

  snapshot(): CostLedgerSnapshot {
    const totalUsd =
      this.totals.mutatorPromptUsd +
      this.totals.mutatorCodeUsd +
      this.totals.scorerPromptUsd +
      this.totals.scorerCodeUsd
    const byGeneration = Object.entries(this.totals.byGeneration)
      .map(([g, b]) => ({ generation: Number(g), ...b }))
      .sort((a, b) => a.generation - b.generation)
    return {
      totalUsd,
      mutatorPromptUsd: this.totals.mutatorPromptUsd,
      mutatorCodeUsd: this.totals.mutatorCodeUsd,
      scorerPromptUsd: this.totals.scorerPromptUsd,
      scorerCodeUsd: this.totals.scorerCodeUsd,
      trialsCounted: this.totals.trialsCounted,
      cachedTrials: this.totals.cachedTrials,
      poolBusyMs: this.totals.poolBusyMs,
      poolUtilizationPct: this.totals.poolUtilizationPct,
      byGeneration,
    }
  }

  private persist(): void {
    writeFileSync(this.path, JSON.stringify(this.totals, null, 2))
  }
}
