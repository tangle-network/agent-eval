// Multishot substrate — re-exports for `@tangle-network/agent-eval/multishot`.

export {
  createCodeExecutor,
  createResearchExecutor,
  DEFAULT_CODER_MODEL,
  DEFAULT_DELEGATE_CODE_TOOL,
  DEFAULT_DELEGATE_RESEARCH_TOOL,
  DEFAULT_RESEARCHER_MODEL,
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
  type JudgeScore,
  renderDimensions,
  renderJsonFooter,
  runJudge,
} from './judges'
export {
  type ArtifactJudgeInput,
  type CellCompositeScore,
  type ConversationJudgeInput,
  type MultishotJudges,
  type RunMultishotMatrixOptions,
  type RunMultishotMatrixResult,
  runMultishotMatrix,
} from './matrix'
export { type RunMultishotOptions, runMultishot } from './multishot'

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
  type MultishotArtifact,
  MultishotDriverEmptyError,
  type MultishotMessage,
  type MultishotPersona,
  type MultishotResult,
  type MultishotShape,
  type MultishotToolDefinition,
  type MultishotToolExecutor,
} from './types'
