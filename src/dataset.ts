/**
 * Dataset — versioned, sliceable, content-hashed scenario collection.
 *
 * Scenarios stop being ephemeral arrays and become first-class
 * artifacts. Every Dataset carries:
 *   - content hash (sha256 over canonicalized scenario array)
 *   - provenance (contributor, createdAt, sourceUrl)
 *   - split labels (train | dev | test | holdout)
 *   - difficulty tiers (easy | medium | hard | extreme)
 *   - tags (free-form, per-scenario)
 *
 * `Dataset.slice({ difficulty, split, holdout, seed })` returns a
 * deterministic, reproducible subset. Holdout slices are locked: you
 * can read them but `mutate` throws, which prevents "oh I'll just
 * tweak that one scenario" contamination drift.
 */

export type DatasetSplit = 'train' | 'dev' | 'test' | 'holdout'
export type DatasetDifficulty = 'easy' | 'medium' | 'hard' | 'extreme'

export interface DatasetScenario {
  id: string
  /** Arbitrary payload; the framework doesn't interpret it. */
  payload: unknown
  split?: DatasetSplit
  difficulty?: DatasetDifficulty
  /** Canary token that MUST NOT round-trip through a correct agent output. */
  canary?: string
  /**
   * Behavioral-canary forbidden pattern. A string OR a serialized regex
   * (`/.../flags`) that the agent under test MUST NOT emit. Used by
   * {@link import('./canary').checkBehavioralCanary | checkBehavioralCanary},
   * which inverts the contamination-style semantic: presence in the
   * agent output is a LEAK / failure, not a positive signal.
   *
   * Falls back to {@link canary} when omitted.
   */
  forbiddenPattern?: string
  tags?: Record<string, string>
}

export interface DatasetProvenance {
  contributor?: string
  createdAt: string
  sourceUrl?: string
  license?: string
  description?: string
  /** Monotonic human-readable version (e.g. "2026.04.20"). */
  version: string
}

export interface DatasetManifest {
  name: string
  provenance: DatasetProvenance
  /** sha256 hex over canonicalized scenarios. */
  contentHash: string
  scenarioCount: number
  splitCounts: Record<DatasetSplit, number>
}

export interface SliceOptions {
  split?: DatasetSplit
  difficulty?: DatasetDifficulty
  /** Number of scenarios (random sample, seeded). Omit to take all that match. */
  limit?: number
  seed?: number
  /** Predicate narrowing. Applied after split/difficulty filters. */
  filter?: (scenario: DatasetScenario) => boolean
  /** If true, include scenarios marked as holdout. Default false. */
  includeHoldout?: boolean
}

import { ValidationError } from './errors'

/** Locked holdouts — throws on mutate. Callers that need a mutable dataset fork it. */
export class HoldoutLockedError extends ValidationError {
  constructor(datasetName: string) {
    super(
      `Dataset "${datasetName}" is holdout-locked; mutations are not permitted. Fork with .clone() if you need to mutate.`,
    )
  }
}

export class Dataset {
  readonly name: string
  readonly provenance: DatasetProvenance
  private scenarios: DatasetScenario[]
  private locked: boolean

  constructor(init: {
    name: string
    provenance: DatasetProvenance
    scenarios: DatasetScenario[]
    locked?: boolean
  }) {
    this.name = init.name
    this.provenance = init.provenance
    this.scenarios = [...init.scenarios]
    this.locked = !!init.locked
  }

  /** All scenarios. Readonly — callers must go through `slice` or `clone`. */
  all(): readonly DatasetScenario[] {
    return this.scenarios
  }

  get size(): number {
    return this.scenarios.length
  }

  /**
   * Deterministic sliced subset. Seed is REQUIRED when `limit` is set so
   * the same arguments always produce the same slice across machines.
   */
  slice(options: SliceOptions = {}): DatasetScenario[] {
    let working = this.scenarios.filter((s) => {
      if (!options.includeHoldout && s.split === 'holdout') return false
      if (options.split && s.split !== options.split) return false
      if (options.difficulty && s.difficulty !== options.difficulty) return false
      if (options.filter && !options.filter(s)) return false
      return true
    })
    if (options.limit !== undefined && options.limit < working.length) {
      if (options.seed === undefined) {
        throw new Error('Dataset.slice: seed is required when limit is set, for reproducibility')
      }
      working = seededShuffle(working, options.seed).slice(0, options.limit)
    }
    return working
  }

  /**
   * Assemble the manifest (name + provenance + content hash + counts).
   * Content hash is deterministic over canonicalized scenarios.
   */
  async manifest(): Promise<DatasetManifest> {
    const splitCounts: Record<DatasetSplit, number> = { train: 0, dev: 0, test: 0, holdout: 0 }
    for (const s of this.scenarios) {
      const split = (s.split ?? 'train') as DatasetSplit
      splitCounts[split]++
    }
    return {
      name: this.name,
      provenance: this.provenance,
      contentHash: await hashScenarios(this.scenarios),
      scenarioCount: this.scenarios.length,
      splitCounts,
    }
  }

  /** Fresh unlocked copy — for post-release forks when mutation is needed. */
  clone(overrides: Partial<{ name: string; version: string }> = {}): Dataset {
    return new Dataset({
      name: overrides.name ?? this.name,
      provenance: overrides.version
        ? { ...this.provenance, version: overrides.version }
        : this.provenance,
      scenarios: this.scenarios,
      locked: false,
    })
  }

  lock(): void {
    this.locked = true
  }

  add(scenario: DatasetScenario): void {
    if (this.locked) throw new HoldoutLockedError(this.name)
    if (this.scenarios.some((s) => s.id === scenario.id)) {
      throw new Error(`Dataset.add: duplicate scenario id "${scenario.id}"`)
    }
    this.scenarios.push(scenario)
  }

  remove(scenarioId: string): void {
    if (this.locked) throw new HoldoutLockedError(this.name)
    const idx = this.scenarios.findIndex((s) => s.id === scenarioId)
    if (idx < 0) throw new Error(`Dataset.remove: unknown id "${scenarioId}"`)
    this.scenarios.splice(idx, 1)
  }

  /**
   * Stable JSON-Lines serialization — deterministic byte-for-byte.
   * Write to disk for contamination-verifiable archives.
   */
  toJsonl(): string {
    return `${this.scenarios
      .slice()
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((s) => JSON.stringify(canonicalize(s)))
      .join('\n')}\n`
  }

  static fromJsonl(
    jsonl: string,
    manifest: Omit<DatasetManifest, 'contentHash' | 'scenarioCount' | 'splitCounts'>,
  ): Dataset {
    const scenarios: DatasetScenario[] = []
    for (const line of jsonl.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      scenarios.push(JSON.parse(trimmed) as DatasetScenario)
    }
    return new Dataset({ name: manifest.name, provenance: manifest.provenance, scenarios })
  }
}

// ── Hashing + seeded shuffle ─────────────────────────────────────────

export async function hashScenarios(scenarios: DatasetScenario[]): Promise<string> {
  const canonical = scenarios
    .slice()
    .sort((a, b) => a.id.localeCompare(b.id))
    .map(canonicalize)
  const text = JSON.stringify(canonical)
  const bytes = new TextEncoder().encode(text)
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

function canonicalize(v: unknown): unknown {
  if (v === null || typeof v !== 'object') return v
  if (Array.isArray(v)) return v.map(canonicalize)
  const keys = Object.keys(v as Record<string, unknown>).sort()
  const out: Record<string, unknown> = {}
  for (const k of keys) out[k] = canonicalize((v as Record<string, unknown>)[k])
  return out
}

/** Splitmix-ish deterministic shuffle — small, self-contained, no deps. */
function seededShuffle<T>(items: T[], seed: number): T[] {
  const out = [...items]
  let state = seed >>> 0
  for (let i = out.length - 1; i > 0; i--) {
    state = (state * 1103515245 + 12345) >>> 0
    const j = state % (i + 1)
    ;[out[i], out[j]] = [out[j]!, out[i]!]
  }
  return out
}
