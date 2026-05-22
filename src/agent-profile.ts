/**
 * @deprecated Use AgentProfileCell from agent-profile-cell instead. Will be removed in a future release.
 *
 * AgentProfile — the eval harness's unit of variation.
 *
 * A profile pins everything that changes agent behaviour for a benchmark
 * cell: the model, the active skills, the prompt version, the available
 * tools. Vary the profile — swap a model, add a skill — and re-run the suite
 * to benchmark the change. The scorecard keys a cell on
 * `(scenarioId, profileHash)`, so the model is not a separate axis: it lives
 * inside the profile, and two profiles with the same model but different
 * skills are different cells.
 *
 * `agentProfileHash` is the profile's behaviour identity. Two profiles that
 * produce the same agent behaviour share a hash (and a scorecard cell);
 * reordering `skills` or `tools` does not change it; the human-facing `id`
 * label does not affect it.
 */

import { createHash } from 'node:crypto'
import { ValidationError } from './errors'
import { canonicalize } from './pre-registration'

export interface AgentProfile {
  /** Human-facing label, e.g. `sonnet-legal-skills-v3`. Not part of the hash. */
  id: string
  /** Model snapshot id this profile pins, e.g. `claude-sonnet-4-6@2025-04-15`. */
  model: string
  /** Skill ids/versions active in this profile — the primary behaviour lever. */
  skills?: string[]
  /** Prompt version identifier. */
  promptVersion?: string
  /** Tool ids available to the agent. */
  tools?: string[]
  /** Any other behaviour-bearing knobs that should fingerprint into the hash. */
  metadata?: Record<string, string | number | boolean>
}

/**
 * Deterministic behaviour identity of a profile — a sha256 over the
 * behaviour-bearing fields. `skills` and `tools` are order-insensitive; the
 * `id` label is excluded. Throws on a profile with no `model` — an unkeyable
 * profile must fail loud rather than collapse into a blank-model cell.
 */
export function agentProfileHash(profile: AgentProfile): string {
  if (typeof profile.model !== 'string' || profile.model.trim().length === 0) {
    throw new ValidationError(`AgentProfile "${profile.id}" has no model — cannot hash`)
  }
  const behaviour = {
    model: profile.model.trim(),
    skills: [...(profile.skills ?? [])].sort(),
    promptVersion: profile.promptVersion ?? null,
    tools: [...(profile.tools ?? [])].sort(),
    metadata: profile.metadata ?? {},
  }
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(behaviour)))
    .digest('hex')
}
