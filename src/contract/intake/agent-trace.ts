/**
 * `fromAgentTrace` — provenance correlation from Cursor's Agent Trace spec
 * (https://github.com/cursor/agent-trace, RFC v0.1.0).
 *
 * Agent Trace is NOT a run/quality trace — it carries no outcome, score, or
 * cost. It records *code authorship*: for a VCS revision, which AI model /
 * conversation authored which file ranges. It explicitly disclaims quality
 * assessment — which is exactly what `analyzeRuns` adds.
 *
 * The two layers join on a key the substrate already has: a `RunRecord`
 * carries `commitSha`, and an Agent Trace record is keyed by
 * `vcs.revision`. So this adapter does not produce `RunRecord`s — it builds a
 * provenance index by commit and partitions existing runs by their authoring
 * model. Feed each cohort to `analyzeRuns` (or pass one as `baselineRuns`) to
 * answer the question no run-only trace can: *which authoring agent's code
 * fails / regresses / costs more.*
 *
 * Granularity is commit-level (the SHA join). Per-file/per-line correlation
 * would require runs to record which files they exercised — out of scope.
 */

import type { RunRecord } from '../../run-record'

// ── Agent Trace record schema (the subset we read) ──────────────────────────

export type AgentTraceContributorType = 'human' | 'ai' | 'mixed' | 'unknown'

export interface AgentTraceContributor {
  type: AgentTraceContributorType
  /** models.dev id, e.g. `anthropic/claude-opus-4-5-20251101`. */
  model_id?: string
}

export interface AgentTraceRange {
  start_line: number
  end_line: number
  content_hash?: string
  /** Per-range contributor override (agent handoffs). Wins over the
   *  conversation-level contributor for these lines. */
  contributor?: AgentTraceContributor
}

export interface AgentTraceConversation {
  url?: string
  contributor?: AgentTraceContributor
  ranges: AgentTraceRange[]
}

export interface AgentTraceFile {
  path: string
  conversations: AgentTraceConversation[]
}

export interface AgentTraceRecord {
  version: string
  id: string
  timestamp: string
  vcs?: { type: string; revision: string }
  tool?: { name?: string; version?: string }
  files: AgentTraceFile[]
}

// ── Provenance index ─────────────────────────────────────────────────────────

/** Authorship provenance for one VCS revision, aggregated across the record's
 *  files/conversations/ranges. */
export interface AuthoringProvenance {
  commitSha: string
  /** Unique AI model ids that authored code in this commit (type ai|mixed). */
  aiModels: string[]
  /** Tools that produced the records (e.g. `cursor`). */
  tools: string[]
  conversationCount: number
  fileCount: number
  /** Total attributed lines (sum of range spans). */
  lineCount: number
  /** True if any range was authored (in whole or part) by a human. */
  humanInvolved: boolean
}

export type AgentTraceIndex = Map<string, AuthoringProvenance>

function rangeLines(r: AgentTraceRange): number {
  return Math.max(0, r.end_line - r.start_line + 1)
}

/**
 * Build a commit → provenance index from Agent Trace records. Multiple records
 * for the same revision are merged. Records without `vcs.revision` are skipped
 * (the SHA is the join key — without it there is nothing to correlate against).
 */
export function parseAgentTrace(records: AgentTraceRecord[]): AgentTraceIndex {
  interface Acc {
    models: Set<string>
    tools: Set<string>
    files: Set<string>
    conversationCount: number
    lineCount: number
    humanInvolved: boolean
  }
  const acc = new Map<string, Acc>()

  for (const record of records) {
    const sha = record.vcs?.revision
    if (!sha) continue // the SHA is the join key — nothing to correlate without it

    let a = acc.get(sha)
    if (!a) {
      a = {
        models: new Set(),
        tools: new Set(),
        files: new Set(),
        conversationCount: 0,
        lineCount: 0,
        humanInvolved: false,
      }
      acc.set(sha, a)
    }

    if (record.tool?.name) a.tools.add(record.tool.name)

    for (const file of record.files ?? []) {
      a.files.add(file.path)
      for (const conv of file.conversations ?? []) {
        a.conversationCount += 1
        for (const range of conv.ranges ?? []) {
          // Per-range contributor wins, else the conversation contributor.
          const contributor = range.contributor ?? conv.contributor
          a.lineCount += rangeLines(range)
          if (!contributor) continue
          if (contributor.type === 'human' || contributor.type === 'mixed') {
            a.humanInvolved = true
          }
          if ((contributor.type === 'ai' || contributor.type === 'mixed') && contributor.model_id) {
            a.models.add(contributor.model_id)
          }
        }
      }
    }
  }

  const index: AgentTraceIndex = new Map()
  for (const [sha, a] of acc) {
    index.set(sha, {
      commitSha: sha,
      aiModels: [...a.models].sort(),
      tools: [...a.tools].sort(),
      conversationCount: a.conversationCount,
      fileCount: a.files.size,
      lineCount: a.lineCount,
      humanInvolved: a.humanInvolved,
    })
  }
  return index
}

// ── Run ↔ provenance join ──────────────────────────────────────────────────

export interface PartitionByAuthoringModelResult {
  /** Runs grouped by each AI model that authored code in the run's commit. A
   *  run whose commit had multiple authoring models appears under EACH — the
   *  cohorts overlap by construction at commit granularity. */
  byModel: Map<string, RunRecord[]>
  /** Runs whose `commitSha` had no Agent Trace provenance (no record, or no
   *  AI authorship). Kept separate — never silently folded into a cohort. */
  unattributed: RunRecord[]
}

/**
 * Partition runs by the AI model(s) that authored the code at each run's
 * `commitSha`. Feed `byModel.get(modelId)` to `analyzeRuns`, or compare two
 * model cohorts via `analyzeRuns({ runs: a, baselineRuns: b })` for a lift CI
 * on "model A's code vs model B's code".
 */
export function partitionRunsByAuthoringModel(
  runs: RunRecord[],
  index: AgentTraceIndex,
): PartitionByAuthoringModelResult {
  const byModel = new Map<string, RunRecord[]>()
  const unattributed: RunRecord[] = []

  for (const run of runs) {
    const provenance = index.get(run.commitSha)
    if (!provenance || provenance.aiModels.length === 0) {
      unattributed.push(run)
      continue
    }
    for (const model of provenance.aiModels) {
      const cohort = byModel.get(model) ?? []
      cohort.push(run)
      byModel.set(model, cohort)
    }
  }

  return { byModel, unattributed }
}
