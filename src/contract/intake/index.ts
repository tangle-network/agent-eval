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
 *   - `fromCodexSession` / `fromClaudeCodeSession` / `fromOpenCodeSession` /
 *     `fromKimiCodeSession` / `fromPiSession` — local coding-agent and
 *     graph-shaped sessions projected into process-scored `RunRecord`s.
 *   - `fromRunRecordDir` — a `.json` / `.jsonl` file or a directory of them,
 *     parsed and validated at the boundary.
 */

export {
  type AgentTraceContributor,
  type AgentTraceContributorType,
  type AgentTraceConversation,
  type AgentTraceFile,
  type AgentTraceIndex,
  type AgentTraceRange,
  type AgentTraceRecord,
  type AuthoringProvenance,
  type PartitionByAuthoringModelResult,
  parseAgentTrace,
  partitionRunsByAuthoringModel,
} from './agent-trace'
export {
  type CodeAgentSessionAction,
  type CodeAgentSessionActionKind,
  type CodeAgentSessionActionStatus,
  type CodeAgentSessionActionSurface,
  type CodeAgentSessionDiagnostic,
  type CodeAgentSessionExecutionReceipt,
  type CodeAgentSessionIntakeOptions,
  type CodeAgentSessionIntakeResult,
  type CodeAgentSessionMetrics,
  type CodeAgentSessionObservation,
  type CodeAgentSessionSource,
  type CodeAgentSessionTerminalStatus,
  fromClaudeCodeSession,
  fromCodexSession,
  fromKimiCodeSession,
  fromOpenCodeSession,
  fromPigraphSession,
  fromPiSession,
  observeCodeAgentSession,
  type ParsedCodeAgentJsonl,
  parseCodeAgentJsonl,
} from './code-agent-session'
export {
  type FeedbackTableMeta,
  type FeedbackTableRow,
  type FromFeedbackTableOptions,
  type FromFeedbackTableResult,
  fromFeedbackTable,
} from './feedback-table'
export { type FromOtelSpansOptions, fromOtelSpans } from './otel-spans'
export {
  type FromRunRecordDirOptions,
  type FromRunRecordDirResult,
  fromRunRecordDir,
  type RunRecordRejection,
} from './run-record-dir'
