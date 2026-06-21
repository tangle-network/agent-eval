import { createHash } from 'node:crypto'
import type { AgentProfile } from '@tangle-network/agent-interface'
import { ValidationError } from './errors'
import { canonicalize } from './pre-registration'

export type { AgentProfile } from '@tangle-network/agent-interface'

/**
 * Human-readable profile id for eval artifacts. This is a label, not behaviour
 * identity; scorecard joins use `agentProfileHash`.
 */
export function agentProfileId(profile: AgentProfile): string {
  const id = profile.name?.trim() || profile.version?.trim()
  if (id) return id
  return `profile-${agentProfileHash(profile).slice(0, 12)}`
}

/**
 * Model snapshot used for `RunRecord.model`. Eval surfaces require a concrete
 * model id because run records reject bare/missing model aliases.
 */
export function agentProfileModelId(profile: AgentProfile): string {
  const model = profile.model?.default?.trim()
  if (!model) {
    throw new ValidationError('AgentProfile has no model.default — cannot record eval run')
  }
  return model
}

function compact<T extends Record<string, unknown>>(input: T): T {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) out[key] = value
  }
  return out as T
}

/**
 * Deterministic behaviour identity for the canonical
 * `@tangle-network/agent-interface` AgentProfile.
 *
 * `name` and `description` are labels and do not affect the hash. Profile
 * `version`, prompt, model hints, tools, resources, hooks, modes, permissions,
 * and extensions do affect the hash.
 */
export function agentProfileHash(profile: AgentProfile): string {
  const model = agentProfileModelId(profile)
  const behaviour = {
    ...profile,
    name: undefined,
    description: undefined,
    tags: profile.tags ? [...profile.tags].sort() : undefined,
    model: compact({ ...profile.model, default: model }),
  }
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(behaviour)))
    .digest('hex')
}
