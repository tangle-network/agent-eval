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
