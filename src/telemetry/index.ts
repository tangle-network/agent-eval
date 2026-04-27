/**
 * Public entry for the telemetry sub-module.
 *
 * Workers-safe by default — only `fetch` + pure JS. The Node file sink is
 * exported separately via './sink-file' so consumers that import this entry
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

export { TELEMETRY_SCHEMA_VERSION } from './schema'
export type {
  TelemetryEnvelope,
  TelemetryKind,
  TelemetrySource,
  TelemetryModel,
} from './schema'

export {
  type TelemetrySink,
  HttpTelemetrySink,
  FanoutTelemetrySink,
  NullTelemetrySink,
  InMemoryTelemetrySink,
} from './sink-fetch'

export {
  TelemetryClient,
  SECRET_FLAGS,
  sanitiseArgv,
  type EmitArgs,
} from './client'
