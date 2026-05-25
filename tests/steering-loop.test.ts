import { describe, expect, it } from 'vitest'
import { distillPlaybook, renderPlaybookMarkdown } from '../src/playbook'
import { RunCritic } from '../src/run-critic'
import { aggregateRunScore } from '../src/run-score'
import { mergeSteeringBundle, renderSteeringText } from '../src/steering'
import type { Run } from '../src/trace/schema'
import { InMemoryTraceStore } from '../src/trace/store'

describe('steering helpers', () => {
  it('merges steering bundle overrides without dropping existing reviewer prompts', () => {
    const merged = mergeSteeringBundle(
      {
        id: 'base',
        coderPrompt: 'stay grounded',
        reviewerPrompts: { safety: 'strict', quality: 'detailed' },
      },
      {
        continuePrompt: 'continue only if progress is real',
        reviewerPrompts: { quality: 'ruthless' },
      },
    )
    expect(merged.reviewerPrompts).toEqual({ safety: 'strict', quality: 'ruthless' })
    expect(merged.continuePrompt).toContain('progress')
  })

  it('renders steering text deterministically', () => {
    const text = renderSteeringText({
      id: 'x',
      coderPrompt: 'repo first',
      reviewerPrompts: { b: 'beta', a: 'alpha' },
      skills: ['verify', 'critical-audit'],
    })
    expect(text).toContain('bundle:x')
    expect(text.indexOf('reviewer:a:alpha')).toBeLessThan(text.indexOf('reviewer:b:beta'))
    expect(text).toContain('skills:critical-audit,verify')
  })
})

describe('RunCritic', () => {
  it('scores grounded runs above drift-heavy runs', async () => {
    const store = new InMemoryTraceStore()
    const run: Run = {
      runId: 'run-1',
      scenarioId: 'scenario-1',
      startedAt: 0,
      endedAt: 10_000,
      status: 'completed',
      outcome: { pass: true, score: 0.8 },
    }
    await store.appendRun(run)
    await store.appendSpan({
      spanId: 'llm-1',
      runId: run.runId,
      kind: 'llm',
      name: 'coder',
      startedAt: 1,
      model: 'kimi',
      messages: [],
      output: 'Read src/index.ts and package.json, then ran pnpm test.',
      inputTokens: 10,
      outputTokens: 20,
    })
    await store.appendSpan({
      spanId: 'tool-1',
      runId: run.runId,
      kind: 'tool',
      name: 'shell',
      toolName: 'EditFile',
      args: { path: 'src/index.ts' },
      startedAt: 2,
      status: 'ok',
    })
    await store.appendSpan({
      spanId: 'sandbox-1',
      runId: run.runId,
      kind: 'sandbox',
      name: 'tests',
      startedAt: 3,
      testsTotal: 10,
      testsPassed: 10,
    })
    await store.appendArtifact({
      artifactId: 'artifact-1',
      runId: run.runId,
      contentType: 'text/plain',
      sizeBytes: 20,
      hash: 'abc',
      inlineContent: 'patched file',
    })

    const critic = new RunCritic()
    const score = await critic.score(store, run.runId)
    expect(score.repoGroundedness).toBeGreaterThan(0.7)
    expect(score.driftPenalty).toBeLessThan(0.3)
    expect(score.testReality).toBe(1)
    expect(aggregateRunScore(score)).toBeGreaterThan(5)
  })

  it('penalizes drift-heavy runs', () => {
    const critic = new RunCritic()
    const score = critic.scoreTrace({
      run: {
        runId: 'run-2',
        scenarioId: 'scenario-2',
        startedAt: 0,
        endedAt: 60_000,
        status: 'failed',
      },
      spans: [
        {
          spanId: 'llm-2',
          runId: 'run-2',
          kind: 'llm',
          name: 'coder',
          startedAt: 1,
          model: 'kimi',
          messages: [],
          output: 'Title: article\nURL: https://example.com\nSummary: news dump',
        },
      ],
      events: [],
      artifacts: [],
      budget: [],
    })
    expect(score.repoGroundedness).toBe(0)
    expect(score.driftPenalty).toBe(1)
    expect(score.notes?.some((note) => note.includes('drift'))).toBe(true)
  })
})

describe('playbook', () => {
  it('deduplicates instructions and keeps the strongest entries', () => {
    const playbook = distillPlaybook([
      { instruction: 'Stay repo-first', rationale: 'good', weight: 1 },
      { instruction: 'stay   repo-first', rationale: 'better', weight: 3 },
      { instruction: 'Summarize turns cleanly', rationale: 'useful', weight: 2 },
    ])
    expect(playbook.entries).toHaveLength(2)
    expect(playbook.entries[0]?.rationale).toBe('better')
    expect(renderPlaybookMarkdown(playbook)).toContain('Stay repo-first')
  })
})
