/**
 * # `@tangle-network/agent-eval/hosted`
 *
 * Client substrate for shipping eval-run events + trace spans to a
 * hosted orchestrator. The wire format is the public contract — every
 * orchestrator (ours, partners' self-hosted ones, future open
 * implementations) speaks the same shape. Schema lives in
 * `docs/hosted-ingest-spec.md`, types live in `./types.ts`, code
 * lives in `./client.ts`.
 */

export {
  createHostedClient,
  type HostedClient,
  type HostedTenant,
  hostedClientFromEnv,
} from './client'
export {
  type EvalRunCellScore,
  type EvalRunEvent,
  type EvalRunGenerationSnapshot,
  type EvalRunStatus,
  HOSTED_WIRE_VERSION,
  type HostedIngestHeaders,
  type HostedWireVersion,
  type IngestEvalRunsRequest,
  type IngestResponse,
  type IngestTracesRequest,
  type TraceSpanEvent,
} from './types'
