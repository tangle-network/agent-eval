/**
 * Wire-protocol module — public surface for cross-language clients.
 *
 * The HTTP server, stdio RPC, and OpenAPI emitter all live here. The
 * Zod schemas in `schemas.ts` are the source of truth — keep them in
 * sync with what handlers actually accept and return.
 *
 * For the conceptual overview, see `docs/wire-protocol.md`.
 */

export * from './schemas'
export * from './handlers'
export { BUILTIN_RUBRICS, getBuiltinRubric, listBuiltinRubrics } from './rubrics'
export { buildOpenApi } from './openapi'
export { createApp, startServer, type ServeOptions } from './server'
export { dispatchRpc, runRpcOnce, runRpcBatch } from './rpc'
