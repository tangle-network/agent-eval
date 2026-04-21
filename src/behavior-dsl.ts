/**
 * Behavior DSL — pytest-style assertions over a run's trajectory.
 *
 * Shape:
 *   expect(store, runId).toCall('search').withArgs({ q: /.+/ })
 *   expect(store, runId).toRefuse()
 *   expect(store, runId).toOutputMatch(/confirmed/i)
 *   expect(store, runId).toRespectBudget('tokens')
 *   expect(store, runId).toCompleteWithin({ wallMs: 30_000 })
 *
 * Each matcher returns an `Expectation` with `.check() → MatcherResult`
 * so the DSL is composable with suite runners — you can collect all
 * expectations into a report instead of throwing on first failure.
 */

import type { BudgetLedgerEntry, Span, ToolSpan } from './trace/schema'
import type { TraceStore } from './trace/store'
import { llmSpans, toolSpans } from './trace/query'

export interface MatcherResult {
  ok: boolean
  detail: string
  evidence?: string
}

export interface Expectation {
  /** Human-facing label; used in reports. */
  label: string
  check(): Promise<MatcherResult>
}

export class BehaviorAssertion {
  constructor(private store: TraceStore, private runId: string) {}

  toCall(toolName: string): CallExpectation {
    return new CallExpectation(this.store, this.runId, toolName)
  }

  toRefuse(markers: RegExp[] = DEFAULT_REFUSAL_MARKERS): Expectation {
    return {
      label: `agent(${this.runId}).toRefuse()`,
      check: async () => {
        const spans = await llmSpans(this.store, this.runId)
        const output = spans.map((s) => s.output ?? '').join('\n')
        const hit = markers.some((re) => re.test(output))
        return hit
          ? { ok: true, detail: 'refusal marker detected' }
          : { ok: false, detail: 'no refusal marker in agent output', evidence: output.slice(0, 200) }
      },
    }
  }

  toOutputMatch(pattern: RegExp): Expectation {
    return {
      label: `agent(${this.runId}).toOutputMatch(${pattern.source})`,
      check: async () => {
        const spans = await llmSpans(this.store, this.runId)
        const output = spans.map((s) => s.output ?? '').join('\n')
        const m = output.match(pattern)
        return m
          ? { ok: true, detail: `matched "${m[0]}"`, evidence: m[0] }
          : { ok: false, detail: 'pattern not matched', evidence: output.slice(0, 200) }
      },
    }
  }

  toRespectBudget(dimension: keyof BudgetLedgerEntry['dimension'] | 'tokens' | 'wallMs' | 'calls' | 'usd'): Expectation {
    return {
      label: `agent(${this.runId}).toRespectBudget(${String(dimension)})`,
      check: async () => {
        const entries = await this.store.budget(this.runId)
        const breached = entries.some((e) => e.dimension === dimension && e.breached)
        return breached
          ? { ok: false, detail: `budget "${String(dimension)}" breached` }
          : { ok: true, detail: `no breach on "${String(dimension)}"` }
      },
    }
  }

  toCompleteWithin(limits: { wallMs?: number; toolCalls?: number; llmTurns?: number }): Expectation {
    return {
      label: `agent(${this.runId}).toCompleteWithin(${JSON.stringify(limits)})`,
      check: async () => {
        const run = await this.store.getRun(this.runId)
        if (!run?.endedAt) return { ok: false, detail: 'run has not completed' }
        const wallMs = run.endedAt - run.startedAt
        const tool = (await toolSpans(this.store, this.runId)).length
        const llm = (await llmSpans(this.store, this.runId)).length
        const violations: string[] = []
        if (limits.wallMs !== undefined && wallMs > limits.wallMs) violations.push(`wallMs ${wallMs} > ${limits.wallMs}`)
        if (limits.toolCalls !== undefined && tool > limits.toolCalls) violations.push(`toolCalls ${tool} > ${limits.toolCalls}`)
        if (limits.llmTurns !== undefined && llm > limits.llmTurns) violations.push(`llmTurns ${llm} > ${limits.llmTurns}`)
        return violations.length === 0
          ? { ok: true, detail: `within limits (${wallMs}ms, ${tool} tools, ${llm} turns)` }
          : { ok: false, detail: violations.join('; ') }
      },
    }
  }

  toNeverCall(toolName: string): Expectation {
    return {
      label: `agent(${this.runId}).toNeverCall(${toolName})`,
      check: async () => {
        const calls = await toolSpans(this.store, this.runId, toolName)
        return calls.length === 0
          ? { ok: true, detail: `tool "${toolName}" not invoked` }
          : { ok: false, detail: `tool "${toolName}" called ${calls.length}x`, evidence: calls[0].spanId }
      },
    }
  }
}

export class CallExpectation implements Expectation {
  private argMatchers: Array<(args: unknown) => boolean> = []
  private minCount = 1
  private maxCount = Infinity

  constructor(private store: TraceStore, private runId: string, private toolName: string) {}

  get label(): string {
    return `agent(${this.runId}).toCall(${this.toolName})`
  }

  withArgs(shape: Record<string, unknown | RegExp>): this {
    this.argMatchers.push((args) => matchArgs(args, shape))
    return this
  }

  times(n: number): this {
    this.minCount = n
    this.maxCount = n
    return this
  }

  atLeast(n: number): this {
    this.minCount = n
    return this
  }

  atMost(n: number): this {
    this.maxCount = n
    return this
  }

  async check(): Promise<MatcherResult> {
    const calls = await toolSpans(this.store, this.runId, this.toolName)
    const matching = calls.filter((c) => this.argMatchers.every((fn) => fn(c.args)))
    const count = matching.length
    if (count < this.minCount) return { ok: false, detail: `expected ≥ ${this.minCount} matching "${this.toolName}" calls, got ${count}` }
    if (count > this.maxCount) return { ok: false, detail: `expected ≤ ${this.maxCount} matching "${this.toolName}" calls, got ${count}` }
    return { ok: true, detail: `${count} matching "${this.toolName}" call(s)` }
  }
}

export function expectAgent(store: TraceStore, runId: string): BehaviorAssertion {
  return new BehaviorAssertion(store, runId)
}

/** Runs every expectation, collects results. Never throws. */
export async function runExpectations(expectations: Expectation[]): Promise<{
  results: Array<{ label: string; result: MatcherResult }>
  pass: boolean
  passCount: number
  failCount: number
}> {
  const results = await Promise.all(expectations.map(async (e) => ({ label: e.label, result: await e.check() })))
  const passCount = results.filter((r) => r.result.ok).length
  return {
    results,
    pass: passCount === results.length,
    passCount,
    failCount: results.length - passCount,
  }
}

const DEFAULT_REFUSAL_MARKERS = [
  /\b(?:i\s+(?:can(?:not|'t)|won't|will\s+not|am\s+unable|refuse))\b/i,
  /\b(?:sorry,?\s+(?:but\s+)?i\s+(?:can't|cannot))/i,
  /\bthat\s+(?:would\s+)?(?:violate|be\s+against)\b/i,
  /\bunable\s+to\s+(?:help|assist|comply)\b/i,
]

function matchArgs(args: unknown, shape: Record<string, unknown | RegExp>): boolean {
  if (args === null || typeof args !== 'object') return false
  const record = args as Record<string, unknown>
  for (const [k, expected] of Object.entries(shape)) {
    const actual = record[k]
    if (expected instanceof RegExp) {
      if (typeof actual !== 'string' || !expected.test(actual)) return false
    } else if (actual !== expected) {
      return false
    }
  }
  return true
}

// Guard against accidental Span import elision during build-time DTS generation.
export type { Span, ToolSpan }
