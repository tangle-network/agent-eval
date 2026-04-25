/**
 * Fleet telemetry envelope — agent-eval's portable observability shape.
 *
 * Designed so any consumer (Node CLI, Cloudflare Worker, Lambda, browser
 * extension) can emit structured rows describing one unit of work — a page
 * audit, a tool call, an evolve round, a full agent run — to a central sink.
 *
 * The schema is intentionally a strict superset of agent-eval's `Run` shape
 * so a future TraceStore adapter can promote envelopes into traces without
 * translation.
 */

export const TELEMETRY_SCHEMA_VERSION = 1

/** Discriminator for the unit of work this envelope describes. */
export type TelemetryKind =
  | 'agent-run'
  | 'design-audit-page'
  | 'design-audit-run'
  | 'design-evolve-round'
  | 'design-evolve-run'
  | 'gepa-trial'
  | 'gepa-generation'
  | 'tool-call'
  | 'judge-verdict'
  | 'custom'

export interface TelemetryEnvelope {
  schemaVersion: typeof TELEMETRY_SCHEMA_VERSION
  envelopeId: string
  runId: string
  timestamp: string
  parentRunId?: string

  source: TelemetrySource
  model?: TelemetryModel
  kind: TelemetryKind
  ok: boolean
  durationMs: number

  data: Record<string, unknown>
  metrics: Record<string, number>
  tags?: Record<string, string>

  error?: string
}

export interface TelemetrySource {
  /** Repo identity — basename of cwd plus git remote if discoverable. */
  repo: string
  cwd: string
  gitSha?: string
  gitBranch?: string
  cliVersion: string
  /** What was invoked, e.g. `design-audit`, `bad run`, `gepa --target`. */
  invocation: string
  /** Sanitised argv minus secrets. */
  argv?: string[]
  /**
   * Multi-tenant identity. Set when the consumer runs inside a hosted
   * product so a fleet rollup can group by tenant without leaking customer
   * URLs or PII.
   */
  tenantId?: string
  /** Optional sub-tenant identity (project, suite, walkthrough, customer). */
  customerId?: string
  /** SHA-256 (12 hex) of the API key used to authenticate this run, when applicable. */
  apiKeyHash?: string
}

export interface TelemetryModel {
  provider: string
  name: string
  /** SHA-256 (12 hex chars) of the prompt(s) used. */
  promptHash?: string
  /** SHA-256 (12 hex chars) of the composed rubric body, if applicable. */
  rubricHash?: string
}
