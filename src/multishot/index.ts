// Multishot substrate — re-exports for `@tangle-network/agent-eval/multishot`.

export { DEFAULT_JUDGE_MODEL } from '../analyst/chat-client'
export {
  type MultishotConversation,
  type MultishotConversationDriver,
  type MultishotLegSpend,
  type MultishotLegTokens,
  runMultishotConversation,
} from './conversation'
export { estimateMultishotCost } from './cost'

export {
  DEFAULT_CODER_MODEL,
  type DefaultCoderConfig,
  type DefaultResearcherConfig,
  type DefaultToolsBundle,
  type DefaultToolsConfig,
  defaultDelegationTools,
} from './default-tools'

export {
  type JudgeDimension,
  type JudgeRunResult,
  type JudgeScore,
  type MultishotJudgeConfig,
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
  AdversarialSplitError,
  type AdversarialUserOptions,
  type AdversarialUserResult,
  improveAdversarialUser,
} from './adversarial-user'
export {
  AdversarialScenarioInHeldOutError,
  assertHeldOutExcludesAdversarial,
  assertSameSimulatedUser,
  type ConversationGateOptions,
  type ConversationJudgeOptions,
  conversationGate,
  conversationJudge,
  type SimulatedUserMismatch,
  SimulatedUserMismatchError,
  UserSideObjectiveError,
} from './conversation-conditions'
export { type ConversationEvidence, describeConversation } from './conversation-evidence'
export {
  type MeasureSimulatorRealismOptions,
  measureSimulatorRealism,
  type RealismDriver,
  type RecordedUserTurn,
  recordedUserTurns,
  SharedContextIdentityError,
  SIMULATOR_REALISM_QUESTIONS,
  type SimulatorRealismJudge,
  type SimulatorRealismJudgeOptions,
  type SimulatorRealismReport,
  simulatedUserDriver,
  simulatorRealismJudge,
  userTurnContextDigest,
} from './realism'
export {
  type ConversationAgentOptions,
  type ConversationArtifact,
  type ConversationEnding,
  type ConversationLeg,
  type ConversationOutcome,
  type ConversationRecord,
  type ConversationScenario,
  DEFAULT_USER_ENDING,
  type MultishotRollout,
  type MultishotRolloutOptions,
  multishotRollout,
  type PushbackReading,
  type SimulatedUserIdentity,
  type SimulatedUserOptions,
  type UserEndingClassification,
  type UserEndingProtocol,
} from './rollout'
export { defaultShapeFromProfile } from './shape-defaults'

export {
  assertMultishotShotResult,
  type MultishotArtifact,
  MultishotDriverEmptyError,
  MultishotFatalToolError,
  type MultishotMessage,
  type MultishotPersona,
  type MultishotResult,
  type MultishotShape,
  type MultishotToolDefinition,
  type MultishotToolExecutor,
  type MultishotTransport,
  type MultishotTransportRequest,
  type MultishotTransportResponse,
  type MultishotTransportToolCall,
} from './types'
