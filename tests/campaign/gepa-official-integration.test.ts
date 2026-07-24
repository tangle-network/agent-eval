import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import {
  compareOptimizationMethods,
  gepaOptimizationMethod,
  type JudgeConfig,
  type Scenario,
} from '../../src/campaign'
import { startModelServer } from './official-optimizer-test-support'

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
                seed: 7,
              },
              reflection: {
                reflection_minibatch_size: 1,
                skip_perfect_score: false,
              },
            },
          },
        },
        optimizer: optimizerModel(modelServer.baseUrl),
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

function optimizerModel(baseUrl: string) {
  return {
    model: 'local-model',
    baseUrl,
    apiKey: 'provider-secret',
    budget: {
      maxCostUsd: 1,
      maxRequests: 10,
      maxRequestBytes: 100_000,
      maxResponseBytes: 100_000,
      maxOutputTokensPerRequest: 2_000,
      pricing: {
        inputUsdPerMillion: 1,
        outputUsdPerMillion: 2,
      },
    },
  }
}
