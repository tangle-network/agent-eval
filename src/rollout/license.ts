/**
 * Who may train on a rollout line, read from who produced it.
 *
 * `policy.model` and `policy.provider` already name the producer model and the
 * serving provider; `policy.license_class` states the terms those outputs carry:
 *
 *   - `open-weight-api` — an open-weight model (GLM, DeepSeek, Kimi, Qwen…),
 *                         whichever API served it.
 *   - `restricted`      — Claude, Codex and Jev outputs. Their terms bar training
 *                         a competing model, so no training export emits them.
 *   - `evaluation-only` — data licensed for measurement, never for training.
 *   - `human`           — written by a person.
 *
 * Importers state the class. A line that does not is classified from its model
 * and harness names, restricted patterns first, so `claude-*` on any harness and
 * the `codex` harness on any model stay restricted. A line nothing classifies is
 * `null` and is not refused by this rule: only the two named classes are.
 */

import type { RolloutLine } from './schema'

export type LicenseClass = 'open-weight-api' | 'restricted' | 'evaluation-only' | 'human'
export const LICENSE_CLASSES: readonly LicenseClass[] = [
  'open-weight-api',
  'restricted',
  'evaluation-only',
  'human',
]

/** The classes a training export emits unless the caller names others. */
export const TRAINABLE_LICENSE_CLASSES: readonly LicenseClass[] = ['open-weight-api', 'human']

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

/** `null` (unclassified) passes; a named class must be in `allowed`. */
export function isLicenseEligible(
  line: Pick<RolloutLine, 'policy'>,
  allowed: readonly LicenseClass[] = TRAINABLE_LICENSE_CLASSES,
): boolean {
  const license = licenseClassOf(line)
  return license === null || allowed.includes(license)
}
