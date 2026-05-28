import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { analyzeRuns } from '../src/contract/analyze-runs'
import type { RunRecord } from '../src/run-record'

/**
 * Empirical proof — analyzeRuns over a REAL agent corpus, not synthetic
 * fixtures. The records are agent-builder's canonical eval run
 * (`eval/.runs/canonical-*`, n=32, candidate "canonical"): real
 * holdout scores, real failure modes, real token/cost. This is the
 * artifact that converts "the math runs" into "the math produces a
 * real decision packet on real agent output."
 *
 * If analyzeRuns ever silently changes how it summarises a real corpus
 * (composite distribution, failure rate, recommendation firing), this
 * test breaks with concrete numbers — not a synthetic toy.
 */
function loadRealCorpus(): RunRecord[] {
  const path = join(__dirname, 'fixtures', 'real-corpus', 'agent-builder-canonical-n32.jsonl')
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as RunRecord)
}

describe('empirical proof — analyzeRuns on a real agent corpus (agent-builder n=32)', () => {
  it('produces a real composite distribution from real holdout scores', async () => {
    const runs = loadRealCorpus()
    expect(runs).toHaveLength(32)

    const report = await analyzeRuns({ runs })

    // Real numbers, locked: mean composite ≈ 0.608 over 32 real runs,
    // bounded [0,1] (binary-ish readiness outcomes).
    expect(report.composite.n).toBe(32)
    expect(report.composite.mean).toBeGreaterThan(0.55)
    expect(report.composite.mean).toBeLessThan(0.66)
    expect(report.composite.min).toBe(0)
    expect(report.composite.max).toBe(1)
    // Distribution carries real spread, not a collapsed point estimate.
    expect(report.composite.stddev).toBeGreaterThan(0)
  })

  it('surfaces the worst real runs by name so a human can inspect them', async () => {
    const runs = loadRealCorpus()
    const report = await analyzeRuns({ runs })

    // The composite distribution names the worst-N real runIds — the
    // "go look at these" list a customer acts on.
    expect(report.composite.tailRuns.length).toBeGreaterThan(0)
    const worst = report.composite.tailRuns[0]!
    expect(worst.runId).toMatch(/^run-/)
    expect(worst.score).toBe(0)
    // The runId is a real one from the corpus, not fabricated.
    expect(runs.some((r) => r.runId === worst.runId)).toBe(true)
  })

  it('clusters real failure modes model-free (no analyst/LLM)', async () => {
    const runs = loadRealCorpus()
    const report = await analyzeRuns({ runs })

    // The structured `failureMode` tags are tallied without any LLM.
    // forge_build_unsatisfied dominates (9 runs) in this real corpus.
    expect(report.failureModes).toBeDefined()
    const top = report.failureModes![0]!
    expect(top.mode).toBe('forge_build_unsatisfied')
    expect(top.count).toBe(9)
    expect(top.share).toBeCloseTo(9 / 32, 5)
  })

  it('fires a dominant-failure-mode recommendation even though mean (0.61) looks fine', async () => {
    const runs = loadRealCorpus()
    const report = await analyzeRuns({ runs })

    // The regression this guards: a bimodal corpus (mean > 0.5 but a
    // named failure cluster) used to produce ZERO recommendations because
    // the composite branch only fires below 0.5 and clusters needed an LLM.
    expect(report.recommendations.length).toBeGreaterThan(0)
    const rec = report.recommendations.find((r) => r.evidencePath === 'failureModes')
    expect(rec).toBeDefined()
    expect(rec!.priority).toBe('high') // 28% share ≥ 0.25
    expect(rec!.title).toContain('forge_build_unsatisfied')
  })
})
