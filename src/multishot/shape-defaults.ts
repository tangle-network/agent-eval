// Profile-derived defaults for MultishotShape — the pure-profile path.
//
// `MultishotShape`'s callbacks were REQUIRED beside `profile: AgentProfile`,
// which mixed the abstractions: the node under test was a profile, but the
// simulated user's role could only be expressed as code. These defaults make
// the callbacks optional — a pure-profile call works, and the derived prompts
// are plain data (a pure function of profile + persona payload), so an
// optimizer can sweep them (tangle-network/agent-runtime#694).

import type { AgentProfile } from '@tangle-network/agent-interface'
import type { MultishotPersona, MultishotShape } from './types'

/** Persona payload rendered as stable `- key: value` lines. `id` is identity,
 *  not voice, and structured values are serialized so nothing is dropped. */
export function renderPersonaFacts(persona: MultishotPersona): string {
  const lines: string[] = []
  for (const [key, value] of Object.entries(persona)) {
    if (key === 'id' || value === undefined) continue
    const rendered =
      typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
        ? String(value)
        : JSON.stringify(value)
    lines.push(`- ${key}: ${rendered}`)
  }
  return lines.join('\n')
}

/** Default opening user message: the persona introduces itself with its whole
 *  payload and asks the agent (as described by the profile) to take over. */
export function defaultMultishotOpener(profile: AgentProfile, persona: MultishotPersona): string {
  const facts = renderPersonaFacts(persona)
  const agentDescription = profile.description ?? profile.name ?? 'the agent'
  return [
    `Hi — I'm reaching out to ${agentDescription} for help. My situation:`,
    facts.length > 0 ? facts : `- (no details provided beyond id: ${persona.id})`,
    '',
    'Tell me what you need from me, and get started on my case.',
  ].join('\n')
}

/** Default driver system prompt: roleplay the persona from its payload, stay
 *  in character, push back on vague answers, and never go silent. */
export function defaultMultishotDriverSystemPrompt(
  profile: AgentProfile,
  persona: MultishotPersona,
): string {
  const facts = renderPersonaFacts(persona)
  const agentDescription = profile.description ?? profile.name ?? 'an AI agent'
  return [
    `You are role-playing a real person (persona "${persona.id}") talking to ${agentDescription}.`,
    facts.length > 0 ? `Who you are:\n${facts}` : '',
    '',
    'How to behave:',
    '- Stay in character: first person, realistic voice, concrete details from your situation.',
    '- Judge every reply by whether it actually moves YOUR case forward. Push back on vague, hedged, or generic answers and demand specifics.',
    "- Answer the agent's questions with information consistent with who you are; invent plausible details rather than stalling.",
    '- Never go silent: always produce a substantive next message.',
    '- Output ONLY your next message to the agent — no meta-commentary, no stage directions.',
  ]
    .filter((block) => block.length > 0)
    .join('\n')
}

/** The fully-resolved shape for a profile: caller overrides win, the
 *  profile-derived defaults fill the rest. */
export function defaultShapeFromProfile<TPersona extends MultishotPersona>(
  profile: AgentProfile,
  shape?: MultishotShape<TPersona>,
): Required<MultishotShape<TPersona>> {
  return {
    buildOpener: shape?.buildOpener ?? ((persona) => defaultMultishotOpener(profile, persona)),
    buildDriverSystemPrompt:
      shape?.buildDriverSystemPrompt ??
      ((persona) => defaultMultishotDriverSystemPrompt(profile, persona)),
  }
}
