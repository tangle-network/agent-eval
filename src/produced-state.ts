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
 * Normalize a run's runtime event stream into `ProducedState`.
 *
 * Pure and total — unrecognized event types are skipped. `toolCalls` is
 * deduplicated by name in first-seen order (completion cares about a tool's
 * presence, not its call count). An artifact with neither a name nor a uri
 * still yields an entry keyed by its `artifactId` so it is never silently
 * dropped; an artifact with no `content` yields empty content, which the
 * completion oracle's structural check then rejects on its own.
 */
export function extractProducedState(events: readonly RuntimeEventLike[]): ProducedState {
  const artifacts: Artifact[] = []
  const proposals: ProducedProposal[] = []
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
      artifacts.push({
        kind: artifactKind(a.mimeType),
        path: a.name ?? a.uri ?? a.artifactId,
        content: a.content ?? '',
      })
    } else if (ev.type === 'proposal_created') {
      const p = ev as ProposalEventLike
      proposals.push({ id: p.proposalId, title: p.title, status: p.status ?? 'pending' })
    }
  }

  return { artifacts, proposals, toolCalls }
}
