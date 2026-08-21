// Multishot substrate — re-exports for `@tangle-network/agent-eval/multishot`.

export {
  DEFAULT_CODER_MODEL,
  type DefaultCoderConfig,
  type DefaultResearcherConfig,
  type DefaultToolsBundle,
  type DefaultToolsConfig,
  defaultDelegationTools,
} from './default-tools'

export {
  DEFAULT_JUDGE_MODEL,
  type JudgeConfig,
  type JudgeDimension,
  type JudgeRunResult,
  type JudgeScore,
  renderDimensions,
  renderJsonFooter,
  runJudge,
} from './judges'
export {
  type ArtifactJudgeInput,
  type CellCompositeInput,
  type CellCompositeScore,
  type ConversationJudgeInput,
  computeCellComposite,
  type MultishotCellOutput,
  type MultishotJudges,
  type RunMultishotMatrixOptions,
  type RunMultishotMatrixResult,
  runMultishotMatrix,
} from './matrix'
export { type MultishotShot, type RunMultishotOptions, runMultishot } from './multishot'
export {
  defaultRouterBaseUrl,
  estimateRouterCost,
  type RouterCompletionRequest,
  type RouterCompletionResponse,
  type RouterToolCall,
  requireRouterApiKey,
  routerCompletion,
} from './router'
export {
  defaultMultishotDriverSystemPrompt,
  defaultMultishotOpener,
  defaultShapeFromProfile,
  renderPersonaFacts,
} from './shape-defaults'

export {
  assertMultishotShotResult,
  type MultishotArtifact,
  MultishotDriverEmptyError,
  MultishotFatalToolError,
  type MultishotMessage,
  type MultishotPersona,
  type MultishotResult,
  type MultishotShape,
  MultishotShotResultError,
  type MultishotToolDefinition,
  type MultishotToolExecutor,
  type MultishotTransport,
  type MultishotTransportRequest,
  type MultishotTransportResponse,
  type MultishotTransportToolCall,
} from './types'
