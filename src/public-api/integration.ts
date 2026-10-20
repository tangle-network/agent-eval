// ── utilities ─────────────────────────────────────────────────────────
// Provider-neutral model contracts and shared error types. A consumer binds
// its own transport through `createChatClient` — `custom` for a chat function
// it wrote, `openai-compatible` for an endpoint and a credential it passes as
// values — or uses `profileChatClient` from
// `@tangle-network/agent-runtime/kernel`. agent-eval reads no environment
// variable to find a provider credential in either case.

export type {
  ChatCallOpts,
  ChatClient,
  ChatRequest,
  ChatResponse,
  ChatTransport,
  CreateChatClientOpts,
  CustomTransportOpts,
  MockTransportOpts,
  OpenAiCompatibleTransportOpts,
  SandboxSdkTransportOpts,
} from '../analyst/chat-client'
export { createChatClient } from '../analyst/chat-client'
export { analyzeAntiSlop, createAntiSlopJudge } from '../anti-slop'
export type { AgentEvalErrorCode } from '../errors'
export { AgentEvalError, ConfigError, JudgeError, NotFoundError, ValidationError } from '../errors'
export type { RunRecordBackend } from '../eval-trace-store'
export { jsonlRunRecordBackend } from '../eval-trace-store'
export { assignFeedbackSplit } from '../feedback-trajectory'
export type { ModelEndpointCheck, ModelEndpointRequest } from '../integrity/preflight'
export { preflightModels } from '../integrity/preflight'
export type { KnowledgeBundle } from '../knowledge/types'
export type {
  LlmCallMetadata,
  LlmCallRequest,
  LlmCallResult,
  LlmChargeBounds,
  LlmMessage,
  LlmTokenLogprob,
  LlmToolCall,
  LlmToolChoice,
  LlmToolDefinition,
  LlmUsage,
} from '../llm-client'
export {
  costReceiptFromLlm,
  costReceiptFromLlmError,
  isTransientLlmError,
  LlmCallError,
  LlmResponseError,
  maximumChargeForLlmRequest,
  stripFencedJson,
} from '../llm-client'
export type { ModelSeats } from '../model-seats'
export { resolveSeat, seatPresets } from '../model-seats'
export type { Finding } from '../multi-layer-verifier'
export type { PromptHandle } from '../prompt-registry'
export { hashContent, PromptRegistry } from '../prompt-registry'
export type {
  ReferenceReplayCaseRun,
  ReferenceReplayRun,
  ReferenceReplaySplit,
} from '../reference-replay'
export type { ActionableSideInfo } from '../release-confidence'
export type { SandboxDriver } from '../sandbox-harness'
export type { LinearRegressionResult } from '../statistics/inference'
export {
  chiSquared,
  chiSquaredPValue,
  fisherExactTwoSided,
  linearRegressionSlope,
  normalTwoSidedPValue,
  studentTTwoSidedPValue,
  twoByTwoPValue,
} from '../statistics/inference'
export type { SampleSummary, SampleSummaryOptions } from '../statistics/samples'
export { sampleMedian, summarizeSample } from '../statistics/samples'
export type { SteeringBundle } from '../steering'
export type { SteeringOptimizationResult, SteeringOptimizationRow } from '../steering-optimizer'
export { PairwiseSteeringOptimizer } from '../steering-optimizer'
export { paretoChart } from '../summary-report'
export type { OtlpSpan } from '../trace/otel'
export { InMemoryRawProviderSink } from '../trace/raw-provider-sink'
export type { GenericSpan, JudgeSpan, RunStatus } from '../trace/schema'
export { createBoundedTraceAnalysisStore } from '../trace-analyst/store'
export {
  otlpTextToTraceAnalysisStore,
  type SpanRecordsToTraceAnalysisStoreOptions,
  spanRecordsToTraceAnalysisStore,
} from '../trace-analyst/store-otlp'
