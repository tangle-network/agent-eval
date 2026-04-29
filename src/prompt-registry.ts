/**
 * Versioned prompt registry.
 *
 * Every prompt used in an eval run is registered with an explicit version.
 * Reports include the content hash so A/B compares are rigorous: if the
 * hash changes between two reports, the prompt actually changed; if it
 * matches, the variance is elsewhere.
 *
 * Hash is SHA-256(content), truncated to 12 hex chars for readability.
 * Uses the Web Crypto API (works in Workers, Node 22+, browsers).
 */

export interface PromptHandle {
  /** Stable human-readable id, e.g. 'browser.system' */
  id: string
  /** Caller-chosen version string, e.g. 'v3' or '2026-04-20' */
  version: string
  /** SHA-256 of content, 12-hex-char prefix */
  hash: string
  /** Full prompt body */
  content: string
}

export class PromptRegistry {
  private readonly entries = new Map<string, PromptHandle>() // `${id}@${version}` → handle

  /**
   * Register a prompt. Re-registering the same id+version with DIFFERENT
   * content throws — versions are immutable. Re-registering with the SAME
   * content is a no-op (idempotent).
   */
  async register(id: string, version: string, content: string): Promise<PromptHandle> {
    validateId(id)
    validateVersion(version)

    const key = makeKey(id, version)
    const hash = await hashContent(content)
    const existing = this.entries.get(key)
    if (existing) {
      if (existing.hash !== hash) {
        throw new Error(
          `Prompt ${key} already registered with a different hash (${existing.hash} vs ${hash}). Bump the version.`,
        )
      }
      return existing
    }
    const handle: PromptHandle = { id, version, hash, content }
    this.entries.set(key, handle)
    return handle
  }

  /** Look up a registered prompt. Throws if unknown — no implicit defaults. */
  get(id: string, version: string): PromptHandle {
    const key = makeKey(id, version)
    const handle = this.entries.get(key)
    if (!handle) throw new Error(`Prompt ${key} not registered`)
    return handle
  }

  /** Return all versions of an id, newest-first (lex-descending on version). */
  listVersions(id: string): PromptHandle[] {
    return [...this.entries.values()]
      .filter((h) => h.id === id)
      .sort((a, b) => b.version.localeCompare(a.version))
  }

  /** Snapshot the whole registry — useful for including in reports. */
  list(): PromptHandle[] {
    return [...this.entries.values()]
  }

  /** Verify a hash against registered content. Returns null if not found. */
  verifyHash(id: string, version: string, expectedHash: string): boolean | null {
    const handle = this.entries.get(makeKey(id, version))
    if (!handle) return null
    return handle.hash === expectedHash
  }
}

/** SHA-256(content) → first 12 hex chars. Stable across runtimes. */
export async function hashContent(content: string): Promise<string> {
  const bytes = new TextEncoder().encode(content)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  const full = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
  return full.slice(0, 12)
}

function makeKey(id: string, version: string): string {
  return `${id}@${version}`
}

const ID_RE = /^[a-z][a-z0-9._-]*$/i
function validateId(id: string): void {
  if (!ID_RE.test(id)) {
    throw new Error(`Invalid prompt id "${id}": must match ${ID_RE}`)
  }
}

function validateVersion(version: string): void {
  if (!version || version.length > 64) {
    throw new Error(`Invalid version "${version}": must be 1–64 chars`)
  }
}
