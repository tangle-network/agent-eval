/**
 * Rollout module — the single owner of the `tangle.rollout.v1` training-row
 * serialization: canonical schema + validation, ledger file API, minting
 * from RunRecord × trace, harness-store intake readers (opencode sqlite,
 * Claude Code jsonl), training-format exporters (SFT, reward rows, Prime
 * Intellect verifiers, OpenAI RFT), Harbor ATIF-v1.7 interchange, and the
 * scrub + dataset-card release pipeline. See `docs/rollout.md` for the
 * schema decision table and the source → waist → sink map.
 */

export { type RealnessLabels, type RewardRow, type RftItem, type SftExportOptions, type SftRow, toJsonl, toRewardRows, toRftItems, toSftRows, toVerifiersRolloutOutputs, type VerifiersRolloutOutput, type VerifiersTokenUsage } from './exporters'

export {
  GATE_CHECK_IDS,
  GATE_CHECKS,
  GATE_POLICIES,
  type GateCheck,
  type GateCheckDisposition,
  type GateCheckedOutcome,
  type GateCheckId,
  type GateEntryPoint,
  type GatePolicy,
  gatedEvidenceOf,
  gateErrors,
} from './gate-checks'

export { type FromHarborOptions, fromHarborTrajectory, type HarborAgent, type HarborContentPart, type HarborFinalMetrics, type HarborImageSource, type HarborMetrics, type HarborObservation, type HarborObservationResult, type HarborStep, type HarborStepSource, type HarborSubagentTrajectoryRef, type HarborToolCall, type HarborTrajectory, relabelImportedSplit, toHarborTrajectories, toHarborTrajectory } from './interchange/harbor'

export { appendRolloutLines, readRolloutLedger, writeRolloutLedger } from './ledger'

export {
  type MintRolloutOptions,
  type MintRolloutResult,
  mintRolloutRows,
  type RolloutScrubber,
  type RolloutSearchLineage,
  unmintableReasons,
} from './mint'
export { type ClaudeTranscript, type ClaudeTranscriptRef, type ClaudeUsageTotals, DEFAULT_CLAUDE_PROJECTS_DIR, findClaudeTranscripts, parseClaudeTranscript, type ReadClaudeTranscriptOptions, readClaudeTranscript } from './readers/claude-jsonl'
export { DEFAULT_OPENCODE_DB, readOpencodeSessionMessages } from './readers/opencode-sqlite'
export { buildDatasetCard, type DatasetCardInputs, type ReleaseFormat } from './release/card'
export { assertGateReport, type EmittedEvidence, type FormatGateCounts, type GateDisposition, type GateReport, type ReleaseRowRef } from './release/gate-report'
export { type BuildOptions, type BuildSummary, buildHfDataset, type RolloutReleaseCliArgs, type ScrubReport } from './release/hf-dataset'
export { defaultRolloutScrubber, type ScrubCounts, type ScrubRule, scrubLines, scrubText } from './release/scrub'
export { isRealnessGated, observedSplitScore, type ScoreOrigin, type ScorePreference, trainingReward, trainingScore } from './reward'
export {
  assertMinted,
  assertMintedLines,
  assertRolloutLine,
  type ChatMessage,
  type ChatRole,
  type ChatToolCall,
  type GatedEvidence,
  gateGamedOutcome,
  isRolloutLine,
  isTrainableSplit,
  type MintedRolloutLine,
  type MintedRolloutOutcome,
  ROLLOUT_CAPTURES,
  ROLLOUT_ROLES,
  ROLLOUT_SCHEMA,
  ROLLOUT_SPLITS,
  type RolloutArtifacts,
  type RolloutCapture,
  type RolloutCostBlock,
  type RolloutEvidenceAttempt,
  type RolloutLine,
  type RolloutOutcome,
  type RolloutPolicy,
  type RolloutProvenance,
  type RolloutRole,
  type RolloutSplit,
  type RolloutStep,
  type RolloutTask,
  type RolloutWorkspaceCapture,
  type ToolDef,
  validateRolloutLine,
} from './schema'
