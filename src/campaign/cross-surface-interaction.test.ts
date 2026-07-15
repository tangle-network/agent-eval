import { describe, expect, it } from 'vitest'
import { analyzeCrossSurfaceInteractions } from './cross-surface-interaction'
import type {
  AnalyzeCrossSurfaceInteractionsInput,
  CrossSurfaceCandidate,
  CrossSurfaceComponent,
  CrossSurfaceTaskRow,
} from './cross-surface-types'

interface TestRow extends CrossSurfaceTaskRow {
  receipt: string
}

const TASKS = ['t1', 't2', 't3', 't4', 't5'] as const

function fixture(): AnalyzeCrossSurfaceInteractionsInput<TestRow> {
  const components: CrossSurfaceComponent[] = [
    { componentId: 'profile-change', surfaceId: 'profile', bestSingleEligible: true },
    { componentId: 'code-change', surfaceId: 'code', bestSingleEligible: true },
  ]
  const candidates: CrossSurfaceCandidate[] = [
    { candidateId: 'fixed', componentIds: [], contentHash: '0000', artifactBytes: 0 },
    {
      candidateId: 'profile-only',
      componentIds: ['profile-change'],
      contentHash: '1111',
      artifactBytes: 100,
    },
    {
      candidateId: 'code-only',
      componentIds: ['code-change'],
      contentHash: '2222',
      artifactBytes: 120,
    },
    {
      candidateId: 'profile-code',
      componentIds: ['profile-change', 'code-change'],
      contentHash: '3333',
      artifactBytes: 220,
    },
  ]
  const passes: Record<string, boolean[]> = {
    fixed: [false, false, false, true, false],
    'profile-only': [true, false, false, true, false],
    'code-only': [false, true, false, true, false],
    'profile-code': [true, true, true, true, false],
  }
  const costs: Record<string, { usd: number; outputTokens: number }> = {
    fixed: { usd: 1, outputTokens: 100 },
    'profile-only': { usd: 1.05, outputTokens: 105 },
    'code-only': { usd: 1.1, outputTokens: 110 },
    'profile-code': { usd: 1.2, outputTokens: 120 },
  }
  const rows: TestRow[] = candidates.flatMap((candidate) =>
    TASKS.map((taskId, taskIndex) => ({
      taskId,
      candidateId: candidate.candidateId,
      componentIds: [...candidate.componentIds],
      completeness: 'complete' as const,
      pass: passes[candidate.candidateId]![taskIndex]!,
      score: Number(passes[candidate.candidateId]![taskIndex]!),
      cost: { ...costs[candidate.candidateId]! },
      componentEvidence: candidate.componentIds.map((componentId) => ({
        componentId,
        fired: true,
        effectObserved: true,
      })),
      rejectReason: null,
      receipt: `${candidate.candidateId}/${taskId}`,
    })),
  )
  return {
    components,
    candidates,
    rows,
    baselineCandidateId: 'fixed',
    taskOrder: [...TASKS],
    componentOrder: ['profile-change', 'code-change'],
    candidateOrder: ['fixed', 'profile-only', 'code-only', 'profile-code'],
    costMetricOrder: ['usd', 'outputTokens'],
    bootstrap: { seed: 360, resamples: 200, confidence: 0.95 },
    selection: {
      minimumFiringTasks: 1,
      minimumEffectTasks: 1,
      requireObservedFiring: true,
      requireObservedEffect: true,
      maximumMedianCostRatioToBaseline: { usd: 1.5, outputTokens: 1.5 },
      minimumBundleComponents: 2,
    },
  }
}

function threeSurfaceFixture(): AnalyzeCrossSurfaceInteractionsInput<TestRow> {
  const components: CrossSurfaceComponent[] = [
    { componentId: 'a', surfaceId: 'profile', bestSingleEligible: true },
    { componentId: 'b', surfaceId: 'code', bestSingleEligible: true },
    { componentId: 'c', surfaceId: 'memory', bestSingleEligible: true },
  ]
  const candidates: CrossSurfaceCandidate[] = [
    { candidateId: 'fixed', componentIds: [], contentHash: '0', artifactBytes: 0 },
    { candidateId: 'a', componentIds: ['a'], contentHash: '1', artifactBytes: 10 },
    { candidateId: 'b', componentIds: ['b'], contentHash: '2', artifactBytes: 10 },
    { candidateId: 'c', componentIds: ['c'], contentHash: '3', artifactBytes: 10 },
    { candidateId: 'ab', componentIds: ['a', 'b'], contentHash: '4', artifactBytes: 20 },
    { candidateId: 'ac', componentIds: ['a', 'c'], contentHash: '5', artifactBytes: 20 },
    { candidateId: 'bc', componentIds: ['b', 'c'], contentHash: '6', artifactBytes: 20 },
    { candidateId: 'abc', componentIds: ['a', 'b', 'c'], contentHash: '7', artifactBytes: 30 },
  ]
  const tasks = ['u1', 'u2', 'u3', 'u4', 'u5', 'u6']
  const passes: Record<string, boolean[]> = {
    fixed: [false, false, false, false, false, false],
    a: [true, false, false, false, false, false],
    b: [false, true, false, false, false, false],
    c: [false, false, true, false, false, false],
    ab: [true, true, false, true, false, false],
    ac: [true, false, true, false, false, false],
    bc: [false, true, true, false, true, false],
    abc: [true, true, true, true, true, true],
  }
  const costs: Record<string, number> = {
    fixed: 1,
    a: 1.02,
    b: 1.03,
    c: 1.04,
    ab: 1.12,
    ac: 1.13,
    bc: 1.14,
    abc: 1.25,
  }
  const rows: TestRow[] = candidates.flatMap((candidate) =>
    tasks.map((taskId, index) => ({
      taskId,
      candidateId: candidate.candidateId,
      componentIds: [...candidate.componentIds],
      completeness: 'complete' as const,
      pass: passes[candidate.candidateId]![index]!,
      score: Number(passes[candidate.candidateId]![index]!),
      cost: { usd: costs[candidate.candidateId]! },
      componentEvidence: candidate.componentIds.map((componentId) => ({
        componentId,
        fired: true,
        effectObserved: true,
      })),
      rejectReason: null,
      receipt: `${candidate.candidateId}/${taskId}`,
    })),
  )
  return {
    components,
    candidates,
    rows,
    baselineCandidateId: 'fixed',
    taskOrder: tasks,
    componentOrder: ['a', 'b', 'c'],
    candidateOrder: ['fixed', 'a', 'b', 'c', 'ab', 'ac', 'bc', 'abc'],
    costMetricOrder: ['usd'],
    bootstrap: { seed: 360, resamples: 200, confidence: 0.95 },
    selection: {
      minimumFiringTasks: 1,
      minimumEffectTasks: 1,
      requireObservedFiring: true,
      requireObservedEffect: true,
      maximumMedianCostRatioToBaseline: { usd: 1.5 },
      minimumBundleComponents: 2,
    },
  }
}

function row(
  input: AnalyzeCrossSurfaceInteractionsInput<TestRow>,
  candidateId: string,
  taskId: string,
): TestRow {
  return input.rows.find(
    (candidateRow) => candidateRow.candidateId === candidateId && candidateRow.taskId === taskId,
  )!
}

describe('analyzeCrossSurfaceInteractions', () => {
  it('reports task-level synergy and selects the compatible composition', () => {
    const report = analyzeCrossSurfaceInteractions(fixture())
    const pair = report.pairwise[0]!
    const composed = report.candidates.find(
      (candidate) => candidate.candidate.candidateId === 'profile-code',
    )!

    expect(report.rows).toHaveLength(4 * TASKS.length)
    expect(pair.synergyTaskIds).toEqual(['t3'])
    expect(pair.interferenceTaskIds).toEqual([])
    expect(pair.benefitTaskIds).toEqual(['t1', 't2', 't3'])
    expect(pair.regressionTaskIds).toEqual([])
    expect(pair.incrementalVsConstituents[0].winsTaskIds).toEqual(['t2', 't3'])
    expect(pair.incrementalVsConstituents[1].winsTaskIds).toEqual(['t1', 't3'])
    expect(pair.interaction.meanPassInteraction).toBeCloseTo(0.2)
    expect(pair.interaction.passBootstrap?.mean).toBeCloseTo(0.2)
    expect(pair.firing.bothTaskIds).toEqual([...TASKS])
    expect(pair.relativeCostToBaseline.usd?.medianRatio).toBeCloseTo(1.2)
    expect(pair.compatibility).toEqual({
      compatible: true,
      reasons: [],
      betterSingleCandidateId: 'profile-only',
    })
    expect(composed.comparisonToBaseline?.correctness?.riskDifference.riskDifference).toBeCloseTo(
      3 / 5,
    )
    expect(report.selections.bestSingle?.candidateId).toBe('profile-only')
    expect(report.selections.naiveStack?.candidateId).toBe('profile-code')
    expect(report.selections.interactionAware).toMatchObject({
      seedCandidateId: 'profile-code',
      terminalCandidateId: 'profile-code',
      selectedCandidateId: 'profile-code',
      terminalComponentIds: ['profile-change', 'code-change'],
      qualified: true,
      steps: [],
    })
    expect(report.selections.interactionAware?.evaluatedPaths).toHaveLength(1)
  })

  it('selects pure synergy without weakening the strict naive stack', () => {
    const input = fixture()
    for (const taskId of TASKS) {
      const baseline = row(input, 'fixed', taskId)
      for (const candidateId of ['profile-only', 'code-only']) {
        const single = row(input, candidateId, taskId)
        single.pass = baseline.pass
        single.score = baseline.score
      }
    }

    const report = analyzeCrossSurfaceInteractions(input)
    const profile = report.candidates.find(
      (candidate) => candidate.candidate.candidateId === 'profile-only',
    )!
    const code = report.candidates.find(
      (candidate) => candidate.candidate.candidateId === 'code-only',
    )!

    expect(profile.eligibility).toEqual({
      eligible: false,
      reasons: ['benefit_not_greater_than_regression'],
    })
    expect(code.eligibility).toEqual({
      eligible: false,
      reasons: ['benefit_not_greater_than_regression'],
    })
    expect(report.selections.bestSingle).toBeNull()
    expect(report.selections.naiveStack).toBeNull()
    expect(report.pairwise[0]).toMatchObject({
      synergyTaskIds: ['t1', 't2', 't3'],
      compatibility: { compatible: true, reasons: [] },
    })
    expect(report.selections.interactionAware).toMatchObject({
      seedCandidateId: 'profile-code',
      terminalCandidateId: 'profile-code',
      selectedCandidateId: 'profile-code',
      qualified: true,
    })
  })

  it('reports antagonism and refuses to call the pair compatible', () => {
    const input = fixture()
    const pairPasses = [true, false, false, true, false]
    for (const [index, taskId] of TASKS.entries()) {
      const pairRow = row(input, 'profile-code', taskId)
      pairRow.pass = pairPasses[index]!
      pairRow.score = Number(pairPasses[index]!)
    }

    const report = analyzeCrossSurfaceInteractions(input)
    const pair = report.pairwise[0]!
    expect(pair.synergyTaskIds).toEqual([])
    expect(pair.interferenceTaskIds).toEqual(['t2'])
    expect(pair.compatibility.compatible).toBe(false)
    expect(pair.compatibility.reasons).toEqual(
      expect.arrayContaining(['interference', 'no_incremental_resolution']),
    )
    expect(report.selections.interactionAware).toBeNull()
  })

  it('walks higher-order bundles by incremental resolutions before cost', () => {
    const report = analyzeCrossSurfaceInteractions(threeSurfaceFixture())
    const selected = report.selections.interactionAware

    expect(report.selections.bestSingle?.candidateId).toBe('a')
    expect(report.selections.naiveStack).toEqual({
      candidateId: 'abc',
      componentIds: ['a', 'b', 'c'],
    })
    expect(selected?.seedCandidateId).toBe('ab')
    expect(selected?.steps[0]?.considered.find((decision) => decision.selected)).toMatchObject({
      additionCandidateId: 'c',
      bundleCandidateId: 'abc',
      incrementalResolutionTaskIds: ['u3', 'u5', 'u6'],
    })
    expect(selected?.evaluatedPaths.map((path) => path.seedCandidateId)).toEqual(['ab', 'ac', 'bc'])
    expect(selected).toMatchObject({
      terminalCandidateId: 'abc',
      selectedCandidateId: 'abc',
      terminalComponentIds: ['a', 'b', 'c'],
      qualified: true,
    })
  })

  it('beats an equal-input blind union only when another surface interferes', () => {
    const input = threeSurfaceFixture()
    const passes: Record<string, boolean[]> = {
      fixed: [false, false, false, false, false, false],
      a: [false, false, false, false, false, false],
      b: [false, false, false, false, false, false],
      c: [false, false, true, false, false, false],
      ab: [true, true, false, false, false, false],
      ac: [false, false, false, false, false, false],
      bc: [false, false, false, false, false, false],
      abc: [false, false, true, false, false, false],
    }
    for (const candidate of input.candidates) {
      input.taskOrder.forEach((taskId, index) => {
        const candidateRow = row(input, candidate.candidateId, taskId)
        candidateRow.pass = passes[candidate.candidateId]![index]!
        candidateRow.score = Number(candidateRow.pass)
      })
    }

    const report = analyzeCrossSurfaceInteractions(input)
    expect(report.selections.bestSingle?.candidateId).toBe('c')
    expect(report.selections.naiveStack).toEqual({ candidateId: 'c', componentIds: ['c'] })
    expect(report.pairwise.find((pair) => pair.compositionCandidateId === 'ab')).toMatchObject({
      compatibility: { compatible: true, reasons: [] },
      synergyTaskIds: ['u1', 'u2'],
    })
    for (const candidateId of ['ac', 'bc']) {
      expect(
        report.pairwise.find((pair) => pair.compositionCandidateId === candidateId),
      ).toMatchObject({
        compatibility: {
          compatible: false,
          reasons: expect.arrayContaining(['interference']),
        },
        interferenceTaskIds: ['u3'],
      })
    }
    expect(report.selections.interactionAware).toMatchObject({
      seedCandidateId: 'ab',
      terminalCandidateId: 'ab',
      terminalComponentIds: ['a', 'b'],
      selectedCandidateId: 'ab',
      qualified: true,
    })
  })

  it('uses the predeclared candidate order only after every substantive tie-break', () => {
    const input = fixture()
    input.candidateOrder = ['fixed', 'code-only', 'profile-only', 'profile-code']
    const profile = input.candidates.find((candidate) => candidate.candidateId === 'profile-only')!
    const code = input.candidates.find((candidate) => candidate.candidateId === 'code-only')!
    code.artifactBytes = profile.artifactBytes
    for (const taskId of TASKS) {
      const profileRow = row(input, 'profile-only', taskId)
      const codeRow = row(input, 'code-only', taskId)
      codeRow.pass = profileRow.pass
      codeRow.score = profileRow.score
      codeRow.cost = { ...profileRow.cost }
    }

    const report = analyzeCrossSurfaceInteractions(input)
    expect(report.selections.bestSingle?.ranking.map((candidate) => candidate.candidateId)).toEqual(
      ['code-only', 'profile-only'],
    )
    expect(report.selections.bestSingle?.candidateId).toBe('code-only')
  })

  it('preserves explicit missing attempts and excludes their candidate', () => {
    const input = fixture()
    const missing = row(input, 'code-only', 't5')
    missing.completeness = 'missing'
    missing.pass = null
    missing.score = null
    missing.componentEvidence = [{ componentId: 'code-change', fired: null, effectObserved: null }]
    missing.rejectReason = 'worker timed out after cost capture'

    const report = analyzeCrossSurfaceInteractions(input)
    expect(report.missingAttempts).toHaveLength(1)
    expect(report.missingAttempts[0]).toBe(missing)
    expect(report.missingAttempts[0]?.receipt).toBe('code-only/t5')
    const code = report.candidates.find(
      (candidate) => candidate.candidate.candidateId === 'code-only',
    )!
    expect(code.outcome.missingTaskIds).toEqual(['t5'])
    expect(code.eligibility).toMatchObject({ eligible: false })
    expect(code.eligibility?.reasons).toContain('missing_attempt')
    expect(code.comparisonToBaseline?.nPairs).toBe(5)
    expect(code.comparisonToBaseline?.correctness?.mcnemar.n).toBe(4)
    expect(report.rows).toHaveLength(4 * TASKS.length)
  })

  it('fails closed when a candidate silently drops a task from the shared axis', () => {
    const input = fixture()
    input.rows = input.rows.filter(
      (candidateRow) => !(candidateRow.candidateId === 'code-only' && candidateRow.taskId === 't5'),
    )
    expect(() => analyzeCrossSurfaceInteractions(input)).toThrow(/missing declared task row.*t5/)
  })

  it('marks a surface that never fires ineligible instead of crediting its pass rows', () => {
    const input = fixture()
    for (const taskId of TASKS) {
      const evidence = row(input, 'profile-only', taskId).componentEvidence[0]!
      evidence.fired = false
      evidence.effectObserved = false
    }

    const report = analyzeCrossSurfaceInteractions(input)
    const profile = report.candidates.find(
      (candidate) => candidate.candidate.candidateId === 'profile-only',
    )!
    expect(profile.firing.byComponent[0]?.notObservedTaskIds).toEqual([...TASKS])
    expect(profile.eligibility).toEqual({
      eligible: false,
      reasons: ['firing_below_minimum', 'effect_below_minimum'],
    })
    expect(report.selections.bestSingle?.candidateId).toBe('code-only')
    expect(report.selections.naiveStack?.candidateId).toBe('code-only')
    expect(report.pairwise[0]?.compatibility.reasons).toContain('constituent_not_ready')
  })

  it('keeps firing evidence distinct from observed behavioral effect', () => {
    const input = fixture()
    for (const taskId of TASKS) {
      row(input, 'profile-only', taskId).componentEvidence[0]!.effectObserved = false
    }

    const report = analyzeCrossSurfaceInteractions(input)
    const profile = report.candidates.find(
      (candidate) => candidate.candidate.candidateId === 'profile-only',
    )!
    expect(profile.firing.byComponent[0]?.observedTaskIds).toEqual([...TASKS])
    expect(profile.effect.byComponent[0]?.notObservedTaskIds).toEqual([...TASKS])
    expect(profile.eligibility).toEqual({
      eligible: false,
      reasons: ['effect_below_minimum'],
    })
  })

  it('fails closed on unknown cost instead of fabricating a zero', () => {
    const input = fixture()
    row(input, 'profile-code', 't3').cost.usd = null
    expect(() => analyzeCrossSurfaceInteractions(input)).toThrow(/unknown or invalid cost 'usd'/)
  })

  it('rejects behavioral effect evidence when its component did not fire', () => {
    const input = fixture()
    row(input, 'profile-only', 't1').componentEvidence[0] = {
      componentId: 'profile-change',
      fired: false,
      effectObserved: true,
    }
    expect(() => analyzeCrossSurfaceInteractions(input)).toThrow(
      /effectObserved=true requires fired=true.*profile-only\/t1/,
    )
  })

  it('rejects a minimum bundle size larger than the declared component set', () => {
    const input = fixture()
    input.selection.minimumBundleComponents = 3
    expect(() => analyzeCrossSurfaceInteractions(input)).toThrow(
      /minimumBundleComponents must be an integer in \[2,2\]/,
    )
  })

  it('is invariant to component, candidate, and row insertion order', () => {
    const forward = fixture()
    const reversed = fixture()
    reversed.components = [...reversed.components].reverse()
    reversed.candidates = [...reversed.candidates].reverse()
    reversed.rows = [...reversed.rows].reverse()

    expect(analyzeCrossSurfaceInteractions(reversed)).toEqual(
      analyzeCrossSurfaceInteractions(forward),
    )
  })
})
