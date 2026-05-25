/**
 * Wire-protocol module — public surface for cross-language clients.
 *
 * The HTTP server, stdio RPC, and OpenAPI emitter all live here. The
 * Zod schemas in `schemas.ts` are the source of truth — keep them in
 * sync with what handlers actually accept and return.
 *
 * For the conceptual overview, see `docs/wire-protocol.md`.
 */

export * from './handlers'
export { buildOpenApi } from './openapi'
export { dispatchRpc, runRpcBatch, runRpcOnce } from './rpc'
export { BUILTIN_RUBRICS, getBuiltinRubric, listBuiltinRubrics } from './rubrics'
export * from './schemas'
export {
  createApp,
  type ServeOptions,
  type StartedServer,
  startServer,
  startServerAsync,
} from './server'
