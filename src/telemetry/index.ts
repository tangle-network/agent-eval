/**
 * Public entry for the telemetry sub-module.
 *
 * Workers-safe by default — only `fetch` + pure JS. The Node file sink is
 * exported separately via './telemetry/file' so consumers that import this entry
 * cannot accidentally pull `node:fs` into a Worker bundle.
 *
 * Consume:
 *   import { TelemetryClient, HttpTelemetrySink, FanoutTelemetrySink }
 *     from '@tangle-network/agent-eval/telemetry'
 *
 * For Node:
 *   import { FileTelemetrySink, defaultTelemetryDir }
 *     from '@tangle-network/agent-eval/telemetry/file'
 */

export {
  type EmitArgs,
  SECRET_FLAGS,
  sanitiseArgv,
  TelemetryClient,
} from './client'
export type {
  TelemetryEnvelope,
  TelemetryKind,
  TelemetryModel,
  TelemetrySource,
} from './schema'
export { TELEMETRY_SCHEMA_VERSION } from './schema'
export {
  FanoutTelemetrySink,
  HttpTelemetrySink,
  InMemoryTelemetrySink,
  NullTelemetrySink,
  type TelemetrySink,
} from './sink-fetch'
