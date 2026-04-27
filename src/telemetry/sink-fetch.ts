/**
 * Workers-safe telemetry sinks — only `fetch` and pure JS. No `fs`, no
 * `child_process`. Safe to import from a Cloudflare Worker, Lambda, edge
 * function, or browser extension.
 *
 * For Node-only file persistence, import from './sink-file' instead.
 */

import type { TelemetryEnvelope } from './schema'

export interface TelemetrySink {
  emit(envelope: TelemetryEnvelope): Promise<void> | void
  close?(): Promise<void> | void
}

/** Best-effort POST to a remote collector. Fire-and-forget; never throws. */
export class HttpTelemetrySink implements TelemetrySink {
  private inflight = new Set<Promise<void>>()

  constructor(
    private readonly endpoint: string,
    private readonly bearer?: string,
  ) {}

  emit(envelope: TelemetryEnvelope): void {
    const body = JSON.stringify(envelope)
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (this.bearer) headers.authorization = `Bearer ${this.bearer}`
    const promise = fetch(this.endpoint, { method: 'POST', headers, body })
      .then(() => undefined)
      .catch(() => undefined)
    this.inflight.add(promise)
    promise.finally(() => this.inflight.delete(promise))
  }

  async close(): Promise<void> {
    await Promise.allSettled(Array.from(this.inflight))
  }
}

/** Fanout to multiple sinks — failures in one do not affect others. */
export class FanoutTelemetrySink implements TelemetrySink {
  constructor(private readonly sinks: TelemetrySink[]) {}

  emit(envelope: TelemetryEnvelope): void {
    for (const sink of this.sinks) {
      try {
        const result = sink.emit(envelope)
        if (result && typeof (result as Promise<unknown>).catch === 'function') {
          ;(result as Promise<unknown>).catch(() => undefined)
        }
      } catch {
        // swallow — telemetry must never break a run
      }
    }
  }

  async close(): Promise<void> {
    await Promise.allSettled(this.sinks.map((s) => Promise.resolve(s.close?.())))
  }
}

/** No-op sink — used when telemetry is explicitly disabled. */
export class NullTelemetrySink implements TelemetrySink {
  emit(): void {}
}

/** In-memory sink — useful for tests + downstream adapters. */
export class InMemoryTelemetrySink implements TelemetrySink {
  readonly envelopes: TelemetryEnvelope[] = []
  emit(envelope: TelemetryEnvelope): void {
    this.envelopes.push(envelope)
  }
  clear(): void { this.envelopes.length = 0 }
}
