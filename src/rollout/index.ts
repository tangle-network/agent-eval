/**
 * Rollout module — the single owner of the `tangle.rollout.v1` training-row
 * serialization: canonical schema + validation, ledger file API, minting
 * from RunRecord × trace, harness-store intake readers (opencode sqlite,
 * Claude Code jsonl), training-format exporters (SFT, reward rows, Prime
 * Intellect verifiers, OpenAI RFT), and the scrub + dataset-card release
 * pipeline. See `docs/rollout.md` for the schema decision table.
 */

export {
  type RewardRow,
  type RftItem,
  type SftExportOptions,
  type SftRow,
  toJsonl,
  toRewardRows,
  toRftItem,
  toRftItems,
  toSftRows,
  toVerifiersRolloutOutput,
  toVerifiersRolloutOutputs,
  type VerifiersRolloutOutput,
  type VerifiersTokenUsage,
} from './exporters'

export { appendRolloutLines, readRolloutLedger, writeRolloutLedger } from './ledger'

export {
  type MintRolloutOptions,
  type MintRolloutResult,
  mintRolloutRows,
  type RolloutScrubber,
  rolloutReward,
} from './mint'
export {
  type ClaudeTranscript,
  type ClaudeTranscriptRef,
  type ClaudeUsageTotals,
  claudeProjectSlug,
  DEFAULT_CLAUDE_PROJECTS_DIR,
  findClaudeTranscripts,
  readClaudeTranscript,
} from './readers/claude-jsonl'
export {
  DEFAULT_OPENCODE_DB,
  findOpencodeSessionById,
  findOpencodeSessionsByDirectory,
  type OpencodeSessionRow,
  openOpencodeDb,
  readOpencodeSessionMessages,
} from './readers/opencode-sqlite'
export {
  buildDatasetCard,
  type DatasetCardInputs,
  FORMAT_FILES,
  RELEASE_FORMATS,
  type ReleaseFormat,
} from './release/card'
export {
  type BuildOptions,
  type BuildSummary,
  buildHfDataset,
  parseRolloutReleaseArgs,
  planPushCommand,
  pushDataset,
  ROLLOUT_RELEASE_USAGE,
  type RolloutReleaseCliArgs,
  runRolloutReleaseCli,
  type ScrubReport,
} from './release/hf-dataset'
export {
  addScrubCounts,
  defaultRolloutScrubber,
  emptyScrubCounts,
  SCRUB_RULES,
  type ScrubCounts,
  type ScrubRule,
  scrubLines,
  scrubRolloutLine,
  scrubText,
} from './release/scrub'
export {
  assertRolloutLine,
  CHAT_ROLES,
  type ChatMessage,
  type ChatRole,
  type ChatToolCall,
  isRolloutLine,
  isTrainableSplit,
  ROLLOUT_CAPTURES,
  ROLLOUT_FORMAT,
  ROLLOUT_ROLES,
  ROLLOUT_SCHEMA,
  ROLLOUT_SPLITS,
  type RolloutArtifacts,
  type RolloutCapture,
  type RolloutCostBlock,
  type RolloutLine,
  type RolloutOutcome,
  type RolloutPolicy,
  type RolloutProvenance,
  type RolloutRole,
  type RolloutSplit,
  type RolloutStep,
  type RolloutTask,
  type ToolDef,
  TRAINABLE_SPLITS,
  validateRolloutLine,
} from './schema'
