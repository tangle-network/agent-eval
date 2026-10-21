/**
 * Supervision-tree reader over a THIRD-PARTY harness: Claude Code.
 *
 * The Runtime reader reads a supervisor journal designed for this analysis.
 * for this analysis. This reader reads a harness we do not control, whose
 * transcript was designed for replaying a chat — and recovers the same tree
 * from it. If both produce a `SupervisorRunSources`, the tree model is a
 * property of multi-agent runs, not of our journal format.
 *
 * ## Where the tree hides in a Claude Code transcript
 *
 * | Tree fact | Claude Code evidence |
 * |---|---|
 * | spawn      | assistant `tool_use` (`Agent` / `Task`), answered by a `tool_result` whose `toolUseResult.agentId` names the child |
 * | settle     | a `<task-notification>` block in a later user line: `<task-id>` = agentId, `<status>` |
 * | steer      | assistant `tool_use` (`SendMessage`) with `input.to` = agentId — mid-task, to a LIVE child |
 * | delivered  | that steer's `tool_result` carrying `success` / `resumedAgentId` |
 * | cancel     | assistant `tool_use` (`TaskStop`) targeting an agentId |
 * | brain spend| `message.usage` on the main thread's assistant lines |
 * | worker spend| `message.usage` inside `<session>/subagents/agent-<id>.jsonl` |
 * | depth      | a child transcript that itself contains `Agent` tool_use lines |
 *
 * Every one of those is read from the normalized session of @tangle-network/harness-sessions — the SAME
 * parser `src/rollout/readers/claude-jsonl.ts` uses for solo rollouts. There
 * is no second transcript parser.
 *
 * ## What Claude Code cannot say
 *
 * It records tokens but never a price, runs no per-worker verify, and keeps no
 * per-worker patch. Those are declared once in `limits`, so the analyzer
 * reports `unavailable — <reason>` instead of the $0 / 0-accepted that summing
 * an empty field would produce. See `SourceLimits`.
 *
 * ## Metric coverage vs the Runtime journal
 *
 * Measured on a real 52-agent session (fixture:
 * `tests/fixtures/supervisor-run/claude-code-session-*`).
 *
 * | Metric | Runtime | Claude Code | Why |
 * |---|---|---|---|
 * | workersSpawned / Settled / Cancelled | full | full | spawn tool_use + task-notification + TaskStop |
 * | steers / steersDelivered / steersByWorker | full | full | `SendMessage`; delivery from its tool_result |
 * | waves / waveSizes / maxConcurrency | full | full | derived from spawn/settle instants |
 * | respawns / repeatedLabels | full | full | same derivation |
 * | delegationDepth | full | full | a child transcript's own spawn calls |
 * | timeToFirstSpawn / supervisorWall | full | full | transcript instants |
 * | idleMs / idlePct / workerUtilization | full | PARTIAL | an agent that never notifies is counted live to the end of the transcript |
 * | observeThenRespawn / respawnWithoutEvidence | full | full | ordering of spawn vs settle instants |
 * | workerEvidenceBytes | full | PARTIAL | the child's closing message; 0 for pruned transcripts |
 * | brain tokens in/out + cache | full | full | main-thread `message.usage` |
 * | worker tokens in/out + cache | via harness join | full or unavailable | totals are refused if any spawned transcript was pruned; retained per-worker rows remain available |
 * | perWorker wall | full | full | spawn → settle instants |
 * | accepted / rejected / emptyPass / settledVerdicts | full | NONE | no per-worker verify step exists |
 * | brain/worker/total usd, costPerAcceptedPatch | full | NONE | transcripts carry no price |
 * | patch stats, delivered, verifyPass/Rc | full | NONE | no diff is handed back |
 * | judgeResolved / Score / Passed / Total | full | NONE | no judge in the loop |
 * | driverSteerCalls, brainTruncations | full | NONE | no outer driver log, no per-call finish_reason tap |
 */
















export interface ClaudeCodeReaderOptions {
  /** The main session transcript: `~/.claude/projects/<slug>/<sessionId>.jsonl`. */
  readonly transcriptPath: string
  /**
   * Directory of child transcripts. Defaults to `<transcript-dir>/<sessionId>/subagents`.
   * `null` skips the join, and every per-worker token count becomes unavailable.
   */
  readonly subagentsDir?: string | null
  readonly runRef?: string
  readonly instanceId?: string | null
  readonly arm?: string | null
  readonly spawnTools?: readonly string[]
  readonly steerTools?: readonly string[]
  readonly cancelTools?: readonly string[]
}






























