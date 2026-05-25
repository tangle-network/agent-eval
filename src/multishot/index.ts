// Multishot substrate — re-exports for `@tangle-network/agent-eval/multishot`.

export {
  defaultDelegationTools,
  createResearchExecutor,
  createCodeExecutor,
  DEFAULT_DELEGATE_RESEARCH_TOOL,
  DEFAULT_DELEGATE_CODE_TOOL,
  DEFAULT_RESEARCHER_MODEL,
  DEFAULT_CODER_MODEL,
  type DefaultResearcherConfig,
  type DefaultCoderConfig,
  type DefaultToolsConfig,
  type DefaultToolsBundle,
} from './default-tools'

export {
  runJudge,
  renderDimensions,
  renderJsonFooter,
  DEFAULT_JUDGE_MODEL,
  type JudgeConfig,
  type JudgeDimension,
  type JudgeScore,
} from './judges'

export { runMultishot, type RunMultishotOptions } from './multishot'

export {
  runMultishotMatrix,
  type RunMultishotMatrixOptions,
  type RunMultishotMatrixResult,
  type MultishotJudges,
  type ConversationJudgeInput,
  type ArtifactJudgeInput,
  type CellCompositeScore,
} from './matrix'

export {
  defaultRouterBaseUrl,
  estimateRouterCost,
  requireRouterApiKey,
  routerCompletion,
  type RouterCompletionRequest,
  type RouterCompletionResponse,
  type RouterToolCall,
} from './router'

export {
  MultishotDriverEmptyError,
  type MultishotArtifact,
  type MultishotMessage,
  type MultishotPersona,
  type MultishotResult,
  type MultishotShape,
  type MultishotToolDefinition,
  type MultishotToolExecutor,
} from './types'
