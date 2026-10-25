/**
 * The terms a rollout line's outputs carry, read from who produced it.
 *
 * `policy.model` and `policy.provider` already name the producer model and the
 * serving provider; `policy.license_class` states the terms those outputs carry:
 *
 *   - `open-weight-api` — an open-weight model (GLM, DeepSeek, Kimi, Qwen…),
 *                         whichever API served it.
 *   - `restricted`      — Claude, Codex and Jev outputs, whose provider terms
 *                         restrict training a competing model.
 *   - `evaluation-only` — data licensed for measurement.
 *   - `human`           — written by a person.
 *
 * Importers state the class. A line that does not is classified from its model
 * and harness names, restricted patterns first, so `claude-*` on any harness and
 * the `codex` harness on any model stay restricted. A line nothing classifies is
 * `null`.
 *
 * The class is provenance, not a default filter: every class trains unless a run
 * names the classes it accepts (Drew, 2026-10-25: train on everything), so a
 * dataset can be re-cut by class later without re-importing.
 */

import type { RolloutLine } from './schema'

export type LicenseClass = 'open-weight-api' | 'restricted' | 'evaluation-only' | 'human'
export const LICENSE_CLASSES: readonly LicenseClass[] = [
  'open-weight-api',
  'restricted',
  'evaluation-only',
  'human',
]

const RESTRICTED = /claude|anthropic|\b(?:opus|sonnet|haiku|fable)\b|codex|\bjev\b/i
const OPEN_WEIGHT =
  /\b(?:glm|deepseek|kimi|moonshot|qwen|llama|mistral|mixtral|gemma|minimax|gpt-oss|olmo|phi)/i

/** Classify a model or harness name; `null` when it names no known family. */
export function licenseClassOfName(name: string | null | undefined): LicenseClass | null {
  if (!name) return null
  if (RESTRICTED.test(name)) return 'restricted'
  if (OPEN_WEIGHT.test(name)) return 'open-weight-api'
  return null
}

/** The line's stated class, else the class its model or harness implies. */
export function licenseClassOf(line: Pick<RolloutLine, 'policy'>): LicenseClass | null {
  const { license_class, model, harness } = line.policy
  if (license_class !== undefined) return license_class
  const byHarness = licenseClassOfName(harness)
  if (byHarness === 'restricted') return byHarness
  return licenseClassOfName(model) ?? byHarness
}

/** Every line passes without `allowed`; with it, the line's class must be listed. */
export function isLicenseEligible(
  line: Pick<RolloutLine, 'policy'>,
  allowed?: readonly LicenseClass[],
): boolean {
  if (allowed === undefined) return true
  const license = licenseClassOf(line)
  return license !== null && allowed.includes(license)
}
