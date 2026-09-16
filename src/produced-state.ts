/**
 * Produced-state extraction — normalize a run's runtime event stream into the
 * typed `ProducedState` the completion oracle consumes.
 *
 * `ProducedState` answers "what did the agent actually produce" — vault
 * artifacts, proposals, tool calls. The runtime emits these as a stream of
 * events; this module is the single normalization point from that stream to
 * the shape `verifyCompletion` expects.
 *
 * Input is structurally typed (`RuntimeEventLike`) so this module does not
 * depend on agent-runtime — agent-runtime's `RuntimeStreamEvent` satisfies it
 * structurally. The `content` on `ArtifactEventLike` and the whole
 * `proposal_created` variant are the runtime-side enrichments this contract
 * requires; the runtime emits them, this module consumes them.
 */

import type { Artifact } from './artifact-validator'
import type { ProducedProposal, ProducedState } from './completion-verifier'

/** A tool the agent invoked. */
export interface ToolCallEventLike {
  type: 'tool_call'
  toolName: string
}

/**
 * An artifact the agent produced. `content` is the enriched field — the
 * runtime's base `artifact` event carries only metadata; the completion
 * oracle needs the body to verify the deliverable, so the runtime emits it.
 */
export interface ArtifactEventLike {
  type: 'artifact'
  artifactId: string
  name?: string
  mimeType?: string
  uri?: string
  content?: string
}

/** A proposal / filing the agent created. */
export interface ProposalEventLike {
  type: 'proposal_created'
  proposalId: string
  title: string
  status?: 'pending' | 'approved' | 'rejected'
  // body of the proposal (e.g. a submit_proposal `description`). When present,
  // the completion oracle correctness-checks it like artifact content; absent,
  // the proposal is graded presence-only.
  content?: string
}

/**
 * The subset of runtime stream events `extractProducedState` consumes.
 * agent-runtime's full `RuntimeStreamEvent` union satisfies this structurally;
 * the `{ type: string }` catch-all keeps the input permissive so callers can
 * pass the whole unfiltered telemetry stream — unrecognized events are skipped.
 */
export type RuntimeEventLike =
  | ToolCallEventLike
  | ArtifactEventLike
  | ProposalEventLike
  | { type: string }

function artifactKind(mimeType: string | undefined): string {
  if (!mimeType) return 'file'
  if (mimeType.includes('json')) return 'json'
  if (mimeType.startsWith('text/')) return 'text'
  return 'file'
}

/**
 * Normalize an emission-ordered stream into its latest observed produced state.
 * Artifacts are keyed by their exact output path (name, then URI, then id);
 * proposals by id. Later observations replace earlier ones, including missing
 * content or a rejected status. An obsolete version cannot prove completion.
 * Distinct paths remain distinct; no path normalization or aliasing is inferred.
 * Results retain first-seen identity order. Tool names describe invocation,
 * not success, and are deduplicated in first-seen order.
 *
 * An artifact without observed content yields empty content, which the
 * completion oracle rejects. This projection does not verify external effects,
 * recover dropped events, or establish freshness beyond the supplied stream.
 */
export function extractProducedState(events: readonly RuntimeEventLike[]): ProducedState {
  const artifacts = new Map<string, Artifact>()
  const proposals = new Map<string, ProducedProposal>()
  const toolCalls: string[] = []
  const seenTools = new Set<string>()

  for (const ev of events) {
    if (ev.type === 'tool_call') {
      const name = (ev as ToolCallEventLike).toolName
      if (name && !seenTools.has(name)) {
        seenTools.add(name)
        toolCalls.push(name)
      }
    } else if (ev.type === 'artifact') {
      const a = ev as ArtifactEventLike
      const path = a.name ?? a.uri ?? a.artifactId
      artifacts.set(path, {
        kind: artifactKind(a.mimeType),
        path,
        content: a.content ?? '',
      })
    } else if (ev.type === 'proposal_created') {
      const p = ev as ProposalEventLike
      proposals.set(p.proposalId, {
        id: p.proposalId,
        title: p.title,
        status: p.status ?? 'pending',
        ...(p.content !== undefined ? { content: p.content } : {}),
      })
    }
  }

  return { artifacts: [...artifacts.values()], proposals: [...proposals.values()], toolCalls }
}
