// What an optimizer is shown about one conversation. `describeConversation` is
// the `describeArtifact` for a `ConversationArtifact`: the native reflective
// proposer reads its JSON text in `scenarios[].emitted`, and GEPA and SkillOpt
// receive the same value as each evaluation's evidence. Its JSON is kept
// within `EMITTED_EVIDENCE_MAX_CHARS`, so the excerpt the native path applies
// never cuts it and both paths carry the same object.

import { EMITTED_EVIDENCE_MAX_CHARS, excerptEvidence } from '../reflective-mutation'
import type { ConversationArtifact, ConversationEnding } from './rollout'
import type { MultishotMessage } from './types'

export interface ConversationEvidence {
  /** The code-checked outcome. */
  outcome: { passed: boolean; detail: string }
  /** How the simulated user ended the conversation. */
  ending: ConversationEnding
  agentTurns: number
  /** The driver turn at which the user first pushed back; `null` when the
   *  user never did, `'undetermined'` when the rollout has no pushback rule. */
  firstPushbackTurn: number | null | 'undetermined'
  /** The transcript, its head and tail kept when it is long. */
  transcript: string
}

const DETAIL_MAX_CHARS = 400
const TOOL_RESULT_MAX_CHARS = 300

/** The evidence a reflection reads for one conversation. */
export function describeConversation(artifact: ConversationArtifact): ConversationEvidence {
  const base: ConversationEvidence = {
    outcome: {
      passed: artifact.outcome.passed,
      detail: excerptEvidence(artifact.outcome.detail, DETAIL_MAX_CHARS),
    },
    ending: { kind: artifact.ending.kind, turn: artifact.ending.turn },
    agentTurns: artifact.agentTurns,
    firstPushbackTurn: artifact.pushback.determined ? artifact.pushback.firstTurn : 'undetermined',
    transcript: '',
  }
  const full = renderTranscript(artifact.transcript)
  // JSON escaping can lengthen the kept text, so shrink the budget by the
  // overshoot until the whole object fits.
  let budget = EMITTED_EVIDENCE_MAX_CHARS - JSON.stringify(base).length
  let evidence = { ...base, transcript: excerptEvidence(full, Math.max(0, budget)) }
  for (
    let length = JSON.stringify(evidence).length;
    length > EMITTED_EVIDENCE_MAX_CHARS && budget > 0;
    length = JSON.stringify(evidence).length
  ) {
    budget -= length - EMITTED_EVIDENCE_MAX_CHARS
    evidence = { ...base, transcript: excerptEvidence(full, Math.max(0, budget)) }
  }
  return evidence
}

function renderTranscript(transcript: readonly MultishotMessage[]): string {
  return transcript
    .map((message) => {
      if (message.role === 'tool') {
        return `tool: ${excerptEvidence(message.content, TOOL_RESULT_MAX_CHARS)}`
      }
      if (message.role === 'user') return `user: ${message.content}`
      const calls = message.toolCalls?.map((call) => call.name) ?? []
      const called = calls.length > 0 ? ` [called ${calls.join(', ')}]` : ''
      return `agent: ${message.content}${called}`
    })
    .join('\n')
}
