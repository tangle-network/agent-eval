import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  compareOptimizationMethods,
  gepaOptimizationMethod,
  type JudgeConfig,
  type Scenario,
} from '../../src/campaign'

interface TestScenario extends Scenario {
  kind: string
  prompt: string
  privateNote: string
}

interface TestArtifact {
  text: string
}

let runDir: string

beforeEach(() => {
  runDir = mkdtempSync(join(tmpdir(), 'gepa-method-'))
})

afterEach(() => {
  rmSync(runDir, { recursive: true, force: true })
})

describe('gepaOptimizationMethod', () => {
  it('requires an explicit proposer cost cap', () => {
    expect(() =>
      gepaOptimizationMethod({
        recipe: {
          kind: 'engine',
          run: { engine: 'best_of_n', maxEvaluations: 1 },
        },
        objective: 'Return a better policy.',
      } as never),
    ).toThrow('recipe.run.maxProposerCostUsd must be a positive finite number')
  })

  it('exposes only described train and selection cases to the external process', async () => {
    const observedInputPath = join(runDir, 'external-input.json')
    const runner = fakeGepaRunner(observedInputPath)
    const method = gepaOptimizationMethod<TestScenario, TestArtifact>({
      recipe: {
        kind: 'engine',
        run: {
          engine: 'best_of_n',
          maxEvaluations: 1,
          maxProposerCostUsd: 1,
        },
      },
      objective: 'Return the better policy.',
      describeScenario: (scenario) => ({ prompt: scenario.prompt }),
      runner,
    })

    const result = await compareOptimizationMethods<TestScenario, TestArtifact>({
      methods: [method],
      baselineSurface: 'baseline',
      trainScenarios: [
        { id: 'train', kind: 'qa', prompt: 'visible train prompt', privateNote: 'TRAIN_SECRET' },
      ],
      selectionScenarios: [
        {
          id: 'selection',
          kind: 'qa',
          prompt: 'visible selection prompt',
          privateNote: 'SELECTION_SECRET',
        },
      ],
      testScenarios: [
        { id: 'final', kind: 'qa', prompt: 'private final prompt', privateNote: 'FINAL_SECRET' },
        { id: 'final-2', kind: 'qa', prompt: 'second final prompt', privateNote: 'FINAL_SECRET_2' },
      ],
      dispatchWithSurface: async (surface) => ({ text: String(surface) }),
      judges: [betterJudge],
      runDir,
      seed: 11,
      resamples: 40,
      expectUsage: 'off',
    })

    const observed = JSON.parse(readFileSync(observedInputPath, 'utf8')) as Record<string, unknown>
    expect(observed).toMatchObject({
      version: 2,
      recipe: {
        kind: 'engine',
        run: {
          engine: 'best_of_n',
          maxEvaluations: 1,
          maxProposerCostUsd: 1,
        },
      },
      trainSet: [{ id: 'train', data: { prompt: 'visible train prompt' } }],
      selectionSet: [{ id: 'selection', data: { prompt: 'visible selection prompt' } }],
    })
    expect(JSON.stringify(observed)).not.toContain('SECRET')
    expect(observed).not.toHaveProperty('testSet')
    expect(observed).not.toHaveProperty('test_set')
    expect(basename(String(observed.cwd))).toMatch(/^agent-eval-gepa-/)
    expect(String(observed.cwd)).not.toContain(runDir)

    expect(result.scores[0]!.winnerSurface).toBe('better')
    expect(result.scores[0]!.baselineComposite).toBe(0)
    expect(result.scores[0]!.winnerComposite).toBe(1)
    expect(result.scores[0]!.optimizationCost.accountingComplete).toBe(false)
    expect(result.scores[0]!.optimizationCost.incompleteReasons).toContain(
      'GEPA proposer cost is unavailable',
    )
  })
})

const betterJudge: JudgeConfig<TestArtifact, TestScenario> = {
  name: 'better',
  dimensions: [{ key: 'better', description: 'candidate is the known better surface' }],
  score: ({ artifact }) => {
    const score = artifact.text === 'better' ? 1 : 0
    return { dimensions: { better: score }, composite: score, notes: '' }
  },
}

function fakeGepaRunner(observedInputPath: string) {
  const source = [
    "const fs = require('node:fs')",
    "const inputPath = process.argv[process.argv.indexOf('--input') + 1]",
    "const outputPath = process.argv[process.argv.indexOf('--output') + 1]",
    'const input = JSON.parse(fs.readFileSync(inputPath, "utf8"))',
    `fs.writeFileSync(${JSON.stringify(observedInputPath)}, JSON.stringify({ ...input, cwd: process.cwd() }))`,
    ';(async () => {',
    '  const response = await fetch(input.callbackUrl, {',
    '    method: "POST",',
    '    headers: { authorization: "Bearer " + input.callbackToken, "content-type": "application/json" },',
    '    body: JSON.stringify({ candidate: "better", exampleId: input.trainSet[0].id }),',
    '  })',
    '  if (!response.ok) throw new Error("callback failed: " + response.status)',
    '  const scored = await response.json()',
    '  fs.writeFileSync(outputPath, JSON.stringify({',
    '    bestCandidate: "better",',
    '    bestScore: scored.score,',
    '    totalEvaluations: 1,',
    '    recipeKind: input.recipe.kind,',
    '    proposerCostAccounting: "unavailable",',
    '  }))',
    '})().catch((error) => { console.error(error); process.exit(1) })',
  ].join('\n')
  return { command: process.execPath, args: ['-e', source, '--'] }
}
