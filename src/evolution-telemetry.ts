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

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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

export class LineageRecorder<P = unknown> {
  private readonly path: string
  private readonly mutex = new Mutex()
  private readonly nodes: Map<string, LineageNode> = new Map()
  private readonly kindOf: LineageKindResolver<P>

  constructor(path: string, kindOf?: LineageKindResolver<P>) {
    this.path = path
    this.kindOf = kindOf ?? defaultKindOf<P>
    if (existsSync(path)) {
      try {
        const parsed = JSON.parse(readFileSync(path, 'utf-8')) as LineageNode[]
        for (const n of parsed) this.nodes.set(n.id, n)
      } catch {
        // tolerate corrupt legacy files; start fresh.
      }
    } else {
      mkdirSync(dirname(path), { recursive: true })
    }
  }

  async upsert(node: LineageNode): Promise<void> {
    await this.mutex.runExclusive(() => {
      const prev = this.nodes.get(node.id)
      this.nodes.set(node.id, { ...prev, ...node })
      writeFileSync(this.path, JSON.stringify([...this.nodes.values()], null, 2))
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
}

function defaultKindOf<P>(variant: PromptVariant<P>): LineageKind {
  if (variant.parentId === undefined) return 'seed'
  const payload = variant.payload as { codeMutation?: unknown } | null | undefined
  if (payload && typeof payload === 'object' && payload.codeMutation) return 'code'
  return 'prompt'
}

// ─── cost ledger ─────────────────────────────────────────────────────────

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
          const v = loaded[k]
          if (typeof v === 'number' && Number.isFinite(v)) this.totals[k] = v
        }
      } catch {
        // corrupt → start fresh.
      }
    } else {
      mkdirSync(dirname(path), { recursive: true })
    }
  }

  async addMutation(channel: MutationChannel, usd: number): Promise<void> {
    await this.mutex.runExclusive(() => {
      if (channel === 'prompt') this.totals.mutatorPromptUsd += usd
      else this.totals.mutatorCodeUsd += usd
      this.persist()
    })
  }

  async addTrial(channel: MutationChannel, usd: number, cached: boolean): Promise<void> {
    await this.mutex.runExclusive(() => {
      if (cached) {
        this.totals.cachedTrials++
        this.totals.trialsCounted++
        this.persist()
        return
      }
      if (channel === 'prompt') this.totals.scorerPromptUsd += usd
      else this.totals.scorerCodeUsd += usd
      this.totals.trialsCounted++
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
    return { totalUsd, ...this.totals }
  }

  private persist(): void {
    writeFileSync(this.path, JSON.stringify(this.totals, null, 2))
  }
}
