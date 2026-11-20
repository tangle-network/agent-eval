/**
 * Wire-protocol module — public surface for cross-language clients.
 *
 * The HTTP server, stdio RPC, and OpenAPI emitter all live here. The
 * Zod schemas in `schemas.ts` are the source of truth — keep them in
 * sync with what handlers actually accept and return.
 *
 * For the conceptual overview, see `docs/wire-protocol.md`.
 */

export type { HandleJudgeOptions, IngestionStores } from './handlers'
export { WireError } from './handlers'

export { dispatchRpc, type RpcOptions } from './rpc'
export type {
  ErrorResponse,
  FeedbackIngestResponse,
  JudgeRequest,
  JudgeResult,
  ListRubricsResponse,
  Rubric,
  RubricInfo,
  TracesIngestRequest,
  TracesIngestResponse,
  VersionResponse,
  WireFailureMode,
  WireFeedbackTrajectory,
  WireRubricDimension,
  WireTraceEvent,
} from './schemas'
export {
  ErrorResponseSchema,
  FeedbackTrajectorySchema,
  TraceEventSchema,
  WIRE_VERSION,
} from './schemas'
export {
  createApp,
  type ServeOptions,
  type StartedServer,
  startServer,
  startServerAsync,
} from './server'
