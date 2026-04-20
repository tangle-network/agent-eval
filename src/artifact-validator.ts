/**
 * Artifact validators.
 *
 * Generic "score a produced artifact" primitive. Tax uses it for PDF form
 * correctness, legal for contract clauses, film for script breakdowns, GTM
 * for social posts. One interface, many validators; all plug into
 * `BenchmarkRunner` the same way.
 *
 * A validator receives an `Artifact` (file on disk, JSON blob, text, binary)
 * plus a `ValidationContext` (scenario id, the turns that produced it) and
 * returns a `ValidationResult` with pass/fail + 0..1 score + structured
 * issues.
 */

export interface Artifact {
  /** Logical kind — validators type-guard on this */
  kind: 'file' | 'json' | 'text' | 'binary' | string
  /** Filesystem-style path, optional */
  path?: string
  /** String content for text/json/file kinds */
  content?: string
  /** Binary content (if kind === 'binary') */
  bytes?: Uint8Array
  /** Caller-supplied metadata (mimeType, sha256, size, etc.) */
  metadata?: Record<string, unknown>
}

export interface ValidationContext {
  scenarioId: string
  turnIndex?: number
  /** Prior artifacts for multi-artifact scenarios */
  priorArtifacts?: Artifact[]
  /** Free-form hints the validator uses for domain-specific checks */
  hints?: Record<string, unknown>
}

export interface ValidationIssue {
  severity: 'error' | 'warning' | 'info'
  message: string
  /** Optional path into the artifact (e.g. JSON path or byte offset) */
  locus?: string
}

export interface ValidationResult {
  pass: boolean
  /** 0–1 normalized score. Validators should be monotonic in pass-ness. */
  score: number
  issues: ValidationIssue[]
  /** Diagnostic payload for reporters */
  evidence?: Record<string, unknown>
}

export interface ArtifactValidator {
  /** Stable identifier for the validator; appears in reports. */
  name: string
  /** Optional description for human-facing reports. */
  description?: string
  /** Called once per artifact; validators are expected to be pure + idempotent. */
  validate(artifact: Artifact, context: ValidationContext): Promise<ValidationResult>
}

// ---------------------------------------------------------------------------
// Composable validators
// ---------------------------------------------------------------------------

/**
 * Run every validator on the same artifact; aggregate pass as AND, score as
 * (weighted) mean, issues concatenated. Weights default to 1 each.
 */
export function composeValidators(
  validators: ArtifactValidator[],
  options?: { name?: string; weights?: number[] },
): ArtifactValidator {
  const weights = options?.weights ?? validators.map(() => 1)
  if (weights.length !== validators.length) {
    throw new Error('composeValidators: weights length mismatch')
  }
  const totalWeight = weights.reduce((a, b) => a + b, 0) || 1
  return {
    name: options?.name ?? validators.map((v) => v.name).join('+'),
    async validate(artifact, ctx) {
      const results = await Promise.all(validators.map((v) => v.validate(artifact, ctx)))
      const pass = results.every((r) => r.pass)
      const score =
        results.reduce((acc, r, i) => acc + r.score * weights[i], 0) / totalWeight
      return {
        pass,
        score,
        issues: results.flatMap((r, i) =>
          r.issues.map((issue) => ({
            ...issue,
            locus: issue.locus ? `${validators[i].name}:${issue.locus}` : validators[i].name,
          })),
        ),
        evidence: Object.fromEntries(results.map((r, i) => [validators[i].name, r.evidence])),
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Built-in validators
// ---------------------------------------------------------------------------

/** Pass if the artifact body matches a provided regex. */
export function regexMatch(name: string, pattern: RegExp): ArtifactValidator {
  return {
    name,
    async validate(artifact) {
      const body = artifact.content ?? ''
      const ok = pattern.test(body)
      return {
        pass: ok,
        score: ok ? 1 : 0,
        issues: ok
          ? []
          : [{ severity: 'error', message: `Artifact content did not match ${pattern}` }],
      }
    },
  }
}

/** Pass if JSON parses and every required key is present. */
export function jsonHasKeys(name: string, requiredPaths: string[]): ArtifactValidator {
  return {
    name,
    async validate(artifact) {
      const body = artifact.content ?? ''
      let parsed: unknown
      try {
        parsed = JSON.parse(body) as unknown
      } catch (err) {
        return {
          pass: false,
          score: 0,
          issues: [{ severity: 'error', message: `Invalid JSON: ${err instanceof Error ? err.message : err}` }],
        }
      }
      const missing: string[] = []
      for (const path of requiredPaths) {
        if (!pathExists(parsed, path)) missing.push(path)
      }
      const pass = missing.length === 0
      return {
        pass,
        score: 1 - missing.length / Math.max(1, requiredPaths.length),
        issues: missing.map((p) => ({ severity: 'error' as const, message: `Missing path: ${p}`, locus: p })),
      }
    },
  }
}

/** Pass if min ≤ byte length ≤ max. */
export function byteLengthRange(name: string, min: number, max: number): ArtifactValidator {
  return {
    name,
    async validate(artifact) {
      const size = artifact.bytes?.byteLength ?? new TextEncoder().encode(artifact.content ?? '').byteLength
      const pass = size >= min && size <= max
      const score = pass
        ? 1
        : size < min
          ? Math.max(0, size / min)
          : Math.max(0, max / size)
      return {
        pass,
        score,
        issues: pass
          ? []
          : [{ severity: 'error', message: `Size ${size} outside [${min}, ${max}]` }],
      }
    },
  }
}

/** Pass if the artifact contains every required substring (case-insensitive by default). */
export function containsAll(
  name: string,
  required: string[],
  options?: { caseSensitive?: boolean },
): ArtifactValidator {
  const cs = options?.caseSensitive ?? false
  return {
    name,
    async validate(artifact) {
      const body = cs ? artifact.content ?? '' : (artifact.content ?? '').toLowerCase()
      const missing: string[] = []
      for (const needle of required) {
        const probe = cs ? needle : needle.toLowerCase()
        if (!body.includes(probe)) missing.push(needle)
      }
      const pass = missing.length === 0
      return {
        pass,
        score: 1 - missing.length / Math.max(1, required.length),
        issues: missing.map((m) => ({ severity: 'error' as const, message: `Missing substring: ${m}` })),
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pathExists(obj: unknown, path: string): boolean {
  const parts = path.split('.')
  let current: unknown = obj
  for (const part of parts) {
    if (current === null || typeof current !== 'object') return false
    const key = /^\d+$/.test(part) ? Number(part) : part
    current = (current as Record<string, unknown>)[key as unknown as string]
    if (current === undefined) return false
  }
  return true
}
