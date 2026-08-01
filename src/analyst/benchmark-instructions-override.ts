import { readFileSync } from 'node:fs'
import { publicBenchmarkProtocolSha256 } from './benchmark-public-prompt'
import type {
  AnalystInstructionsOverride,
  PublicAnalystBenchmarkDataset,
} from './benchmark-public-types'
import { sha256Digest } from './benchmark-verification-artifacts'

/** Build an override from instruction text. Blank text is a caller error. */
export function analystInstructionsOverrideFromText(text: string): AnalystInstructionsOverride {
  if (typeof text !== 'string' || !text.trim()) {
    throw new Error('analyst instructions override must contain non-empty instruction text')
  }
  return { text, sha256: sha256Digest(text) }
}

/** Read override instructions from a file. Any read failure is fatal. */
export function readAnalystInstructionsOverride(path: string): AnalystInstructionsOverride {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    throw new Error(
      `cannot read --instructions-file '${path}': ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (!text.trim()) {
    throw new Error(`--instructions-file '${path}' is empty; refusing to run without instructions`)
  }
  return analystInstructionsOverrideFromText(text)
}

/**
 * Protocol digest of the run as executed.
 *
 * Without an override this is exactly `publicBenchmarkProtocolSha256(dataset)`,
 * so stock runs stay byte-identical to runs recorded before the override
 * existed. With an override the digest binds the stock protocol digest (which
 * covers both shipped prompts, including the abstention fallback's direct
 * prompt) to the exact override text, so the recorded digest always hashes the
 * instructions that actually ran.
 */
export function effectiveAnalystProtocolSha256(
  dataset: PublicAnalystBenchmarkDataset,
  override?: Pick<AnalystInstructionsOverride, 'sha256'>,
): string {
  const stock = publicBenchmarkProtocolSha256(dataset)
  if (!override) return stock
  return sha256Digest(
    JSON.stringify({
      kind: 'analyst-instructions-override-protocol',
      dataset,
      stockProtocolSha256: stock,
      rlmInstructionsSha256: override.sha256,
    }),
  )
}
