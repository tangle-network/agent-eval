import { createHash } from 'node:crypto'
import type { AgentProfile } from '@tangle-network/agent-interface'
import { type HarnessType, harnessSupportsModel } from '@tangle-network/agent-interface'
import { ValidationError } from './errors'
import { canonicalize } from './pre-registration'

export type { AgentProfile, HarnessType } from '@tangle-network/agent-interface'

/**
 * The agentic coding harnesses an eval sweeps by default — the ones we care about
 * ranking. This is the SINGLE source of that list; consumers import it instead of
 * re-declaring their own (a re-declared list is how the fleet drifts). Pass an
 * explicit `harnesses` (e.g. `harnessTypeSchema.options` for literally every known
 * harness) to widen beyond these.
 */
export const CODING_HARNESSES: readonly HarnessType[] = [
  'opencode',
  'claude-code',
  'codex',
  'kimi-code',
]

export interface ProfileAxisSpec {
  /** The domain profile to sweep. Its prompt/tools/skills are held fixed; only the
   *  harness and model vary. `model.default` is the fallback model. */
  base: AgentProfile
  /** Harnesses to cross. Default: {@link CODING_HARNESSES}. */
  harnesses?: readonly HarnessType[]
  /** Models to cross. Default: `[base.model.default]` — one model, i.e. today's
   *  single-model behaviour, so omitting this never changes an existing run. */
  models?: readonly string[]
  /** Keep (harness, model) pairs the harness can't run instead of dropping them.
   *  Default: drop (via `harnessSupportsModel`), so a vendor-locked harness paired
   *  with a foreign model doesn't become a guaranteed-failing cell. */
  keepIncompatible?: boolean
}

/**
 * Expand a base profile across the harness × model matrix into the `AgentProfile[]`
 * that `runProfileMatrix` / `selfImprove` score — the ONE place "which harnesses ×
 * which models do we evaluate" lives, so no product hand-rolls its own harness list
 * or column→profile mapping (the pattern that let those copies drift and silently
 * break the harness pivot).
 *
 * Each cell clones `base`, sets `model.default`, and stamps `metadata.harness` +
 * `metadata.harnessModel` (both hash-bearing, so every cell gets a distinct
 * `agentProfileId` row and results join back by harness/model via {@link harnessAxisOf}
 * with no hand-recomputed key). Incompatible pairs are dropped unless `keepIncompatible`.
 *
 * Omit `harnesses`/`models` to sweep the full default set — the "turn it on for
 * everything we care about" switch, identical in shape whether one harness or all.
 */
export function expandProfileAxes(spec: ProfileAxisSpec): AgentProfile[] {
  const harnesses = spec.harnesses ?? CODING_HARNESSES
  if (harnesses.length === 0) throw new ValidationError('expandProfileAxes: no harnesses to sweep')
  const baseModel = spec.base.model?.default
  const models = spec.models ?? (baseModel ? [baseModel] : [])
  if (models.length === 0) {
    throw new ValidationError(
      'expandProfileAxes: no models to sweep — base profile has no model.default and none were supplied',
    )
  }
  const out: AgentProfile[] = []
  const seen = new Set<string>()
  for (const harness of harnesses) {
    for (const model of models) {
      if (!spec.keepIncompatible && !harnessSupportsModel(harness, model)) continue
      const profile: AgentProfile = {
        ...spec.base,
        name: `${spec.base.name ?? 'agent'}/${harness}/${model}`,
        model: { ...spec.base.model, default: model },
        metadata: { ...(spec.base.metadata ?? {}), harness, harnessModel: model },
      }
      const id = agentProfileId(profile)
      if (seen.has(id)) continue
      seen.add(id)
      out.push(profile)
    }
  }
  if (out.length === 0) {
    throw new ValidationError(
      `expandProfileAxes: every (harness, model) pair was incompatible (harnesses=[${harnesses.join(', ')}], models=[${models.join(', ')}]). Widen the models or pass keepIncompatible.`,
    )
  }
  return out
}

/**
 * Read the (harness, model) a matrix cell ran under, off a profile or a result row's
 * profile — the join-back for a `byHarness` pivot. Returns undefined when the profile
 * wasn't produced by {@link expandProfileAxes}. Callers group `result.byProfile` by
 * this instead of recomputing an id (recomputing the wrong key is what broke the pivot
 * in the hand-rolled copies).
 */
export function harnessAxisOf(
  profile: Pick<AgentProfile, 'metadata'>,
): { harness: HarnessType; model: string } | undefined {
  const m = profile.metadata as Record<string, unknown> | undefined
  const harness = m?.harness
  const model = m?.harnessModel
  if (typeof harness === 'string' && typeof model === 'string') {
    return { harness: harness as HarnessType, model }
  }
  return undefined
}

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
