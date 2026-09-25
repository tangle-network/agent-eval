/**
 * TraceEmitter — hierarchical span builder for one Run. Emitters do NOT
 * share state.
 *
 * Parenting. A new span's parent is, in order: the explicit `parentSpanId`,
 * the innermost handle still open in the current async context, then the span
 * of the enclosing `within`. `within` runs its callback in an async context of
 * its own, so parallel `within` calls each parent their own children with no
 * ids passed by hand. Handles from `span`/`llm`/`tool`/`retrieval`/`sandbox`
 * nest by call order inside one async context; open parallel work with
 * `within`, or pass `parentSpanId`.
 *
 * Capture never throws into the traced run. A store write that fails is
 * counted as dropped, handed to `onCaptureError`, and the counts are written
 * onto the Run as `capture` when it ends, where `assertRunCaptured` reads them.
 * A Run whose records are incomplete therefore says so instead of reading as a
 * shorter run.
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { newRecordId } from '../record-id'
import type {
  Artifact,
  BudgetLedgerEntry,
  EventKind,
  JudgeSpan,
  LlmSpan,
  RetrievalSpan,
  Run,
  RunCaptureReport,
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

export interface RunCompleteHookContext {
  runId: string
  emitter: TraceEmitter
  store: TraceStore
  /** Outcome the caller passed to `endRun` (undefined for `abortRun`). */
  outcome?: RunOutcome
  /** Final run status. */
  status: 'completed' | 'failed' | 'aborted'
}

export type RunCompleteHook = (ctx: RunCompleteHookContext) => Promise<void> | void

/** The store write that failed, for `onCaptureError`. */
export type CaptureWrite =
  | 'appendRun'
  | 'updateRun'
  | 'appendSpan'
  | 'updateSpan'
  | 'appendEvent'
  | 'appendBudgetEntry'
  | 'appendArtifact'

export type CaptureErrorHandler = (error: unknown, write: CaptureWrite) => void

/** Parent state for one async context: open handles, then the enclosing `within` span. */
interface ParentFrame {
  parentSpanId: string | undefined
  open: string[]
}

export interface TraceEmitterOptions {
  runId?: string
  /** Inject a clock for deterministic tests. */
  now?: () => number
  /** Inject an id generator for deterministic tests. */
  id?: () => string
  /**
   * Hooks fired after `endRun` / `abortRun` writes the final run state.
   * Designed for trace-analyst auto-execution, integrity assertions, and
   * outbound notifications. Hooks run sequentially in the order supplied.
   *
   * By default a hook that throws is swallowed and logged as a `note` event
   * on the run — auto-orchestration must not crash the underlying flow.
   * Set `hookErrors: 'throw'` to propagate.
   */
  onRunComplete?: RunCompleteHook[]
  /** `'swallow'` (default) | `'throw'`. */
  hookErrors?: 'swallow' | 'throw'
  /**
   * Called once per failed store write. The write is already counted as
   * dropped; the handler reports it. Default: one process warning per emitter
   * (code `AGENT_EVAL_TRACE_CAPTURE`) on the first failure. A handler that
   * throws is ignored, because reporting must not break the traced run either.
   */
  onCaptureError?: CaptureErrorHandler
}

export class TraceEmitter {
  private store: TraceStore
  private readonly context = new AsyncLocalStorage<ParentFrame>()
  private readonly rootFrame: ParentFrame = { parentSpanId: undefined, open: [] }
  private _runId: string
  private now: () => number
  private id: () => string
  private hooks: RunCompleteHook[]
  private hookErrors: 'swallow' | 'throw'
  private onCaptureError: CaptureErrorHandler
  private capture: RunCaptureReport = { written: 0, dropped: 0 }

  constructor(store: TraceStore, options: TraceEmitterOptions = {}) {
    this.store = store
    this.now = options.now ?? (() => Date.now())
    this.id = options.id ?? (() => newRecordId())
    this._runId = options.runId ?? this.id()
    this.hooks = options.onRunComplete ?? []
    this.hookErrors = options.hookErrors ?? 'swallow'
    this.onCaptureError = options.onCaptureError ?? warnOnFirstCaptureError(this._runId)
  }

  get runId(): string {
    return this._runId
  }

  get traceStore(): TraceStore {
    return this.store
  }

  /** Store writes so far: how many landed, how many were dropped, and the last failure. */
  captureStats(): RunCaptureReport {
    return { ...this.capture }
  }

  /** The span a new span would be parented to in the current async context. */
  currentSpanId(): string | undefined {
    const frame = this.frame()
    return frame.open[frame.open.length - 1] ?? frame.parentSpanId
  }

  private frame(): ParentFrame {
    return this.context.getStore() ?? this.rootFrame
  }

  private async write(write: CaptureWrite, fn: () => Promise<unknown>): Promise<boolean> {
    try {
      await fn()
      this.capture.written += 1
      return true
    } catch (error) {
      this.capture.dropped += 1
      this.capture.lastError = `${write}: ${error instanceof Error ? error.message : String(error)}`
      try {
        this.onCaptureError(error, write)
      } catch {
        // A failing reporter must not reach the traced run.
      }
      return false
    }
  }

  /** Append a hook after construction (e.g. attach the trace analyst). */
  addRunCompleteHook(hook: RunCompleteHook): void {
    this.hooks.push(hook)
  }

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
    const scenarioId = run.scenarioId ?? run.layer ?? run.tags?.kind ?? 'runtime'
    const full: Run = {
      ...run,
      scenarioId,
      runId: this._runId,
      startedAt: this.now(),
      status: 'running',
    }
    await this.write('appendRun', () => this.store.appendRun(full))
    return full
  }

  /**
   * End the Run. The final record carries `capture`: the store writes made
   * before it and how many were dropped.
   */
  async endRun(outcome?: RunOutcome): Promise<void> {
    const status: 'completed' | 'failed' = outcome?.pass === false ? 'failed' : 'completed'
    const capture = this.captureStats()
    await this.write('updateRun', () =>
      this.store.updateRun(this._runId, { endedAt: this.now(), status, outcome, capture }),
    )
    await this.runHooks({ runId: this._runId, emitter: this, store: this.store, outcome, status })
  }

  async abortRun(reason: string): Promise<void> {
    const outcome = { pass: false, notes: reason }
    const capture = this.captureStats()
    await this.write('updateRun', () =>
      this.store.updateRun(this._runId, {
        endedAt: this.now(),
        status: 'aborted',
        outcome,
        capture,
      }),
    )
    await this.runHooks({
      runId: this._runId,
      emitter: this,
      store: this.store,
      outcome,
      status: 'aborted',
    })
  }

  private async runHooks(ctx: RunCompleteHookContext): Promise<void> {
    for (const hook of this.hooks) {
      try {
        await hook(ctx)
      } catch (err) {
        if (this.hookErrors === 'throw') throw err
        await this.write('appendEvent', () =>
          this.store.appendEvent({
            eventId: this.id(),
            runId: this._runId,
            kind: 'log',
            timestamp: this.now(),
            payload: {
              source: 'run_complete_hook',
              error: err instanceof Error ? err.message : String(err),
            },
          }),
        )
      }
    }
  }

  // ── Generic span ───────────────────────────────────────────────────

  async span<S extends Span = Span>(
    init: {
      kind: SpanKind
      name: string
      parentSpanId?: string
      attributes?: Record<string, unknown>
    } & Partial<Omit<S, 'spanId' | 'runId' | 'startedAt' | 'kind' | 'name'>>,
  ): Promise<SpanHandle<S>> {
    return this.open<S>(init, this.frame())
  }

  /**
   * Create a span parented in the current async context. `frame` is the
   * context the handle stays open in, or null for a `within` span, which
   * parents its children through its own context instead.
   */
  private async open<S extends Span>(
    init: { kind: SpanKind; name: string; parentSpanId?: string },
    frame: ParentFrame | null,
  ): Promise<SpanHandle<S>> {
    const spanId = this.id()
    const parent = init.parentSpanId ?? this.currentSpanId()
    const span = {
      spanId,
      runId: this._runId,
      startedAt: this.now(),
      ...init,
      parentSpanId: parent,
    } as unknown as S
    frame?.open.push(spanId)
    await this.write('appendSpan', () => this.store.appendSpan(span))
    return this.handle<S>(span, frame)
  }

  private handle<S extends Span>(span: S, frame: ParentFrame | null): SpanHandle<S> {
    const close = () => {
      if (!frame) return
      const idx = frame.open.lastIndexOf(span.spanId)
      if (idx >= 0) frame.open.splice(idx, 1)
    }
    return {
      span,
      end: async (patch?: Partial<S>) => {
        const endedAt = this.now()
        close()
        await this.write('updateSpan', () =>
          this.store.updateSpan(span.spanId, {
            endedAt,
            status: 'ok',
            ...patch,
          } as Partial<Span>),
        )
      },
      fail: async (error: string | Error, patch?: Partial<S>) => {
        const endedAt = this.now()
        const errStr = error instanceof Error ? error.message : error
        close()
        await this.write('updateSpan', () =>
          this.store.updateSpan(span.spanId, {
            endedAt,
            status: 'error',
            error: errStr,
            ...patch,
          } as Partial<Span>),
        )
      },
    }
  }

  // ── Typed span conveniences ────────────────────────────────────────

  llm(
    init: Omit<LlmSpan, 'spanId' | 'runId' | 'kind' | 'startedAt'>,
  ): Promise<SpanHandle<LlmSpan>> {
    return this.span<LlmSpan>({ kind: 'llm', ...init })
  }

  tool(
    init: Omit<ToolSpan, 'spanId' | 'runId' | 'kind' | 'startedAt'>,
  ): Promise<SpanHandle<ToolSpan>> {
    return this.span<ToolSpan>({ kind: 'tool', ...init })
  }

  retrieval(
    init: Omit<RetrievalSpan, 'spanId' | 'runId' | 'kind' | 'startedAt'>,
  ): Promise<SpanHandle<RetrievalSpan>> {
    return this.span<RetrievalSpan>({ kind: 'retrieval', ...init })
  }

  async recordJudge(
    verdict: Omit<JudgeSpan, 'spanId' | 'runId' | 'kind' | 'startedAt' | 'endedAt'>,
  ): Promise<JudgeSpan> {
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
    await this.write('appendSpan', () => this.store.appendSpan(full))
    return full
  }

  sandbox(
    init: Omit<SandboxSpan, 'spanId' | 'runId' | 'kind' | 'startedAt'>,
  ): Promise<SpanHandle<SandboxSpan>> {
    return this.span<SandboxSpan>({ kind: 'sandbox', ...init })
  }

  // ── Events ─────────────────────────────────────────────────────────

  async emit(event: {
    kind: EventKind
    spanId?: string
    payload?: Record<string, unknown>
  }): Promise<TraceEvent> {
    const full: TraceEvent = {
      eventId: this.id(),
      runId: this._runId,
      spanId: event.spanId ?? this.currentSpanId(),
      kind: event.kind,
      timestamp: this.now(),
      payload: event.payload ?? {},
    }
    await this.write('appendEvent', () => this.store.appendEvent(full))
    return full
  }

  // ── Budget ledger ──────────────────────────────────────────────────

  async recordBudget(
    entry: Omit<BudgetLedgerEntry, 'runId' | 'timestamp'> & { timestamp?: number },
  ): Promise<BudgetLedgerEntry> {
    const full: BudgetLedgerEntry = {
      runId: this._runId,
      timestamp: entry.timestamp ?? this.now(),
      dimension: entry.dimension,
      limit: entry.limit,
      consumed: entry.consumed,
      remaining: entry.remaining,
      breached: entry.breached,
      spanId: entry.spanId ?? this.currentSpanId(),
    }
    await this.write('appendBudgetEntry', () => this.store.appendBudgetEntry(full))
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
    await this.write('appendArtifact', () => this.store.appendArtifact(full))
    return full
  }

  // ── Nested composition ─────────────────────────────────────────────

  /**
   * Runs `fn` inside a span; auto-ends on success, auto-fails on throw.
   * Returns the fn's return value. Use this for the 95% case.
   *
   * `fn` runs in an async context of its own, so spans it opens are parented
   * to this span even while sibling `within` calls run in parallel.
   */
  async within<T>(
    init: Parameters<TraceEmitter['span']>[0],
    fn: (handle: SpanHandle) => Promise<T>,
  ): Promise<T> {
    const handle = await this.open<Span>(init, null)
    const frame: ParentFrame = { parentSpanId: handle.span.spanId, open: [] }
    try {
      const result = await this.context.run(frame, () => fn(handle))
      await handle.end()
      return result
    } catch (err) {
      await handle.fail(err instanceof Error ? err : String(err))
      throw err
    }
  }
}

// Helpers -------------------------------------------------------------

function warnOnFirstCaptureError(runId: string): CaptureErrorHandler {
  let warned = false
  return (error, write) => {
    if (warned) return
    warned = true
    const reason = error instanceof Error ? error.message : String(error)
    globalThis.process?.emitWarning?.(
      `TraceEmitter run ${runId}: ${write} failed (${reason}); this and later failed writes are counted in the run's capture report.`,
      { code: 'AGENT_EVAL_TRACE_CAPTURE' },
    )
  }
}
