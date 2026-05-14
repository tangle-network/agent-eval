/**
 * Workspace inspector — score the persisted state of an agent after a run.
 *
 * Many evals don't ask "did the response say the right thing" but "did the
 * agent put the right rows in the DB / files in the vault / entities on the
 * canvas". This is the primitive for that.
 *
 * Implementations read from D1, KV, filesystem, or any store — the interface
 * is deliberately small so consumers plug in their own backends.
 */

export interface WorkspaceSnapshot {
  /** Vault files: logical path → content */
  files: Record<string, string>
  /** DB rows: table name → array of rows (post-validation) */
  rows: Record<string, Array<Record<string, unknown>>>
  /** KV entries: key → value (scoped to whatever prefix the inspector chose) */
  kv: Record<string, string>
  /** Free-form blob metadata: for large binaries the inspector stores summary, not bytes */
  blobs?: Record<string, { size: number; hash?: string; mimeType?: string }>
}

export interface InspectorContext {
  /** Workspace / agent / thread id — whatever the backend uses to scope the snapshot */
  scopeId: string
  /** Optional scenario id — allows scenario-specific snapshot shaping */
  scenarioId?: string
}

export interface WorkspaceInspector {
  name: string
  snapshot(context: InspectorContext): Promise<WorkspaceSnapshot>
}

// ---------------------------------------------------------------------------
// In-memory inspector — useful for tests, not for production
// ---------------------------------------------------------------------------

export class InMemoryWorkspaceInspector implements WorkspaceInspector {
  readonly name = 'in-memory'
  private readonly snapshots = new Map<string, WorkspaceSnapshot>()

  set(scopeId: string, snapshot: WorkspaceSnapshot): void {
    this.snapshots.set(scopeId, snapshot)
  }

  async snapshot(context: InspectorContext): Promise<WorkspaceSnapshot> {
    return this.snapshots.get(context.scopeId) ?? { files: {}, rows: {}, kv: {} }
  }
}

// ---------------------------------------------------------------------------
// Snapshot-level assertions
// ---------------------------------------------------------------------------

export interface WorkspaceAssertion {
  name: string
  description?: string
  check(snapshot: WorkspaceSnapshot): WorkspaceAssertionResult
}

export interface WorkspaceAssertionResult {
  pass: boolean
  /** 0..1 — partial credit for assertions that admit it */
  score: number
  detail?: string
}

export function fileExists(path: string): WorkspaceAssertion {
  return {
    name: `file_exists:${path}`,
    check(snapshot) {
      const pass = path in snapshot.files
      return {
        pass,
        score: pass ? 1 : 0,
        detail: pass ? undefined : `No file at ${path}`,
      }
    },
  }
}

export function fileContains(path: string, needle: string): WorkspaceAssertion {
  return {
    name: `file_contains:${path}:${needle}`,
    check(snapshot) {
      const content = snapshot.files[path]
      if (content === undefined) {
        return { pass: false, score: 0, detail: `File ${path} missing` }
      }
      const pass = content.includes(needle)
      return {
        pass,
        score: pass ? 1 : 0,
        detail: pass ? undefined : `File ${path} missing substring "${needle}"`,
      }
    },
  }
}

export function rowCount(table: string, min: number, max?: number): WorkspaceAssertion {
  return {
    name: `row_count:${table}:[${min},${max ?? '∞'}]`,
    check(snapshot) {
      const rows = snapshot.rows[table] ?? []
      const count = rows.length
      const upper = max ?? Infinity
      const pass = count >= min && count <= upper
      const score = pass ? 1 : count < min ? Math.max(0, count / min) : Math.max(0, upper / count)
      return {
        pass,
        score,
        detail: pass
          ? undefined
          : `Table ${table} has ${count} rows, expected [${min}, ${max ?? '∞'}]`,
      }
    },
  }
}

export function rowWhere<T extends Record<string, unknown>>(
  table: string,
  predicate: (row: T) => boolean,
  options?: { min?: number },
): WorkspaceAssertion {
  const min = options?.min ?? 1
  return {
    name: `row_where:${table}`,
    check(snapshot) {
      const rows = (snapshot.rows[table] ?? []) as T[]
      const matching = rows.filter(predicate).length
      const pass = matching >= min
      return {
        pass,
        score: pass ? 1 : Math.max(0, matching / min),
        detail: pass
          ? undefined
          : `Table ${table} has ${matching} matching rows, expected ≥ ${min}`,
      }
    },
  }
}

/** Run many assertions; return aggregate pass + mean score + per-assertion details. */
export function runAssertions(
  snapshot: WorkspaceSnapshot,
  assertions: WorkspaceAssertion[],
): {
  pass: boolean
  score: number
  results: Array<{ assertion: string; result: WorkspaceAssertionResult }>
} {
  const results = assertions.map((a) => ({ assertion: a.name, result: a.check(snapshot) }))
  const pass = results.every((r) => r.result.pass)
  const score = results.length
    ? results.reduce((acc, r) => acc + r.result.score, 0) / results.length
    : 1
  return { pass, score, results }
}
