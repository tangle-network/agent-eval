/**
 * Telemetry client — thin wrapper that builds envelopes from `EmitArgs` and
 * delegates to a `TelemetrySink`. Pure logic; no I/O. Use this from any
 * runtime — Workers, Node, browser — and choose the sink accordingly.
 *
 * For an opinionated singleton with env-var-driven sink wiring (the bad CLI
 * pattern), see `./node-client.ts`.
 */

import type { TelemetryEnvelope, TelemetryKind, TelemetryModel, TelemetrySource } from './schema'
import { TELEMETRY_SCHEMA_VERSION } from './schema'
import type { TelemetrySink } from './sink-fetch'

export interface EmitArgs {
  kind: TelemetryKind
  runId: string
  parentRunId?: string
  ok: boolean
  durationMs: number
  data?: Record<string, unknown>
  metrics?: Record<string, number>
  tags?: Record<string, string>
  model?: TelemetryModel
  error?: string
  /** Override the source for this envelope. Falls back to `defaultSource`. */
  source?: TelemetrySource
}

export class TelemetryClient {
  constructor(
    private readonly sink: TelemetrySink,
    private readonly defaultSource: TelemetrySource,
  ) {}

  emit(args: EmitArgs): void {
    const envelope: TelemetryEnvelope = {
      schemaVersion: TELEMETRY_SCHEMA_VERSION,
      envelopeId: makeEnvelopeId(),
      runId: args.runId,
      timestamp: new Date().toISOString(),
      source: args.source ?? this.defaultSource,
      kind: args.kind,
      ok: args.ok,
      durationMs: args.durationMs,
      data: args.data ?? {},
      metrics: args.metrics ?? {},
      ...(args.parentRunId ? { parentRunId: args.parentRunId } : {}),
      ...(args.model ? { model: args.model } : {}),
      ...(args.tags ? { tags: args.tags } : {}),
      ...(args.error ? { error: args.error } : {}),
    }
    try {
      this.sink.emit(envelope)
    } catch {
      // swallow — telemetry never breaks the calling code path
    }
  }

  async close(): Promise<void> {
    await this.sink.close?.()
  }
}

/** Generate a UUIDv4 with whatever crypto is available (Node, Workers, browsers). */
function makeEnvelopeId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  // Last-resort fallback. Lower entropy but never throws.
  return `env-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

export const SECRET_FLAGS = new Set(['--api-key', '--bearer', '--token', '--password'])

/** Strip likely-secret values from argv, preserving structure. */
export function sanitiseArgv(argv: string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (SECRET_FLAGS.has(a)) {
      out.push(a, '<redacted>')
      i++
      continue
    }
    if (/^(?:--api-key|--bearer|--token|--password)=/.test(a)) {
      out.push(a.replace(/=.*$/, '=<redacted>'))
      continue
    }
    out.push(a)
  }
  return out
}
