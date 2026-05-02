import {
  runMultiShotOptimization,
  trialTraceFromMultiShotTrial,
  type MultiShotVariant,
  type RunRecord,
} from '@tangle-network/agent-eval'

type Payload = {
  instruction: string
  quality: number
}

const baseline: MultiShotVariant<Payload> = {
  id: 'baseline',
  label: 'baseline',
  generation: 0,
  payload: {
    instruction: 'Complete the user task.',
    quality: 0.45,
  },
}

const result = await runMultiShotOptimization<Payload>({
  runId: 'demo-multi-shot',
  target: 'demo-agent-system-prompt',
  seedVariants: [baseline],
  searchScenarioIds: ['search-brief', 'search-code-review', 'search-research'],
  reps: 1,
  generations: 2,
  populationSize: 2,
  scoreConcurrency: 2,
  runner: {
    async run({ variant, scenarioId }) {
      return {
        trace: {
          scenarioId,
          turns: [
            { role: 'user', content: `Run ${scenarioId}` },
            { role: 'assistant', content: `${variant.payload.instruction} quality=${variant.payload.quality}` },
          ],
          output: `quality=${variant.payload.quality}`,
        },
        costUsd: 0.01,
        durationMs: 50,
      }
    },
  },
  scorer: {
    async score({ variant }) {
      return {
        score: variant.payload.quality,
        ok: true,
        asi: variant.payload.quality >= 0.8
          ? []
          : [{
              expectationId: 'complete-task',
              message: 'The agent did not fully complete the task.',
              severity: 'error',
              responsibleSurface: 'system-prompt',
              suggestion: 'Make completion criteria explicit before final response.',
            }],
      }
    },
  },
  mutateAdapter: {
    async mutate({ parent, bottomTrials, childCount, generation }) {
      const traces = bottomTrials.map((trial) => trialTraceFromMultiShotTrial(trial))
      const rationale = traces.flatMap((trace) => (trace.expectations ?? []).map((e) => e.phrase)).join('\n')
      return Array.from({ length: childCount }, (_, i) => ({
        id: `${parent.id}.g${generation}.${i}`,
        label: 'completion-focused',
        generation,
        payload: {
          instruction: `${parent.payload.instruction} Verify every requested step before final answer.`,
          quality: 0.9,
        },
        rationale,
      }))
    },
  },
  gate: {
    holdoutScenarioIds: ['holdout-brief', 'holdout-code-review', 'holdout-research'],
    gate: {
      baselineKey: 'baseline',
      minProductiveRuns: 3,
      pairedDeltaThreshold: 0,
      seed: 7,
    },
    toRunRecord: ({ variant, scenarioId, rep, split, seed, trial }): RunRecord => ({
      runId: `demo-${variant.id}-${scenarioId}-${rep}-${split}`,
      experimentId: scenarioId,
      candidateId: variant.id,
      seed,
      model: 'demo-model@2026-01-01',
      promptHash: 'p'.repeat(64),
      configHash: 'c'.repeat(64),
      commitSha: 'deadbeef',
      wallMs: trial.durationMs ?? 0,
      costUsd: trial.cost ?? 0,
      tokenUsage: { input: 1, output: 1 },
      outcome: {
        [split === 'holdout' ? 'holdoutScore' : 'searchScore']: trial.score,
        raw: { score: trial.score },
      },
      splitTag: split,
    }),
  },
})

console.log({
  searchBest: result.searchBestVariant.id,
  promoted: result.promotedVariant.id,
  gate: result.gate?.decision ?? null,
})
