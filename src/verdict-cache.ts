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
 * The cache key is `v2:` + a sha-256 over the canonical JSON of everything
 * that can change a verdict: the artifact content, the scenario id, the judge
 * name, the full dimension list (key + description — the description IS the
 * rubric text shown to the judge), and a caller-supplied `judgeVersion`.
 * `judgeVersion` is REQUIRED: a judge whose prompt/model/ensemble changes
 * without a version bump would otherwise silently serve stale verdicts.
 * The `v2:` prefix names the key scheme; a store written under another scheme
 * misses once and repopulates.
 *
 * Canonical JSON is RFC 8785 from `ledger-core/canonical` — the package's one
 * identity scheme. It refuses `undefined`, functions, symbols, non-finite
 * numbers, class instances (including `Date`), `Map`, `Set`, cycles, and
 * unpaired surrogates: an artifact that cannot be unambiguously serialized
 * cannot be content-addressed, and coercing it would let two different
 * artifacts collide on one key. Pass timestamps as ISO strings.
 */

import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import type { JudgeScore } from './campaign/types'
import { canonicalString, hashCanonical } from './ledger-core/canonical'

// ── canonical JSON + content hash ─────────────────────────────────────────



/**
 * Canonical JSON (RFC 8785): object keys sorted recursively, so two
 * semantically equal values produce byte-identical output regardless of key
 * insertion order. Throws `LedgerCanonicalizationError` on any value with no
 * faithful JSON form — see `ledger-core/canonical`.
 */
export function canonicalJson(value: unknown): string {
  return canonicalString(value)
}

/** Hex sha-256 over `canonicalJson(value)`. The content address used by the
 *  verdict cache and report attestation. Equals `hashCanonical(value)` with
 *  the `sha256:` prefix removed. */
export function contentHash(value: unknown): string {
  return hashCanonical(value).slice('sha256:'.length)
}

// ── store contract ─────────────────────────────────────────────────────────

/** Pluggable verdict store. Sync or async on both legs — `cachedJudge`
 *  awaits the results either way. */
export interface VerdictCacheStore {
  get(key: string): Promise<JudgeScore | undefined> | JudgeScore | undefined
  set(key: string, score: JudgeScore): Promise<void> | void
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








