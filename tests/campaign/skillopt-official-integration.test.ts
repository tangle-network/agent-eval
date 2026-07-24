import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import {
  compareOptimizationMethods,
  type JudgeConfig,
  type Scenario,
  skillOptOptimizationMethod,
} from '../../src/campaign'

interface TestScenario extends Scenario {
  prompt: string
}

interface TestArtifact {
  text: string
}

const officialPython = process.env.AGENT_EVAL_TEST_PYTHON?.trim()
const officialIt = officialPython ? it : it.skip

officialIt(
  'runs the installed SkillOpt optimizer without caller-supplied model environment',
  async () => {
    const runDir = await mkdtemp(join(tmpdir(), 'agent-eval-official-skillopt-'))
    const modelRequests: Array<Record<string, unknown>> = []
    const modelServer = createServer(async (request, response) => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
      modelRequests.push({
        authorization: request.headers.authorization,
        path: request.url,
        body,
      })
      const content = JSON.stringify({
        batch_size: 1,
        failure_summary: [
          {
            count: 1,
            description: 'The required response rule is absent.',
            failure_type: 'missing_rule',
          },
        ],
        patch: {
          edits: [
            {
              content: '\n\n## Required Rule\nALWAYS_RETURN_READY\n',
              op: 'append',
            },
          ],
          reasoning: 'Add the missing response rule.',
        },
      })
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({
          choices: [
            {
              finish_reason: 'stop',
              index: 0,
              message: { content, role: 'assistant' },
            },
          ],
          created: 0,
          id: 'chatcmpl-local',
          model: 'local-model',
          object: 'chat.completion',
          usage: {
            completion_tokens: 13,
            prompt_tokens: 11,
            total_tokens: 24,
          },
        }),
      )
    })

    try {
      const baseUrl = await listen(modelServer)
      const method = skillOptOptimizationMethod<TestScenario, TestArtifact>({
        objective: 'Add the required response rule.',
        evaluationId: 'official-skillopt-typescript-integration',
        trainer: {
          epochs: 1,
          batchSize: 1,
          accumulation: 1,
          editBudget: 1,
          minEditBudget: 1,
          analystWorkers: 1,
          minibatchSize: 1,
          maxAnalystRounds: 1,
          evaluationWorkers: 1,
        },
        optimizer: {
          model: 'local-model',
          baseUrl,
          apiKey: 'provider-secret',
          budget: {
            maxCostUsd: 1,
            maxRequests: 10,
            maxRequestBytes: 100_000,
            maxResponseBytes: 100_000,
            maxOutputTokensPerRequest: 256,
            pricing: {
              inputUsdPerMillion: 1,
              outputUsdPerMillion: 2,
            },
          },
        },
        maxEvaluations: 3,
        runner: { command: officialPython! },
      })

      const result = await compareOptimizationMethods<TestScenario, TestArtifact>({
        methods: [method],
        baselineSurface: '# Base Skill\nAnswer normally.\n',
        trainScenarios: [{ id: 'train', kind: 'qa', prompt: 'Return READY.' }],
        selectionScenarios: [{ id: 'selection', kind: 'qa', prompt: 'Return READY.' }],
        testScenarios: [
          { id: 'test-1', kind: 'qa', prompt: 'Return READY.' },
          { id: 'test-2', kind: 'qa', prompt: 'Return READY again.' },
        ],
        dispatchWithSurface: async (surface) => ({ text: String(surface) }),
        judges: [requiredRuleJudge],
        runDir,
        seed: 7,
        resamples: 40,
        expectUsage: 'off',
      })

      expect(modelRequests).toHaveLength(1)
      expect(modelRequests[0]).toMatchObject({
        authorization: 'Bearer provider-secret',
        path: '/v1/chat/completions',
        body: {
          model: 'local-model',
          max_tokens: 256,
        },
      })
      expect(result.best.winnerSurface).toContain('ALWAYS_RETURN_READY')
      expect(result.best.winnerComposite).toBe(1)
      expect(result.best.provenance?.tokenUsage).toEqual({
        inputTokens: 11,
        outputTokens: 13,
        totalTokens: 24,
        calls: 1,
      })
    } finally {
      modelServer.closeAllConnections?.()
      await new Promise<void>((resolve, reject) => {
        modelServer.close((error) => (error ? reject(error) : resolve()))
      })
      await rm(runDir, { recursive: true, force: true })
    }
  },
  60_000,
)

const requiredRuleJudge: JudgeConfig<TestArtifact, TestScenario> = {
  name: 'required-rule',
  dimensions: [{ key: 'correctness', description: 'candidate contains required rule' }],
  score: ({ artifact }) => {
    const score = artifact.text.includes('ALWAYS_RETURN_READY') ? 1 : 0
    return {
      dimensions: { correctness: score },
      composite: score,
      notes: score ? '' : 'The required response rule is absent.',
    }
  },
}

async function listen(server: ReturnType<typeof createServer>): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('model server failed to bind')
  return `http://127.0.0.1:${address.port}/v1`
}
