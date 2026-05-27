/**
 * # `@tangle-network/agent-eval/contract/intake` — adapters that turn external
 *   data sources into the substrate-canonical `RunRecord` shape.
 *
 * Each adapter is a function `source → RunRecord[]` (or
 * `{ runs, raterScores }` when the adapter exposes multi-rater signal).
 * Consumers pipe the output straight into `analyzeRuns({ runs })`.
 *
 * Adapters:
 *   - `fromFeedbackTable` — multi-rater approve/reject corpus
 *     (Obsidian, Sheets, CSV, Postgres).
 *   - `fromOtelSpans` — OTel `TraceSpanEvent[]` from any OTel-compatible
 *     observability stack.
 */

export {
  type FeedbackTableMeta,
  type FeedbackTableRow,
  type FromFeedbackTableOptions,
  type FromFeedbackTableResult,
  fromFeedbackTable,
} from './feedback-table'

export { type FromOtelSpansOptions, fromOtelSpans } from './otel-spans'
