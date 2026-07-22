/**
 * Content-addressed judge-verdict caching.
 *
 * LAW: cache JUDGE VERDICTS only — judging the same artifact with the same
 * judge+rubric is pure. NEVER cache agent rollouts. (A router that cached
 * identical fanout prompts silently destroyed best-of-N diversity; rollout
 * caching reintroduces that failure class. Judging has no diversity to
 * destroy — same artifact + same rubric ⇒ same verdict is the desired
 * property, not a bug.)
 *
 * The cache key is a sha-256 over the canonical JSON of everything that can
 * change a verdict: the artifact content, the scenario id, the judge name,
 * the full dimension list (key + description — the description IS the rubric
 * text shown to the judge), and a caller-supplied `judgeVersion`.
 * `judgeVersion` is REQUIRED: a judge whose prompt/model/ensemble changes
 * without a version bump would otherwise silently serve stale verdicts.
 *
 * Strict canonicalization (`canonicalJson`) throws on undefined / function /
 * symbol / non-finite numbers — an artifact that cannot be unambiguously
 * serialized cannot be content-addressed, and coercing it would let two
 * different artifacts collide on one key.
 */

import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import type { JudgeConfig, JudgeScore, Scenario } from './campaign/types'

// ── canonical JSON + content hash ─────────────────────────────────────────

function canonicalizeAt(value: unknown, path: string): string {
  if (value === null) return 'null'
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false'
    case 'number':
      if (!Number.isFinite(value)) {
        throw new Error(
          `canonicalJson: non-finite number (${value}) at ${path} — ambiguity is an error, not a coercion`,
        )
      }
      return JSON.stringify(value)
    case 'string':
      return JSON.stringify(value)
    case 'undefined':
    case 'function':
    case 'symbol':
      throw new Error(
        `canonicalJson: ${typeof value} at ${path} — ambiguity is an error, not a coercion`,
      )
    case 'bigint':
      throw new Error(`canonicalJson: bigint at ${path} — not representable in JSON`)
    case 'object':
      break
  }
  const obj = value as Record<string, unknown>
  // Honor toJSON (Date → ISO string) before structural checks — without it a
  // Date would canonicalize to '{}' and every timestamp would collide.
  if (typeof obj.toJSON === 'function') {
    return canonicalizeAt((obj as { toJSON(): unknown }).toJSON(), path)
  }
  if (Array.isArray(obj)) {
    return `[${obj.map((item, i) => canonicalizeAt(item, `${path}[${i}]`)).join(',')}]`
  }
  if (obj instanceof Map || obj instanceof Set) {
    throw new Error(
      `canonicalJson: ${obj instanceof Map ? 'Map' : 'Set'} at ${path} — would serialize as '{}'; convert to a plain object/array first`,
    )
  }
  const keys = Object.keys(obj).sort()
  const parts = keys.map((k) => `${JSON.stringify(k)}:${canonicalizeAt(obj[k], `${path}.${k}`)}`)
  return `{${parts.join(',')}}`
}

/**
 * Stable JSON stringify: object keys sorted recursively, so two semantically
 * equal values produce byte-identical output regardless of key insertion
 * order. Throws on undefined / function / symbol / NaN / ±Infinity / bigint /
 * Map / Set — anything JSON.stringify would coerce or drop silently.
 *
 * Distinct from `pre-registration.ts`'s `canonicalize`/`hashJson`, which are
 * permissive (coercion allowed) and async (web-crypto). Use THIS pair when a
 * hash collision or silent coercion would corrupt a cache key or attestation.
 */
export function canonicalJson(value: unknown): string {
  return canonicalizeAt(value, '$')
}

/** Hex sha-256 over `canonicalJson(value)`. The content address used by the
 *  verdict cache and report attestation. */
export function contentHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

// ── store contract ─────────────────────────────────────────────────────────

/** Pluggable verdict store. Sync or async on both legs — `cachedJudge`
 *  awaits the results either way. */
export interface VerdictCacheStore {
  get(key: string): Promise<JudgeScore | undefined> | JudgeScore | undefined
  set(key: string, score: JudgeScore): Promise<void> | void
}

/** Process-local Map-backed store. */
export function inMemoryVerdictCache(): VerdictCacheStore {
  const entries = new Map<string, JudgeScore>()
  return {
    get: (key) => entries.get(key),
    set: (key, score) => {
      entries.set(key, score)
    },
  }
}

interface VerdictCacheLine {
  key: string
  score: JudgeScore
}

function parseCacheLine(line: string, path: string, lineNo: number): VerdictCacheLine {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch (err) {
    throw new Error(
      `fileVerdictCache: corrupt JSONL at ${path}:${lineNo} — ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  const rec = parsed as Partial<VerdictCacheLine>
  if (
    typeof rec !== 'object' ||
    rec === null ||
    typeof rec.key !== 'string' ||
    typeof rec.score !== 'object' ||
    rec.score === null ||
    typeof rec.score.composite !== 'number' ||
    typeof rec.score.dimensions !== 'object'
  ) {
    throw new Error(
      `fileVerdictCache: invalid record shape at ${path}:${lineNo} — expected {key, score:{dimensions, composite, notes}}`,
    )
  }
  return rec as VerdictCacheLine
}

/**
 * JSONL-file-backed store: the full file is loaded into an in-memory index at
 * construction; every `set` appends one line synchronously (durable before
 * the verdict is returned). A corrupt or malformed line throws at load with
 * file:line — a skipped line would silently re-judge (cost) or, worse, mask
 * a half-written file that needs operator attention.
 */
export function fileVerdictCache(path: string): VerdictCacheStore {
  const entries = new Map<string, JudgeScore>()
  if (existsSync(path)) {
    const lines = readFileSync(path, 'utf8').split('\n')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (line === undefined || line.trim() === '') continue
      const rec = parseCacheLine(line, path, i + 1)
      entries.set(rec.key, rec.score)
    }
  }
  return {
    get: (key) => entries.get(key),
    set: (key, score) => {
      appendFileSync(path, `${JSON.stringify({ key, score })}\n`, 'utf8')
      entries.set(key, score)
    },
  }
}

// ── cached judge wrapper ───────────────────────────────────────────────────

export interface VerdictCacheStats {
  hits: number
  misses: number
}

export interface CachedJudgeOptions {
  /** REQUIRED — part of the cache key. Bump on any change to the judge's
   *  prompt, model, ensemble, or scoring logic; silent judge upgrades must
   *  never serve stale verdicts. */
  judgeVersion: string
}

/** The wrapped judge: same `JudgeConfig` seam, plus hit/miss observability. */
export type CachedJudge<TArtifact, TScenario extends Scenario = Scenario> = JudgeConfig<
  TArtifact,
  TScenario
> & {
  stats(): VerdictCacheStats
}

/**
 * Wrap a `JudgeConfig` so repeat judgments of the same artifact are served
 * from the store instead of re-invoking `score()`. The wrapper is generic
 * over the judge's own type parameters and preserves `appliesTo` — it is a
 * drop-in replacement anywhere a `JudgeConfig` is accepted.
 *
 * A judge that throws is NOT cached: the error propagates and the next
 * attempt re-judges (caching a failure would pin a transient outage forever).
 */
export function cachedJudge<TArtifact, TScenario extends Scenario = Scenario>(
  judge: JudgeConfig<TArtifact, TScenario>,
  store: VerdictCacheStore,
  options: CachedJudgeOptions,
): CachedJudge<TArtifact, TScenario> {
  if (typeof options.judgeVersion !== 'string' || options.judgeVersion.trim() === '') {
    throw new Error('cachedJudge: judgeVersion is required and must be a non-empty string')
  }
  const stats: VerdictCacheStats = { hits: 0, misses: 0 }
  const wrapped: CachedJudge<TArtifact, TScenario> = {
    name: judge.name,
    dimensions: judge.dimensions,
    judgeVersion: options.judgeVersion,
    async score(input) {
      const key = contentHash({
        artifact: canonicalJson(input.artifact),
        scenarioId: input.scenario.id,
        judgeName: judge.name,
        dimensions: judge.dimensions,
        judgeVersion: options.judgeVersion,
      })
      const cached = await store.get(key)
      if (cached !== undefined) {
        stats.hits += 1
        return cached
      }
      const score = await judge.score(input)
      await store.set(key, score)
      stats.misses += 1
      return score
    },
    stats: () => ({ ...stats }),
  }
  if (judge.appliesTo) wrapped.appliesTo = judge.appliesTo
  return wrapped
}
