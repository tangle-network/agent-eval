/**
 * TraceEmitter — hierarchical span builder that auto-parents using an
 * internal stack. One emitter per Run; emitters do NOT share state.
 *
 * Convenience methods (`llm`, `tool`, `retrieval`, `judge`, `sandbox`)
 * return a `SpanHandle` with `.end()` / `.fail()` so callers don't
 * have to thread spanIds manually. For async workflows that can't use
 * the stack (e.g. fan-out parallel calls), pass `parentSpanId`
 * explicitly.
 */

import type {
  Artifact,
  BudgetLedgerEntry,
  EventKind,
  JudgeSpan,
  LlmSpan,
  Message,
  RetrievalSpan,
  Run,
  RunOutcome,
  SandboxSpan,
  Span,
  SpanKind,
  ToolSpan,
  TraceEvent,
} from './schema'
import type { TraceStore } from './store'

export interface SpanHandle<S extends Span = Span> {
  span: S
  end(patch?: Partial<S>): Promise<void>
  fail(error: string | Error, patch?: Partial<S>): Promise<void>
}

export interface TraceEmitterOptions {
  runId?: string
  /** Inject a clock for deterministic tests. */
  now?: () => number
  /** Inject an id generator for deterministic tests. */
  id?: () => string
}

export class TraceEmitter {
  private store: TraceStore
  private stack: string[] = []
  private _runId: string
  private now: () => number
  private id: () => string

  constructor(store: TraceStore, options: TraceEmitterOptions = {}) {
    this.store = store
    this.now = options.now ?? (() => Date.now())
    this.id = options.id ?? (() => cryptoRandomId())
    this._runId = options.runId ?? this.id()
  }

  get runId(): string { return this._runId }

  // ── Run lifecycle ──────────────────────────────────────────────────

  /**
   * Begin a Run.
   *
   * `scenarioId` is required on the persisted Run shape — every Run downstream
   * gets a non-empty scenarioId so filters and aggregations stay simple — but
   * the INPUT here accepts it as optional. When omitted, startRun substitutes
   * a sensible default (`run.layer ?? run.tags?.['kind'] ?? 'runtime'`) so
   * runtime / operator / meta-eval runs that have no curated-scenario corpus
   * to anchor to don't have to invent placeholder strings at the call site.
   */
  async startRun(
    run: Omit<Run, 'runId' | 'scenarioId' | 'startedAt' | 'status'> & { scenarioId?: string },
  ): Promise<Run> {
    const scenarioId =
      run.scenarioId ??
      run.layer ??
      run.tags?.['kind'] ??
      'runtime'
    const full: Run = {
      ...run,
      scenarioId,
      runId: this._runId,
      startedAt: this.now(),
      status: 'running',
    }
    await this.store.appendRun(full)
    return full
  }

  async endRun(outcome?: RunOutcome): Promise<void> {
    const status = outcome?.pass === false ? 'failed' : 'completed'
    await this.store.updateRun(this._runId, { endedAt: this.now(), status, outcome })
  }

  async abortRun(reason: string): Promise<void> {
    await this.store.updateRun(this._runId, {
      endedAt: this.now(),
      status: 'aborted',
      outcome: { pass: false, notes: reason },
    })
  }

  // ── Generic span ───────────────────────────────────────────────────

  async span<S extends Span = Span>(init: {
    kind: SpanKind
    name: string
    parentSpanId?: string
    attributes?: Record<string, unknown>
  } & Partial<Omit<S, 'spanId' | 'runId' | 'startedAt' | 'kind' | 'name'>>): Promise<SpanHandle<S>> {
    const spanId = this.id()
    const parent = init.parentSpanId ?? this.stack[this.stack.length - 1]
    const span = {
      spanId,
      parentSpanId: parent,
      runId: this._runId,
      startedAt: this.now(),
      ...init,
    } as unknown as S
    await this.store.appendSpan(span)
    this.stack.push(spanId)
    return this.handle<S>(span)
  }

  private handle<S extends Span>(span: S): SpanHandle<S> {
    return {
      span,
      end: async (patch?: Partial<S>) => {
        const endedAt = this.now()
        await this.store.updateSpan(span.spanId, { endedAt, status: 'ok', ...patch } as Partial<Span>)
        this.pop(span.spanId)
      },
      fail: async (error: string | Error, patch?: Partial<S>) => {
        const endedAt = this.now()
        const errStr = error instanceof Error ? error.message : error
        await this.store.updateSpan(span.spanId, {
          endedAt,
          status: 'error',
          error: errStr,
          ...patch,
        } as Partial<Span>)
        this.pop(span.spanId)
      },
    }
  }

  private pop(spanId: string): void {
    const idx = this.stack.lastIndexOf(spanId)
    if (idx >= 0) this.stack.splice(idx, 1)
  }

  // ── Typed span conveniences ────────────────────────────────────────

  llm(init: Omit<LlmSpan, 'spanId' | 'runId' | 'kind' | 'startedAt'>): Promise<SpanHandle<LlmSpan>> {
    return this.span<LlmSpan>({ kind: 'llm', ...init })
  }

  tool(init: Omit<ToolSpan, 'spanId' | 'runId' | 'kind' | 'startedAt'>): Promise<SpanHandle<ToolSpan>> {
    return this.span<ToolSpan>({ kind: 'tool', ...init })
  }

  retrieval(init: Omit<RetrievalSpan, 'spanId' | 'runId' | 'kind' | 'startedAt'>): Promise<SpanHandle<RetrievalSpan>> {
    return this.span<RetrievalSpan>({ kind: 'retrieval', ...init })
  }

  async recordJudge(verdict: Omit<JudgeSpan, 'spanId' | 'runId' | 'kind' | 'startedAt' | 'endedAt'>): Promise<JudgeSpan> {
    const spanId = this.id()
    const now = this.now()
    const full: JudgeSpan = {
      spanId,
      runId: this._runId,
      kind: 'judge',
      startedAt: now,
      endedAt: now,
      status: 'ok',
      ...verdict,
    }
    await this.store.appendSpan(full)
    return full
  }

  sandbox(init: Omit<SandboxSpan, 'spanId' | 'runId' | 'kind' | 'startedAt'>): Promise<SpanHandle<SandboxSpan>> {
    return this.span<SandboxSpan>({ kind: 'sandbox', ...init })
  }

  // ── Events ─────────────────────────────────────────────────────────

  async emit(event: { kind: EventKind; spanId?: string; payload?: Record<string, unknown> }): Promise<TraceEvent> {
    const full: TraceEvent = {
      eventId: this.id(),
      runId: this._runId,
      spanId: event.spanId ?? this.stack[this.stack.length - 1],
      kind: event.kind,
      timestamp: this.now(),
      payload: event.payload ?? {},
    }
    await this.store.appendEvent(full)
    return full
  }

  // ── Budget ledger ──────────────────────────────────────────────────

  async recordBudget(entry: Omit<BudgetLedgerEntry, 'runId' | 'timestamp'> & { timestamp?: number }): Promise<BudgetLedgerEntry> {
    const full: BudgetLedgerEntry = {
      runId: this._runId,
      timestamp: entry.timestamp ?? this.now(),
      dimension: entry.dimension,
      limit: entry.limit,
      consumed: entry.consumed,
      remaining: entry.remaining,
      breached: entry.breached,
      spanId: entry.spanId ?? this.stack[this.stack.length - 1],
    }
    await this.store.appendBudgetEntry(full)
    if (full.breached) {
      await this.emit({
        kind: 'budget_breach',
        spanId: full.spanId,
        payload: { dimension: full.dimension, limit: full.limit, consumed: full.consumed },
      })
    }
    return full
  }

  // ── Artifacts ──────────────────────────────────────────────────────

  async recordArtifact(artifact: Omit<Artifact, 'artifactId' | 'runId'>): Promise<Artifact> {
    const full: Artifact = { artifactId: this.id(), runId: this._runId, ...artifact }
    await this.store.appendArtifact(full)
    return full
  }

  // ── Nested composition ─────────────────────────────────────────────

  /**
   * Runs `fn` inside a span; auto-ends on success, auto-fails on throw.
   * Returns the fn's return value. Use this for the 95% case.
   */
  async within<T>(
    init: Parameters<TraceEmitter['span']>[0],
    fn: (handle: SpanHandle) => Promise<T>,
  ): Promise<T> {
    const handle = await this.span(init)
    try {
      const result = await fn(handle)
      await handle.end()
      return result
    } catch (err) {
      await handle.fail(err instanceof Error ? err : String(err))
      throw err
    }
  }
}

// Helpers -------------------------------------------------------------

function cryptoRandomId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID()
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/** Helper to build an LLM span handle args object from a provider-shaped response. */
export function llmSpanFromProvider(args: {
  name?: string
  model: string
  messages: Message[]
  output: string
  usage?: { inputTokens?: number; outputTokens?: number; cachedTokens?: number; reasoningTokens?: number }
  costUsd?: number
  finishReason?: string
}): Omit<LlmSpan, 'spanId' | 'runId' | 'kind' | 'startedAt'> {
  return {
    name: args.name ?? args.model,
    model: args.model,
    messages: args.messages,
    output: args.output,
    inputTokens: args.usage?.inputTokens,
    outputTokens: args.usage?.outputTokens,
    cachedTokens: args.usage?.cachedTokens,
    reasoningTokens: args.usage?.reasoningTokens,
    costUsd: args.costUsd,
    finishReason: args.finishReason,
  }
}
