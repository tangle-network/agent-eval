import { createHash } from 'node:crypto'
import { lstat, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { campaignSplitDigest } from '../../../src/campaign/coverage.ts'
import { sequentialPairedGate } from '../../../src/campaign/gates/sequential.ts'
import type { JudgeScore } from '../../../src/campaign/types.ts'
import { HoldoutAuditor } from '../../../src/contamination-guard.ts'
import { selfImprove } from '../../../src/contract/self-improve.ts'
import { evaluatePowerFloorGate } from '../../../src/experiment/ast.ts'
import { compareCodeUnits, hashCanonical } from '../../../src/ledger-core/canonical.ts'
import { correlationStudy } from '../../../src/meta-eval/correlation-study.ts'
import { InMemoryOutcomeStore } from '../../../src/meta-eval/outcome-store.ts'
import { rubricPredictiveValidity } from '../../../src/meta-eval/rubric-predictive-validity.ts'
import { compareAdaptationCurves, runAdaptationCurve } from '../../../src/rl/adaptation-eval.ts'
import { runContaminationProbe } from '../../../src/rl/contamination.ts'
import { PredictiveValidityResearcher } from '../../../src/rl/predictive-validity-researcher.ts'
import type { RunRecord } from '../../../src/run-record.ts'
import { TraceEmitter } from '../../../src/trace/emitter.ts'
import { InMemoryTraceStore } from '../../../src/trace/store.ts'

// These diagnostics record behavior without asserting that a defect must remain.
const reviewedBaseRevision = 'fe1cc5111aab5d588bf7db3a3785325635937a91'
const command = 'pnpm exec tsx docs/design/mlbenchmarks-review/probes.mts'
const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url))
const sourcePaths = ['src', 'package.json', 'pnpm-lock.yaml', 'tsconfig.json']

async function fileEntries(path: string): Promise<Array<{ path: string; sha256: string }>> {
  const absolutePath = join(repositoryRoot, path)
  const metadata = await lstat(absolutePath)
  if (metadata.isDirectory()) {
    const children = await readdir(absolutePath)
    return (await Promise.all(children.map(child => fileEntries(`${path}/${child}`)))).flat()
  }
  if (!metadata.isFile()) throw new Error(`Source identity requires a regular file: ${path}`)
  return [{ path, sha256: createHash('sha256').update(await readFile(absolutePath)).digest('hex') }]
}

// Hash working files, including untracked files, so Git index state cannot hide changes.
const sourceFiles = (await Promise.all(sourcePaths.map(fileEntries)))
  .flat()
  .sort((left, right) => compareCodeUnits(left.path, right.path))
const sourceIdentity = {
  algorithm: 'sha256-canonical-file-manifest',
  paths: sourcePaths,
  fileCount: sourceFiles.length,
  digest: hashCanonical({ domain: 'agent-eval-mlbenchmarks-review-source-v1', files: sourceFiles }),
  dependencyScope: 'Records the manifest and lockfile; assumes dependencies were installed from that lockfile.',
}
const diagnosticPath = 'docs/design/mlbenchmarks-review/probes.mts'
const diagnosticIdentity = {
  path: diagnosticPath,
  sha256: createHash('sha256').update(await readFile(join(repositoryRoot, diagnosticPath))).digest('hex'),
}

async function holdoutReuse() {
  const runRoot = await mkdtemp(join(tmpdir(), 'agent-eval-mlbenchmarks-review-'))
  const train = Array.from({ length: 6 }, (_, i) => ({
    id: `train-${i}`,
    kind: 'offline-probe',
  }))
  const final = Array.from({ length: 6 }, (_, i) => ({
    id: `final-${i}`,
    kind: 'offline-probe',
  }))
  const rounds = []
  try {
    for (const round of [1, 2]) {
      const finalDispatches: string[] = []
      let agentCallbacks = 0
      let judgeCallbacks = 0
      let proposerCallbacks = 0
      const result = await selfImprove({
        scenarios: train,
        baselineSurface: 'baseline',
        model: 'deterministic-probe@2026-09-12',
        agent: async (surface, scenario) => {
          agentCallbacks++
          if (scenario.id.startsWith('final-')) finalDispatches.push(scenario.id)
          return String(surface)
        },
        judge: {
          name: 'marker',
          dimensions: [{ key: 'pass', description: 'Output has the marker' }],
          score: ({ artifact }) => {
            judgeCallbacks++
            const pass = artifact.includes('marker') ? 1 : 0
            return { dimensions: { pass }, composite: pass, notes: '' }
          },
        },
        proposer: {
          kind: 'offline-probe',
          propose: async () => {
            proposerCallbacks++
            return [{
              surface: 'marker',
              label: 'marker',
              rationale: 'Synthetic repeat-access probe',
            }]
          },
        },
        budget: { generations: 1, populationSize: 1, holdoutScenarios: final },
        runDir: join(runRoot, `round-${round}`),
        expectUsage: 'off',
      })
      rounds.push({
        round,
        gateDecision: result.gateDecision,
        finalDispatches: finalDispatches.length,
        distinctFinalIds: new Set(finalDispatches).size,
        finalSplitDigest: campaignSplitDigest(final, 1),
        agentCallbacks,
        judgeCallbacks,
        proposerCallbacks,
      })
    }
  } finally {
    // Remove only the directory allocated for this invocation.
    await rm(runRoot, { recursive: true, force: true })
  }
  const auditor = new HoldoutAuditor([
    { id: 'heldout', payload: 'hidden', split: 'holdout' },
  ])
  auditor.get('heldout', 'debugging')
  auditor.get('heldout', 'evaluation')
  return {
    inputs: {
      calls: 2,
      trainCases: train.length,
      finalCases: final.length,
      generationsPerCall: 1,
      populationPerGeneration: 1,
      replicatesPerCase: 1,
      sameFinalPayloadsOnBothCalls: true,
      firstResultFedToSecondProposer: false,
      baselineSurface: 'baseline',
      proposedSurface: 'marker',
      scoring: '1 if artifact contains marker, otherwise 0',
      expectUsage: 'off',
    },
    results: {
      rounds,
      accessPurposes: auditor.getAccessLog().map(entry => entry.purpose),
      temporaryRunDirectoriesRemoved: true,
    },
    limitations: [
      'Measures repeated final-set access and debugging access, not empirical overfitting.',
      'The calls use deterministic local callbacks and independent temporary run directories.',
      'Does not estimate false-promotion frequency or test a downstream access-control service.',
    ],
  }
}

async function outcomeKeyOrder() {
  const rows = Array.from({ length: 10 }, (_, i) => {
    const score = (i + 1) / 10
    return { score, retention: 1 - score, csat: score }
  })
  const results = []
  for (const keyOrder of ['retention-first', 'csat-first'] as const) {
    const traces = new InMemoryTraceStore()
    const outcomes = new InMemoryOutcomeStore()
    let tick = 0
    for (const [i, row] of rows.entries()) {
      const emitter = new TraceEmitter(traces, {
        runId: `outcome-fixture-${i}`,
        now: () => ++tick,
      })
      await emitter.startRun({ scenarioId: `scenario-${i}` })
      await emitter.endRun({ pass: true, score: row.score })
      await outcomes.append({
        runId: emitter.runId,
        capturedAt: ++tick,
        metrics: keyOrder === 'retention-first'
          ? { retention: row.retention, csat: row.csat }
          : { csat: row.csat, retention: row.retention },
      })
    }
    results.push({
      keyOrder,
      latest: await correlationStudy(traces, outcomes, [{ id: 'score' }], ['csat'], {
        seed: 1,
        bootstrapIterations: 500,
      }),
      mean: await correlationStudy(traces, outcomes, [{ id: 'score' }], ['csat'], {
        seed: 1,
        bootstrapIterations: 500,
        reduction: 'mean',
      }),
    })
  }
  return {
    inputs: {
      n: rows.length,
      rows,
      outcomeRowsPerRun: 1,
      requestedMetric: 'csat',
      expectedPearsonForRequestedMetric: 1,
      expectedSpearmanForRequestedMetric: 1,
      seed: 1,
      bootstrapIterations: 500,
    },
    results,
    limitations: [
      'Tests metric selection and JSON key order with constructed data, not deployment validity.',
      'Each run has one outcome row, so latest and mean refer to the same requested observation.',
    ],
  }
}

async function adaptationPairing() {
  const scenariosA = [{ scenarioId: 'easy-only', score: 0.9 }]
  const scenariosB = [{ scenarioId: 'hard-only', score: 0.1 }]
  const runner = {
    run: async ({ scenario }: { scenario: { score: number } }) => scenario.score,
  }
  const ks = [0, 1]
  const reps = 1
  const a = await runAdaptationCurve<{ scenarioId: string; score: number }>({
    scenarios: scenariosA, ks, reps, runner,
  })
  const b = await runAdaptationCurve<{ scenarioId: string; score: number }>({
    scenarios: scenariosB, ks, reps, runner,
  })
  return {
    inputs: {
      scenariosA,
      scenariosB,
      ks,
      reps,
      observationsPerArm: ks.length * reps,
      commonScenarios: scenariosA.filter(a => scenariosB.some(b => a.scenarioId === b.scenarioId)).length,
      sameRunnerForBothArms: true,
      bootstrapSeed: 1,
    },
    results: compareAdaptationCurves(a, b, { seed: 1 }),
    limitations: [
      'The two arms differ in task difficulty; zero task identities overlap.',
      'This probes the adaptation helper, not the separately implemented campaign paired comparison.',
    ],
  }
}

async function contaminationDisplay() {
  const originals = Array.from({ length: 12 }, (_, i) => ({
    id: `case-${i}`,
    score: 1,
  }))
  const perturbed = originals.map(scenario => ({ ...scenario, score: 0.4 }))
  const result = await runContaminationProbe({
    scenarioId: scenario => scenario.id,
    originals,
    perturbed,
    scoreFn: async scenario => scenario.score,
  })
  return {
    inputs: {
      n: originals.length,
      originalScorePerCase: 1,
      perturbedScorePerCase: 0.4,
      observationsPerCasePerCondition: 1,
      modelTrainingExposure: 'No model is used; scores are constructed fixture values.',
    },
    results: result,
    limitations: [
      'The global Wilcoxon test measures the constructed paired difference; it does not identify contamination as its cause.',
      'Per-item qValue uses BH on 1 - abs(delta), without a per-item sampling null; it is a display aid in the inspected source.',
      'The per-item qValues do not drive the global contaminationSuspected result.',
    ],
  }
}

async function negativeOutcomeDirection() {
  const rows = Array.from({ length: 8 }, (_, i) => ({
    quality: i / 7,
    successRate: 1 - i / 7,
  }))
  const runs: RunRecord[] = []
  const outcomes = new InMemoryOutcomeStore()
  for (const [i, row] of rows.entries()) {
    const runId = `direction-fixture-${i}`
    runs.push({
      runId,
      experimentId: 'book-review-fixture',
      candidateId: 'same-candidate',
      scenarioId: `direction-scenario-${i}`,
      seed: 0,
      model: 'fixture@1',
      promptHash: '0'.repeat(64),
      configHash: '1'.repeat(64),
      commitSha: reviewedBaseRevision,
      wallMs: 0,
      costUsd: 0,
      costProvenance: { kind: 'observed', usd: 0 },
      tokenUsage: { input: 0, output: 0 },
      terminalOutcome: 'succeeded',
      splitTag: 'holdout',
      outcome: { holdoutScore: row.quality, raw: { quality: row.quality } },
    })
    await outcomes.append({
      runId,
      capturedAt: i,
      metrics: { success_rate: row.successRate },
    })
  }
  const report = await rubricPredictiveValidity({
    runs,
    outcomes,
    outcomeMetrics: ['success_rate'],
    rubrics: ['quality'],
    seed: 1,
    bootstrapResamples: 100,
  })
  const researcher = new PredictiveValidityResearcher({
    outcomes,
    outcomeMetrics: ['success_rate'],
    rubrics: ['quality'],
  })
  const researcherReport = await researcher.runValidityCheck(runs)
  const failures = await researcher.inspectFailures(runs)
  const changes = await researcher.proposeChange(failures)
  return {
    inputs: {
      n: rows.length,
      rows,
      rubric: 'quality',
      outcome: 'success_rate',
      desiredOutcomeDirection: 'increase',
      seed: 1,
      bootstrapResamples: 100,
      researcherBootstrapResamples: 500,
      researcherSeed: 'Derived deterministically by the validity helper',
      researcherFailureThreshold: 0.5,
    },
    results: {
      report,
      researcher: {
        report: researcherReport,
        failureGroups: failures.length,
        failures: failures.map(failure => ({
          code: failure.code,
          description: failure.description,
          samples: failure.evidence.samples,
        })),
        proposedChanges: changes,
      },
    },
    limitations: [
      'Magnitude-based bucketing is intentional in existing tests, despite contradictory interface prose.',
      'A negative association can be desirable for an outcome such as failure rate; direction needs explicit interpretation.',
      'The researcher recommends increasing rubric weight despite its negative association with desired success rate; it does not execute or deploy that recommendation.',
      'Constructed perfect correlation establishes neither causal validity nor held-out predictive performance.',
    ],
  }
}

async function sequentialDependence() {
  const options = { alpha: 0.05, minN: 5, maxN: 100, shuffleSeed: 1337 }
  const branches = []
  for (const delta of [-1, 1]) {
    const scores = (composite: number): Record<string, JudgeScore> => ({
      judge: { composite, dimensions: {}, notes: '' },
    })
    const baseline = new Map(Array.from({ length: 100 }, (_, i) => [
      `task:${i}`,
      scores(delta > 0 ? 0 : 1),
    ]))
    const candidate = new Map(Array.from({ length: 100 }, (_, i) => [
      `task:${i}`,
      scores(delta > 0 ? 1 : 0),
    ]))
    const result = await sequentialPairedGate(options).decide({
      scenarios: [{ id: 'task', kind: 'synthetic-common-sign' }],
      judgeScores: candidate,
      baselineJudgeScores: baseline,
      candidateArtifacts: new Map(),
      baselineArtifacts: new Map(),
      cost: { candidate: 0, baseline: 0 },
      signal: new AbortController().signal,
    })
    branches.push({ commonDelta: delta, probability: 0.5, result })
  }
  return {
    inputs: {
      ...options,
      branchesEnumerated: branches.length,
      cellsPerBranch: 100,
      independentRandomSignsPerExperiment: 1,
      dataGeneratingProcess: 'Draw one fair sign Z; set all 100 paired deltas equal to Z.',
      exchangeable: true,
      marginalMeanDelta: 0,
      conditionalMeanAfterFirstObservation: 'Z, not necessarily <= 0',
    },
    results: {
      branches,
      promotionProbabilityUnderMarginalZeroProcess: branches.reduce(
        (sum, branch) => sum + (branch.result.decision === 'ship' ? branch.probability : 0),
        0,
      ),
    },
    limitations: [
      'Enumerates both equiprobable branches exactly; this is not a Monte Carlo estimate.',
      'The process violates the conditional-mean null required by the e-process core.',
      'This refutes sufficiency of exchangeability and shuffling, not the valid e-process theorem or any measured production dataset.',
    ],
  }
}

function powerFloor() {
  const gate = {
    kind: 'power-floor' as const,
    target: 0.8,
    effectGrid: [0.01, 1],
    sim: { trials: 1, resamples: 1, seed: 1 },
  }
  const curve = [{ effect: 0.01, power: 0.1 }, { effect: 1, power: 1 }]
  return {
    inputs: {
      gate,
      curve,
      practicalEffectForInterpretation: 0.01,
      curveSource: 'Supplied deterministic fixture; no power simulation is run.',
    },
    results: evaluatePowerFloorGate('floor', gate, curve),
    limitations: [
      'The inspected gate documents a maximum-over-grid structural feasibility check; this output matches that contract.',
      'Passing this gate does not establish target power at the practical effect of 0.01.',
      'The fixture powers are inputs, not measured or simulated power estimates.',
    ],
  }
}

const observations = {
  reviewedBaseRevision,
  sourceIdentity,
  diagnosticIdentity,
  command,
  paidModelCalls: 0,
  execution: {
    kind: 'offline deterministic diagnostic',
    modelCalls: 0,
    callbackImplementation: 'Local arithmetic and string checks only; no provider clients are supplied.',
    temporaryRunStorage: 'Allocated under the OS temporary directory and removed in finally.',
    outputPolicy: 'Preserves current returned measurements; excludes temporary paths, run IDs, and wallclock fields.',
    assertionPolicy: 'No assertions require the observed defects or policy boundaries to persist.',
  },
  probes: {
    holdoutReuse: await holdoutReuse(),
    outcomeKeyOrder: await outcomeKeyOrder(),
    adaptationPairing: await adaptationPairing(),
    contaminationDisplay: await contaminationDisplay(),
    negativeOutcomeDirection: await negativeOutcomeDirection(),
    sequentialDependence: await sequentialDependence(),
    powerFloor: powerFloor(),
  },
  separateVerificationAtReviewedBase: {
    provenance: 'Historical checks at reviewedBaseRevision; this diagnostic does not rerun them.',
    sourceRevision: reviewedBaseRevision,
    checks: [
      { command: 'pnpm typecheck', result: 'passed' },
      { command: 'pnpm build', result: 'passed' },
      { command: 'pnpm verify:package', result: 'passed' },
    ],
    tests: {
      command: 'pnpm test -- tests/experiment/preregistration-acceptance.test.ts tests/experiment/power.test.ts tests/contamination-guard.test.ts tests/rl-predictive-validity-researcher.test.ts tests/rubric-predictive-validity.test.ts tests/meta-eval.test.ts',
      observedScope: 'The package command expanded to the full Vitest suite.',
      files: { passed: 399, skipped: 2 },
      tests: { passed: 5876, skipped: 3 },
      result: 'passed',
    },
    limitation: 'Passing repository checks do not establish correctness of the counterexample behaviors recorded above.',
  },
}

console.log(JSON.stringify(observations, null, 2))
