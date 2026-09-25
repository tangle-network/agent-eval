/**
 * # `@tangle-network/agent-eval/hosted`
 *
 * Ships search ledgers and trace spans to a hosted orchestrator. The wire
 * format is the public contract — every orchestrator (ours, partners'
 * self-hosted ones, future open implementations) speaks the same shape.
 * The spec lives in `docs/hosted-ingest-spec.md`; the search-ledger shapes and
 * the store's batch rule live in `./search-ledger-wire.ts`, the trace shapes in
 * `./types.ts`, the transport in `./client.ts`, and the shipper in
 * `./search-shipper.ts`.
 */

export {
  createHostedClient,
  type HostedClient,
  HostedRequestError,
  type HostedTenant,
  hostedClientFromEnv,
  hostedTenantFromEnv,
  type SearchLedgerIngestOutcome,
} from './client'
export {
  IngestResponseSchema,
  IngestTracesRequestSchema,
  TraceSpanEventSchema,
  UnixNanoTimestampSchema,
} from './schemas'
export {
  type AdmitSearchLedgerBatchInput,
  admitSearchLedgerBatch,
  type IngestSearchLedgerRequest,
  IngestSearchLedgerRequestSchema,
  SEARCH_LEDGER_BATCH_MAX_BYTES,
  SEARCH_LEDGER_BATCH_MAX_LINES,
  SEARCH_LEDGER_INGEST_PATH,
  type SearchBlobPutResponse,
  SearchBlobPutResponseSchema,
  type SearchLedgerBatchAdmission,
  type SearchLedgerConflict,
  SearchLedgerConflictSchema,
  type SearchLedgerHead,
  SearchLedgerHeadSchema,
  type SearchRunKind,
  SearchRunKindSchema,
  searchBlobPath,
  searchLedgerArtifactRefs,
  searchLedgerHeadPath,
} from './search-ledger-wire'
export {
  SearchShipConflictError,
  type SearchShipMissingBlob,
  type SearchShipOptions,
  type SearchShipper,
  type SearchShipResult,
  shipSearchLedger,
  startSearchShipper,
} from './search-shipper'
export {
  HOSTED_WIRE_VERSION,
  type HostedIngestHeaders,
  type HostedWireVersion,
  type IngestResponse,
  type IngestTracesRequest,
  type TraceSpanEvent,
  type UnixNanoTimestamp,
} from './types'
