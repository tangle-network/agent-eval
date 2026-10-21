/**
 * Wire-protocol module — public surface for cross-language clients.
 *
 * The HTTP server, stdio RPC, and OpenAPI emitter all live here. The
 * Zod schemas in `schemas.ts` are the source of truth — keep them in
 * sync with what handlers actually accept and return.
 *
 * For the conceptual overview, see `docs/wire-protocol.md`.
 */

export { WireError } from './handlers'
export type { HandleJudgeOptions, IngestionStores } from './handlers'

export { dispatchRpc, type RpcOptions } from './rpc'

export { ErrorResponseSchema, FeedbackTrajectorySchema, TraceEventSchema, WIRE_VERSION } from './schemas'
export type { ErrorResponse, FailureMode, FeedbackIngestResponse, FeedbackTrajectory, JudgeRequest, JudgeResult, ListRubricsResponse, Rubric, RubricDimension, RubricInfo, TraceEvent, TracesIngestRequest, TracesIngestResponse, VersionResponse } from './schemas'
export {
  createApp,
  type ServeOptions,
  type StartedServer,
  startServer,
  startServerAsync,
} from './server'
