/**
 * Declarative oracles — ground-truth assertions without an LLM.
 *
 * Lifted from browser-agent-driver's _oracle.mjs. When you know the
 * expected outcome exactly (a URL, a text fragment, a JSON shape), you
 * don't need an LLM judge — you need a regex. These oracles are
 * composable pass/fail checks over an observation bundle.
 *
 * Each oracle returns { pass, detail, evidence? } and has a short `id` for
 * reporting. `evaluateOracles` runs a batch and lands the aggregate in the
 * shared verdict spine (`DefaultVerdict`, docs/verdicts.md) with a
 * `'test'`-strategy certification: an oracle set IS a small answer key,
 * and certifies nothing outside its own coverage.
 */

import { packageVersion } from './package-version'
import { certificationEvidenceDigest, type DefaultVerdict } from './verdict'

export interface OracleObservation {
  /** Final observable text output from the agent (response, page snapshot, stdout). */
  text?: string
  /** Final URL — for browser-style scenarios. */
  url?: string
  /** Any structured JSON the agent produced. */
  json?: unknown
  /** Free-form context used by custom oracles. */
  context?: Record<string, unknown>
}

export interface OracleResult {
  id: string
  pass: boolean
  detail: string
  evidence?: string
}

export interface Oracle {
  id: string
  check(obs: OracleObservation): OracleResult
}





export function jsonShape(expected: Record<string, unknown>): Oracle {
  const id = `json-shape(${Object.keys(expected).join(',')})`
  return {
    id,
    check(obs) {
      const json = obs.json
      if (!isObject(json)) {
        return { id, pass: false, detail: 'observation.json missing or not an object' }
      }
      for (const [k, v] of Object.entries(expected)) {
        if (!(k in json)) return { id, pass: false, detail: `key "${k}" missing` }
        const actual = (json as Record<string, unknown>)[k]
        if (typeof v === 'string' && v.startsWith('re:')) {
          const re = new RegExp(v.slice(3))
          if (typeof actual !== 'string' || !re.test(actual)) {
            return { id, pass: false, detail: `key "${k}" failed regex ${v}` }
          }
        } else if (actual !== v) {
          return {
            id,
            pass: false,
            detail: `key "${k}" = ${JSON.stringify(actual)}, expected ${JSON.stringify(v)}`,
          }
        }
      }
      return { id, pass: true, detail: 'all keys match' }
    },
  }
}





/** Extends the substrate verdict spine: `valid` = every oracle passed (and
 *  at least one ran); `score` = ratio of oracles passed; `scores` = per-
 *  oracle 0|1 keyed by oracle id. */
export interface OracleReport extends DefaultVerdict {
  results: OracleResult[]
  passCount: number
  failCount: number
}

/** Run all oracles against one observation and aggregate. */
export function evaluateOracles(obs: OracleObservation, oracles: Oracle[]): OracleReport {
  const results = oracles.map((o) => o.check(obs))
  const passCount = results.filter((r) => r.pass).length
  const failCount = results.length - passCount
  const scores: Record<string, number> = {}
  for (const r of results) scores[r.id] = r.pass ? 1 : 0
  return {
    results,
    passCount,
    failCount,
    valid: failCount === 0 && results.length > 0,
    score: results.length ? passCount / results.length : 0,
    scores,
    notes: `${passCount}/${results.length} oracles passed`,
    certification: {
      strategy: 'test',
      checker: { name: 'agent-eval:declarative-oracles', version: packageVersion() },
      assumptions: [],
      evidenceDigest: certificationEvidenceDigest(results),
    },
  }
}



function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
