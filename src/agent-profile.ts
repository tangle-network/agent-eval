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
  /** Force every (harness, model) pair verbatim, even ones the harness can't run —
   *  for deliberately testing failure modes. Default (false): SNAP instead — a
   *  vendor-locked harness runs only the swept models in its family, or its native
   *  default when it supports none, so no harness is dropped and none gets a
   *  guaranteed-failing foreign-model cell. */
  keepIncompatible?: boolean
}

/** Model sentinel for a vendor-locked harness that supports none of the swept models:
 *  it carries no provider prefix, so `harnessSupportsModel` accepts it and the harness
 *  resolves it to its own native default model at runtime (e.g. kimi-code → its Kimi
 *  model). Lets `expandProfileAxes` snap-instead-of-drop without a per-harness flagship
 *  table that would rot as router catalogs change. */
export const HARNESS_NATIVE_MODEL = 'default'

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
 * with no hand-recomputed key). A vendor-locked harness snaps to its family's swept
 * models — or its native default ({@link HARNESS_NATIVE_MODEL}) when it supports none —
 * so every requested harness runs; `keepIncompatible` forces every pair verbatim.
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
    // A universal (router-backed) harness — opencode/pi/claudish — runs every swept
    // model. A vendor-locked harness — codex/claude-code/kimi-code — runs only the
    // swept models in its own family; when it supports NONE of them it snaps to its
    // native default (the `HARNESS_NATIVE_MODEL` sentinel it resolves at runtime)
    // rather than being dropped, so every requested harness still appears in the
    // sweep on a model it can actually run — e.g. sweeping `deepseek/x` puts opencode
    // on deepseek and kimi-code on its own Kimi model, a real head-to-head.
    // `keepIncompatible` forces every (harness, model) pair verbatim (failure-mode runs).
    const supported = spec.keepIncompatible
      ? models
      : models.filter((model) => harnessSupportsModel(harness, model))
    const effective = supported.length > 0 ? supported : [HARNESS_NATIVE_MODEL]
    for (const model of effective) {
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
    // Unreachable in normal use — snapping guarantees ≥1 cell per harness — but keep a
    // fail-closed guard so a future refactor can't silently produce an empty sweep.
    throw new ValidationError(
      `expandProfileAxes: produced no profiles (harnesses=[${harnesses.join(', ')}], models=[${models.join(', ')}]).`,
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
