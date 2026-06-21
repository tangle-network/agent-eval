import { createHash } from 'node:crypto'
import type { AgentProfile } from '@tangle-network/agent-interface'
import { ValidationError } from './errors'
import { canonicalize } from './pre-registration'

export type { AgentProfile } from '@tangle-network/agent-interface'

/**
 * Collision-resistant, path-safe, human-readable profile id for eval artifacts.
 * Scorecard joins still use `agentProfileHash`; this id is for run ids, matrix
 * keys, and directory names where two profiles must not collapse onto one row.
 * The suffix is the first 64 bits of the behaviour hash, enough for ordinary
 * eval matrices while keeping filenames readable.
 */
export function agentProfileId(profile: AgentProfile): string {
  const label = pathSafeProfileLabel(agentProfileDisplayLabel(profile)) ?? 'profile'
  return `${label}-${agentProfileHash(profile).slice(0, 16)}`
}

/**
 * Model snapshot used for `RunRecord.model`. Eval surfaces require a concrete
 * model id because run records reject bare/missing model aliases.
 */
export function agentProfileModelId(profile: AgentProfile): string {
  const model = profile.model?.default?.trim()
  if (!model) {
    const label = agentProfileDisplayLabel(profile) ?? 'unnamed profile'
    throw new ValidationError(
      `AgentProfile "${label}" has no model.default — cannot record eval run`,
    )
  }
  return model
}

function agentProfileDisplayLabel(profile: AgentProfile): string | undefined {
  return profile.name?.trim() || profile.version?.trim() || undefined
}

function pathSafeProfileLabel(label: string | undefined): string | undefined {
  const safe = label
    ?.trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
  return safe || undefined
}

function compact<T extends Record<string, unknown>>(input: T): Partial<T> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) out[key] = value
  }
  return out as Partial<T>
}

/**
 * Deterministic behaviour identity for the canonical
 * `@tangle-network/agent-interface` AgentProfile.
 *
 * `name` and `description` are labels and do not affect the hash. Profile
 * `version`, prompt, model hints, tools, resources, hooks, modes, permissions,
 * and extensions do affect the hash. Resource array order is hash-bearing
 * because mount order can change agent behaviour. Undefined fields are treated
 * as absent; explicit `null` fields remain hash-bearing.
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
