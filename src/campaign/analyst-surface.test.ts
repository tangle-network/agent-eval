import { describe, expect, it } from 'vitest'
import type { AnalyzeTracesResult } from '../trace-analyst/analyst'
import {
  type AnalystScenario,
  buildAnalystSurfaceDispatch,
  failureModeRecallJudge,
} from './analyst-surface'
import type { DispatchContext } from './types'

const ctx = {
  cellId: 'c0',
  rep: 0,
  seed: 42,
  signal: new AbortController().signal,
} as unknown as DispatchContext

const scenario: AnalystScenario = {
  id: 'appworld-task-77',
  kind: 'analyst-surface',
  source: '/tmp/does-not-matter.jsonl', // stubbed analyze never reads it
  question: 'Why did the agent fail this task?',
  expectedFailureModes: [
    {
      id: 'missing-prereq-fetch',
      cues: ['did not fetch', 'skipped the lookup', 'missing prerequisite'],
    },
    { id: 'wrong-tool', cues: ['wrong tool', 'called spotify instead of', 'incorrect api'] },
    {
      id: 'premature-complete',
      cues: ['completed early', 'premature', 'called complete_task too soon'],
    },
  ],
  forbiddenCues: ['network timeout', 'rate limit'], // did NOT occur in this corpus
}

const RESULT: AnalyzeTracesResult = {
  answer: 'a',
  findings: ['the agent did not fetch the playlist before editing it'],
  turns: [],
  turnCount: 1,
  usage: { actor: [], responder: [] },
  chatLog: { actor: [], responder: [] },
  actorPromptVersion: 'stub-v0',
}

describe('buildAnalystSurfaceDispatch — runs the analyst with the surface as actorDescription', () => {
  it('passes the optimized surface through as actorDescription and returns findings', async () => {
    let seenActor: string | undefined
    const dispatch = buildAnalystSurfaceDispatch({
      analystOptions: { ai: {} as never },
      analyze: async (_input, options) => {
        seenActor = options.actorDescription
        return RESULT
      },
    })
    const art = await dispatch('OPTIMIZED ANALYST PROMPT v2', scenario, ctx)
    expect(seenActor).toBe('OPTIMIZED ANALYST PROMPT v2')
    expect(art.findings).toHaveLength(1)
    expect(art.actorPromptVersion).toBe('stub-v0')
  })

  it('fails loud if handed a code-tier surface (analyst prompt is prompt-tier)', async () => {
    const dispatch = buildAnalystSurfaceDispatch({ analystOptions: { ai: {} as never } })
    await expect(dispatch({ kind: 'code', worktreeRef: 'wt/abc' }, scenario, ctx)).rejects.toThrow(
      /prompt-tier/,
    )
  })
})

describe('failureModeRecallJudge — deterministic ground-truth scoring', () => {
  const judge = failureModeRecallJudge()

  it('rewards an analyst that surfaces more of the real failure modes', async () => {
    const weak = await judge.score({
      artifact: {
        answer: '',
        findings: ['the agent did not fetch the prereq'],
        actorPromptVersion: 'v',
      },
      scenario,
      signal: ctx.signal,
    })
    const strong = await judge.score({
      artifact: {
        answer: '',
        findings: [
          'the agent did not fetch the playlist first (missing prerequisite)',
          'it called spotify instead of the venmo api — wrong tool',
          'it called complete_task too soon — premature',
        ],
        actorPromptVersion: 'v',
      },
      scenario,
      signal: ctx.signal,
    })
    // weak finds 1/3, strong finds 3/3 → strictly higher composite (the lift signal).
    expect(weak.dimensions.recall!).toBeCloseTo(1 / 3, 5)
    expect(strong.dimensions.recall!).toBe(1)
    expect(strong.composite).toBeGreaterThan(weak.composite)
    expect(strong.notes).toContain('matched 3/3')
    expect(weak.notes).toContain('missed [wrong-tool, premature-complete]')
  })

  it('penalizes precision when a finding names a failure that never happened (anti-hallucination)', async () => {
    const honest = await judge.score({
      artifact: { answer: '', findings: ['missing prerequisite fetch'], actorPromptVersion: 'v' },
      scenario,
      signal: ctx.signal,
    })
    const hallucinating = await judge.score({
      artifact: {
        answer: '',
        findings: ['missing prerequisite fetch', 'a network timeout caused the failure'],
        actorPromptVersion: 'v',
      },
      scenario,
      signal: ctx.signal,
    })
    // Same recall (1/3) but the hallucinated forbidden-cue finding drops precision → lower composite.
    expect(hallucinating.dimensions.recall!).toBeCloseTo(honest.dimensions.recall!, 5)
    expect(hallucinating.dimensions.precision!).toBeLessThan(honest.dimensions.precision!)
    expect(hallucinating.composite).toBeLessThan(honest.composite)
  })

  it('fails loud on a scenario with no ground-truth labels (never a vacuous 1.0)', () => {
    const bad = { ...scenario, expectedFailureModes: [] }
    expect(() =>
      judge.score({
        artifact: { answer: '', findings: ['x'], actorPromptVersion: 'v' },
        scenario: bad,
        signal: ctx.signal,
      }),
    ).toThrow(/no expectedFailureModes/)
  })

  it('only applies to analyst-surface scenarios', () => {
    expect(judge.appliesTo!(scenario)).toBe(true)
    expect(judge.appliesTo!({ id: 'x', kind: 'other' } as never)).toBe(false)
  })
})
