/**
 * makeEvalTools packages judges / completion verification / run analysis as
 * agent-callable tools. These tests pin: tools appear only for supplied config
 * sections, handlers fail loud on malformed args, and toOpenAiTool emits the
 * function-tool wire shape.
 */

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { CompletionVerdict, InsightReport, JudgeConfig } from '../src/index'
import { makeEvalTools, toOpenAiTool } from '../src/index'
import type { RunRecord } from '../src/run-record'

const qualityJudge: JudgeConfig<unknown> = {
  name: 'quality',
  dimensions: [{ key: 'quality', description: 'overall quality' }],
  score: ({ artifact }) => ({
    dimensions: { quality: typeof artifact === 'string' ? 0.8 : 0.2 },
    composite: typeof artifact === 'string' ? 0.8 : 0.2,
    notes: 'deterministic',
  }),
}

const lengthJudge: JudgeConfig<unknown> = {
  name: 'length',
  dimensions: [{ key: 'length', description: 'is it long enough' }],
  score: () => ({ dimensions: { length: 1 }, composite: 1, notes: 'long enough' }),
}

function makeRun(id: string, composite: number): RunRecord {
  return {
    runId: id,
    experimentId: 'exp',
    candidateId: 'c',
    seed: 0,
    model: 'm@v',
    promptHash: 'sha256:p',
    configHash: 'sha256:c',
    commitSha: 'abc',
    wallMs: 100,
    costUsd: 0.01,
    tokenUsage: { input: 100, output: 50 },
    outcome: {
      holdoutScore: composite,
      raw: {},
      judgeScores: {
        perJudge: { default: { quality: composite } },
        perDimMean: { quality: composite },
        composite,
      },
    },
    splitTag: 'holdout' as const,
  }
}

describe('makeEvalTools — config-driven tool inclusion', () => {
  it('returns no tools for an empty config', () => {
    expect(makeEvalTools({})).toEqual([])
  })

  it('includes exactly the tools whose config section is supplied', () => {
    const judgeOnly = makeEvalTools({ judges: [qualityJudge] })
    expect(judgeOnly.map((t) => t.name)).toEqual(['run_judges'])

    const all = makeEvalTools({
      judges: [qualityJudge],
      completion: { checkCorrectness: async () => ({ correct: true, reason: 'ok' }) },
      analyze: {},
    })
    expect(all.map((t) => t.name)).toEqual(['run_judges', 'verify_completion', 'analyze_runs'])
  })

  it('throws on an empty judges array — supply judges or omit the section', () => {
    expect(() => makeEvalTools({ judges: [] })).toThrow(/judges is empty/)
  })
})

describe('run_judges handler', () => {
  const tool = makeEvalTools({ judges: [qualityJudge, lengthJudge] })[0]!

  it('runs every configured judge and keys scores by judge name', async () => {
    const out = (await tool.handler({ artifact: 'some text' })) as {
      scores: Record<string, { composite: number }>
    }
    expect(Object.keys(out.scores).sort()).toEqual(['length', 'quality'])
    expect(out.scores.quality!.composite).toBeCloseTo(0.8, 5)
  })

  it('runs only the named judge when args.judge is given', async () => {
    const out = (await tool.handler({ judge: 'length', artifact: 'x' })) as {
      scores: Record<string, unknown>
    }
    expect(Object.keys(out.scores)).toEqual(['length'])
  })

  it('throws on an unknown judge name', async () => {
    await expect(tool.handler({ judge: 'nope', artifact: 'x' })).rejects.toThrow(
      /unknown judge 'nope'/,
    )
  })

  it('throws when artifact is missing', async () => {
    await expect(tool.handler({})).rejects.toThrow(/artifact is required/)
  })

  it('respects appliesTo when a scenario is supplied', async () => {
    const scoped: JudgeConfig<unknown> = {
      ...lengthJudge,
      name: 'legal-only',
      appliesTo: (s) => s.kind === 'legal',
    }
    const t = makeEvalTools({ judges: [qualityJudge, scoped] })[0]!
    const out = (await t.handler({
      artifact: 'x',
      scenario: { id: 's', kind: 'tax' },
    })) as { scores: Record<string, unknown> }
    expect(Object.keys(out.scores)).toEqual(['quality'])
  })
})

describe('verify_completion handler', () => {
  const tool = makeEvalTools({
    completion: { checkCorrectness: async () => ({ correct: true, reason: 'ok' }) },
  })[0]!

  it('verifies produced state against the gold spec', async () => {
    const verdict = (await tool.handler({
      gold: { taskId: 't1', requirements: [{ reqId: 'r1', title: 'Dispute Notice' }] },
      state: { artifacts: [], proposals: [], toolCalls: [] },
    })) as CompletionVerdict
    expect(verdict.taskId).toBe('t1')
    expect(verdict.requirements).toHaveLength(1)
    expect(verdict.completionRate).toBe(0)
    expect(verdict.fullyComplete).toBe(false)
    // Spine fields derived by completionVerdict().
    expect(verdict.valid).toBe(false)
    expect(verdict.score).toBe(0)
  })

  it('throws when gold or state is missing', async () => {
    await expect(tool.handler({ state: {} })).rejects.toThrow(/gold.*required/)
    await expect(tool.handler({ gold: {} })).rejects.toThrow(/state.*required/)
  })
})

describe('analyze_runs handler', () => {
  const tool = makeEvalTools({ analyze: {} })[0]!

  it('analyzes inline runs', async () => {
    const report = (await tool.handler({
      runs: [makeRun('r-1', 0.8), makeRun('r-2', 0.6)],
    })) as InsightReport
    expect(report.n).toBe(2)
    expect(report.composite.mean).toBeCloseTo(0.7, 5)
  })

  it('loads runs from a JSONL file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'eval-tools-'))
    const path = join(dir, 'runs.jsonl')
    writeFileSync(
      path,
      [makeRun('r-1', 0.9), makeRun('r-2', 0.5)].map((r) => JSON.stringify(r)).join('\n'),
    )
    const report = (await tool.handler({ path })) as InsightReport
    expect(report.n).toBe(2)
  })

  it('loads runs from a JSON-array file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'eval-tools-'))
    const path = join(dir, 'runs.json')
    writeFileSync(path, JSON.stringify([makeRun('r-1', 0.9)]))
    const report = (await tool.handler({ path })) as InsightReport
    expect(report.n).toBe(1)
  })

  it('requires exactly one of runs or path', async () => {
    await expect(tool.handler({})).rejects.toThrow(/exactly one of/)
    await expect(tool.handler({ runs: [], path: '/tmp/x' })).rejects.toThrow(/exactly one of/)
  })

  it('throws on an empty run set', async () => {
    await expect(tool.handler({ runs: [] })).rejects.toThrow(/exactly one of|no runs/)
  })
})

describe('toOpenAiTool', () => {
  it('emits the OpenAI function-tool wire shape', () => {
    const [tool] = makeEvalTools({ judges: [qualityJudge] })
    const wire = toOpenAiTool(tool!)
    expect(wire.type).toBe('function')
    expect(wire.function.name).toBe('run_judges')
    expect(wire.function.description).toContain('quality')
    expect(wire.function.parameters).toMatchObject({ type: 'object', required: ['artifact'] })
  })
})
