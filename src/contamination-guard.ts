/**
 * ContaminationGuard — ensures held-out scenarios don't leak into
 * training/prompt paths, and flags model memorization.
 *
 * Three probes:
 *   1. `checkCanaries(output, scenario)` — if the scenario carries a
 *      canary token, it MUST NOT appear in the agent's output.
 *      Canaries are strings that are statistically impossible to
 *      reconstruct from the scenario description alone — so if they
 *      echo back, the model memorized them.
 *   2. `canaryLeakView(store)` — cross-corpus view of every run whose
 *      output contained a canary, with the offending scenario + run.
 *   3. `HoldoutAuditor` — wraps a Dataset and emits a structured error
 *      on any code path that reads holdout scenarios but doesn't flag
 *      `purpose: 'evaluation'`. Keeps engineers honest.
 */

import type { DatasetScenario } from './dataset'
import type { TraceStore } from './trace/store'
import { llmSpans } from './trace/query'

export interface CanaryLeak {
  scenarioId: string
  canary: string
  runId?: string
  evidence: string
}

export function checkCanaries(output: string, scenarios: DatasetScenario[]): CanaryLeak[] {
  const leaks: CanaryLeak[] = []
  for (const s of scenarios) {
    if (!s.canary) continue
    if (output.includes(s.canary)) {
      leaks.push({ scenarioId: s.id, canary: s.canary, evidence: excerpt(output, s.canary) })
    }
  }
  return leaks
}

/**
 * Behavioral canary: tests the AGENT, not the eval grep.
 *
 *   - `forbiddenPattern` PRESENT in output ⇒ AGENT EMITTED BAD CONTENT ⇒ LEAK.
 *   - `forbiddenPattern` ABSENT from output ⇒ AGENT HELD THE LINE       ⇒ PASS.
 *
 * Use when running known-bad-prompt scenarios against the agent under
 * test and you want to know if the agent misbehaved. The classical
 * {@link checkCanaries} / {@link import('./canary').runCanaries | runCanaries}
 * test whether the eval check fires when the bad output is forced
 * into the eval flow — different question, different answer.
 *
 * Pattern resolution order (first match wins):
 *   1. `scenario.forbiddenPattern` — if it parses as `/body/flags`,
 *      treated as a regex; otherwise a literal substring.
 *   2. `scenario.canary` — literal substring fallback so the helper
 *      works on existing scenario fixtures.
 *
 * Returns `null` when nothing forbidden was found OR the scenario
 * declared no pattern.
 */
export function checkBehavioralCanary(
  output: string,
  scenario: DatasetScenario,
): CanaryLeak | null {
  const pattern = scenario.forbiddenPattern ?? scenario.canary
  if (!pattern) return null
  const hit = matchForbidden(output, pattern)
  if (!hit) return null
  return {
    scenarioId: scenario.id,
    canary: pattern,
    evidence: excerpt(output, hit),
  }
}

/**
 * Behavioral canary over many (scenario, output) pairs. Sibling to
 * {@link import('./canary').runCanaries | runCanaries} — same idea
 * (run-many → report) but the question being answered is "did the
 * AGENT misbehave?" rather than "did the EVAL grep fire?".
 *
 * Returns one `CanaryLeak` per pair where the agent's output
 * contained its scenario's `forbiddenPattern` (or `canary` fallback).
 */
export function runBehavioralCanaries(
  cases: Array<{ scenario: DatasetScenario; output: string; runId?: string }>,
): CanaryLeak[] {
  const leaks: CanaryLeak[] = []
  for (const c of cases) {
    const leak = checkBehavioralCanary(c.output, c.scenario)
    if (leak) leaks.push({ ...leak, runId: c.runId ?? leak.runId })
  }
  return leaks
}

/**
 * Resolve a forbidden-pattern string to the matched substring inside
 * `output`. `/body/flags` notation is interpreted as a regex; anything
 * else is a literal substring.
 */
function matchForbidden(output: string, pattern: string): string | null {
  const re = tryParseRegex(pattern)
  if (re) {
    const m = output.match(re)
    return m && m[0].length > 0 ? m[0] : null
  }
  return output.includes(pattern) ? pattern : null
}

function tryParseRegex(pattern: string): RegExp | null {
  if (pattern.length < 2 || pattern[0] !== '/') return null
  const last = pattern.lastIndexOf('/')
  if (last <= 0) return null
  const body = pattern.slice(1, last)
  const flags = pattern.slice(last + 1)
  if (!/^[gimsuy]*$/.test(flags)) return null
  try {
    return new RegExp(body, flags)
  } catch {
    return null
  }
}

/**
 * Scan the LLM-output history in a corpus; returns every case where a
 * canary from a known scenario appeared in agent output. Pass the full
 * set of scenarios whose canaries you care about (typically the whole
 * held-out slice).
 */
export async function canaryLeakView(
  store: TraceStore,
  scenarios: DatasetScenario[],
): Promise<CanaryLeak[]> {
  const targets = scenarios.filter((s) => !!s.canary)
  if (targets.length === 0) return []
  const spans = await llmSpans(store)
  const leaks: CanaryLeak[] = []
  for (const span of spans) {
    const output = span.output ?? ''
    for (const s of targets) {
      if (s.canary && output.includes(s.canary)) {
        leaks.push({ scenarioId: s.id, canary: s.canary, runId: span.runId, evidence: excerpt(output, s.canary) })
      }
    }
  }
  return leaks
}

export class HoldoutAuditor {
  private scenarios: DatasetScenario[]
  private accessLog: Array<{ scenarioId: string; purpose: string; at: number }> = []

  constructor(scenarios: DatasetScenario[]) {
    this.scenarios = scenarios
  }

  /** Retrieve a holdout scenario for a declared purpose. Non-'evaluation' throws. */
  get(scenarioId: string, purpose: 'evaluation' | 'debugging'): DatasetScenario {
    if (purpose !== 'evaluation' && purpose !== 'debugging') {
      throw new Error(`HoldoutAuditor.get: purpose must be 'evaluation' or 'debugging', got ${purpose}`)
    }
    const s = this.scenarios.find((x) => x.id === scenarioId)
    if (!s) throw new Error(`holdout scenario "${scenarioId}" not found`)
    this.accessLog.push({ scenarioId, purpose, at: Date.now() })
    return s
  }

  getAccessLog(): ReadonlyArray<{ scenarioId: string; purpose: string; at: number }> {
    return this.accessLog
  }
}

function excerpt(source: string, needle: string): string {
  const at = source.indexOf(needle)
  if (at < 0) return ''
  const start = Math.max(0, at - 30)
  const end = Math.min(source.length, at + needle.length + 30)
  return (start > 0 ? '…' : '') + source.slice(start, end) + (end < source.length ? '…' : '')
}
