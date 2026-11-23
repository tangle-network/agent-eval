import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import {
  compareOptimizationMethods,
  gepaOptimizationMethod,
  type GepaOptimizationRecipe,
  type JudgeConfig,
  type Scenario,
} from '../../src/campaign'
import { localOptimizerModel, startModelServer } from './official-optimizer-test-support'

interface TestScenario extends Scenario {
  prompt: string
}

interface TestArtifact {
  text: string
}

const officialPython = process.env.AGENT_EVAL_TEST_PYTHON?.trim()
const officialIt = officialPython ? it : it.skip

officialIt(
  'runs the installed GEPA optimizer and observes an upstream-generated candidate',
  async () => {
    const runDir = await mkdtemp(join(tmpdir(), 'agent-eval-official-gepa-'))
    const modelServer = await startModelServer('```\n{"k":2}\n```')

    try {
      const method = gepaOptimizationMethod<TestScenario, TestArtifact>({
        objective: 'Return a JSON configuration whose k value is 2.',
        evaluationId: 'official-gepa-typescript-integration',
        background: 'The complete candidate is one JSON object.',
        recipe: {
          kind: 'engine',
          run: {
            engine: 'gepa',
            maxEvaluations: 4,
            maxProposerCostUsd: 1,
            maxConcurrency: 1,
            stopAtScore: 1,
            engineConfig: {
              engine: {
                capture_stdio: false,
                max_workers: 1,
                parallel: false,
                raise_on_exception: true,
              },
              reflection: {
                reflection_minibatch_size: 1,
                skip_perfect_score: false,
              },
            },
          },
        },
        optimizer: localOptimizerModel(modelServer.baseUrl),
        describeScenario: (scenario) => ({ prompt: scenario.prompt }),
        describeArtifact: (artifact) => ({ text: artifact.text }),
        runner: {
          command: officialPython!,
          args: ['-m', 'agent_eval_rpc.gepa_bridge'],
        },
      })

      const result = await compareOptimizationMethods<TestScenario, TestArtifact>({
        methods: [method],
        baselineSurface: '{"k":1}',
        trainScenarios: [{ id: 'train', kind: 'qa', prompt: 'Set k to 2.' }],
        selectionScenarios: [{ id: 'selection', kind: 'qa', prompt: 'Set k to 2.' }],
        testScenarios: [
          { id: 'test-1', kind: 'qa', prompt: 'Set k to 2.' },
          { id: 'test-2', kind: 'qa', prompt: 'Set k to 2 again.' },
        ],
        dispatchWithSurface: async (surface) => ({ text: String(surface) }),
        judges: [kEqualsTwoJudge],
        runDir,
        costCeiling: 1,
        seed: 7,
        resamples: 40,
        expectUsage: 'off',
        optimizationRunOptions: { expectUsage: 'off' },
      })

      expect(modelServer.requests).toHaveLength(1)
      expect(modelServer.requests[0]).toMatchObject({
        authorization: 'Bearer provider-secret',
        path: '/v1/chat/completions',
        body: {
          model: 'local-model',
          max_tokens: 2_000,
        },
      })
      expect(JSON.parse(String(result.best.winnerSurface))).toEqual({ k: 2 })
      expect(result.best).toMatchObject({
        winnerComposite: 1,
        provenance: {
          source: { package: 'gepa', evidence: 'observed' },
          bridge: { package: 'agent-eval-rpc', evidence: 'observed' },
          seedApplied: true,
          tokenUsage: {
            inputTokens: 11,
            outputTokens: 13,
            totalTokens: 24,
            calls: 1,
          },
        },
      })
      expect(result.best.optimizationCost.accountingComplete).toBe(true)
    } finally {
      await modelServer.close()
      await rm(runDir, { recursive: true, force: true })
    }
  },
  300_000,
)

/**
 * One admitted reflection proposes a candidate that still fails, so GEPA would
 * keep iterating; the proxy refuses every later reflection. `inflateAttempts`
 * adds one uncounted attempt to the bridge's report, as a request lost before
 * it reached the proxy would.
 */
async function runPastTheRequestCap(inflateAttempts: boolean) {
  const runDir = await mkdtemp(join(tmpdir(), 'agent-eval-official-gepa-cap-'))
  const modelServer = await startModelServer('```\n{"k":3}\n```')
  const recipe: GepaOptimizationRecipe = {
    kind: 'engine',
    run: {
      engine: 'gepa',
      maxEvaluations: 40,
      maxProposerCostUsd: 1,
      maxConcurrency: 1,
      engineConfig: {
        engine: { capture_stdio: false, max_workers: 1, parallel: false, raise_on_exception: true },
        reflection: { reflection_minibatch_size: 1, skip_perfect_score: false },
      },
    },
  }
  const inflate = [
    'import json, runpy, sys',
    'runpy.run_module("agent_eval_rpc.gepa_bridge", run_name="__main__")',
    'path = sys.argv[sys.argv.index("--output") + 1]',
    'value = json.load(open(path))',
    'if "tokenUsage" in value:',
    '    value["tokenUsage"]["requestAttempts"] += 1',
    '    json.dump(value, open(path, "w"))',
  ].join('\n')
  try {
    const result = await compareOptimizationMethods<TestScenario, TestArtifact>({
      methods: [
        gepaOptimizationMethod<TestScenario, TestArtifact>({
          objective: 'Return a JSON configuration whose k value is 2.',
          evaluationId: 'official-gepa-request-cap',
          recipe,
          optimizer: localOptimizerModel(modelServer.baseUrl, { maxRequests: 1 }),
          describeScenario: (scenario) => ({ prompt: scenario.prompt }),
          describeArtifact: (artifact) => ({ text: artifact.text }),
          runner: {
            command: officialPython!,
            args: inflateAttempts ? ['-c', inflate] : ['-m', 'agent_eval_rpc.gepa_bridge'],
          },
        }),
      ],
      baselineSurface: '{"k":1}',
      trainScenarios: [{ id: 'train', kind: 'qa', prompt: 'Set k to 2.' }],
      selectionScenarios: [{ id: 'selection', kind: 'qa', prompt: 'Set k to 2.' }],
      testScenarios: [
        { id: 'test-1', kind: 'qa', prompt: 'Set k to 2.' },
        { id: 'test-2', kind: 'qa', prompt: 'Set k to 2 again.' },
      ],
      dispatchWithSurface: async (surface) => ({ text: String(surface) }),
      judges: [kEqualsTwoJudge],
      runDir,
      costCeiling: 1,
      seed: 7,
      resamples: 40,
      expectUsage: 'off',
      optimizationRunOptions: { expectUsage: 'off' },
    })
    const artifactDir = result.best.provenance!.artifactDir
    const selectionFiles = (await readdir(artifactDir)).filter((file) =>
      /^selection-[0-9a-f]{32}\.json$/.test(file),
    )
    const selections = await Promise.all(
      selectionFiles.map(async (file) =>
        JSON.parse(await readFile(join(artifactDir, file), 'utf8')),
      ),
    )
    return { result, selections, modelRequests: modelServer.requests.length }
  } finally {
    await modelServer.close()
    await rm(runDir, { recursive: true, force: true })
  }
}

officialIt(
  'ends the GEPA run at the reflection request cap and counts refusals on both sides',
  async () => {
    const { result, selections, modelRequests } = await runPastTheRequestCap(false)

    expect(modelRequests).toBe(1)
    const requests = result.best.provenance!.optimizerModelRequests!
    expect(requests).toMatchObject({ requestAttempts: 1, successfulCompletions: 1 })
    expect(requests.refusedRequests).toBeGreaterThanOrEqual(1)
    // Seed on selection, then one parent minibatch per iteration plus the
    // proposal's: the run stops at the first refusal, not at 40 evaluations.
    expect(result.best.provenance!.evaluationCount).toBeLessThanOrEqual(4)
    expect(result.best.optimizationCost.accountingComplete).toBe(true)
    expect(selections).toHaveLength(1)
    expect(selections[0].bestCandidate).toBe('{"k":1}')
    expect(selections[0].tokenUsage).toMatchObject({
      calls: 1,
      requestAttempts: 1 + requests.refusedRequests,
      refusedAttempts: requests.refusedRequests,
    })
  },
  300_000,
)

officialIt(
  'keeps the selection and reports a failed usage check when the attempt counts disagree',
  async () => {
    const { result, selections } = await runPastTheRequestCap(true)

    expect(String(result.best.winnerSurface)).toBe('{"k":1}')
    expect(selections).toHaveLength(1)
    expect(result.best.optimizationCost.accountingComplete).toBe(false)
    expect(result.best.optimizationCost.incompleteReasons).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /usage check failed: .*reported \d+ model attempts but the proxy admitted 1 and refused \d+$/,
        ),
      ]),
    )
  },
  300_000,
)

const kEqualsTwoJudge: JudgeConfig<TestArtifact, TestScenario> = {
  name: 'k-equals-two',
  dimensions: [{ key: 'correctness', description: 'candidate sets k to 2' }],
  score: ({ artifact }) => {
    let score = 0
    try {
      const candidate = JSON.parse(artifact.text) as { k?: unknown }
      score = candidate.k === 2 ? 1 : 0
    } catch {
      score = 0
    }
    return {
      dimensions: { correctness: score },
      composite: score,
      notes: score ? '' : 'The candidate must be JSON with k set to 2.',
    }
  },
}
