/**
 * OTEL bridge — connects TraceEmitter span lifecycle to the OtelExporter.
 *
 * When an OtelExporter is active, every span that closes through the
 * TraceEmitter is also pushed to the exporter for real-time streaming to
 * the user's OTEL collector.
 *
 * The bridge is opt-in: attach via `otelRunCompleteHook(exporter)` as a
 * RunCompleteHook, or wrap the store with `createOtelTracingStore` for
 * real-time per-span export.
 */

import type { RunCompleteHook } from './emitter'
import type { OtelExporter, ExportableSpan } from './otel-export'
import type { TraceStore } from './store'
import type { LlmSpan, Span } from './schema'

/**
 * Create a RunCompleteHook that exports all spans from the completed run
 * to the OTEL exporter, then flushes.
 */
export function otelRunCompleteHook(exporter: OtelExporter): RunCompleteHook {
  return async (ctx) => {
    const spans = await ctx.store.spans({ runId: ctx.runId })
    for (const span of spans) {
      if (span.endedAt) {
        exporter.exportSpan(storeSpanToExportable(span, ctx.runId))
      }
    }
    await exporter.flush()
  }
}

/**
 * Create an auto-exporting TraceStore wrapper that intercepts updateSpan
 * calls. When a span gets an endedAt, it's exported immediately. This
 * gives real-time streaming instead of batch-at-end.
 *
 * This is the preferred integration path: wrap the store before
 * constructing the TraceEmitter.
 */
export function createOtelTracingStore(
  inner: TraceStore,
  exporter: OtelExporter,
  traceId: string,
): TraceStore {
  return {
    async appendRun(run) {
      return inner.appendRun(run)
    },
    async updateRun(runId, patch) {
      return inner.updateRun(runId, patch)
    },
    async appendSpan(span) {
      if (span.endedAt) {
        exporter.exportSpan(storeSpanToExportable(span, traceId))
      }
      return inner.appendSpan(span)
    },
    async updateSpan(spanId, patch) {
      await inner.updateSpan(spanId, patch)
      if (patch.endedAt) {
        const spans = await inner.spans({ runId: traceId })
        const found = spans.find(s => s.spanId === spanId)
        if (found) {
          exporter.exportSpan(storeSpanToExportable(found, traceId))
        }
      }
    },
    async appendEvent(event) {
      return inner.appendEvent(event)
    },
    async appendBudgetEntry(entry) {
      return inner.appendBudgetEntry(entry)
    },
    async appendArtifact(artifact) {
      return inner.appendArtifact(artifact)
    },
    getRun: inner.getRun.bind(inner),
    listRuns: inner.listRuns.bind(inner),
    spans: inner.spans.bind(inner),
    events: inner.events.bind(inner),
    budget: inner.budget.bind(inner),
    artifacts: inner.artifacts.bind(inner),
  }
}

function storeSpanToExportable(span: Span, traceId: string): ExportableSpan {
  const llm = span.kind === 'llm' ? (span as LlmSpan) : undefined
  return {
    traceId,
    spanId: span.spanId,
    parentSpanId: span.parentSpanId,
    name: span.name,
    kind: span.kind,
    startedAt: span.startedAt,
    endedAt: span.endedAt,
    status: span.status,
    error: span.error,
    model: llm?.model,
    inputTokens: llm?.inputTokens,
    outputTokens: llm?.outputTokens,
    costUsd: llm?.costUsd,
    attributes: span.attributes as Record<string, unknown> | undefined,
  }
}
