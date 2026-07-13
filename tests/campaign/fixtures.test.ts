import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  type DispatchFn,
  discoverEvalFixtures,
  type EvalFixtureScenario,
  loadEvalFixture,
  loadEvalFixtureScenarios,
  planEvalFixtureRun,
  runCampaign,
} from '../../src/campaign/index'

interface FixtureArtifact {
  prompt: string
  fingerprint: string
}

let root: string
let evalsDir: string
let runDir: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'eval-fixtures-'))
  evalsDir = join(root, 'evals')
  runDir = join(root, 'runs')
  mkdirSync(evalsDir, { recursive: true })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('eval fixture UX', () => {
  it('discovers nested PROMPT.md fixtures in stable order', () => {
    writeFixture('group/beta')
    writeFixture('alpha')
    writeFixture('.hidden')

    expect(discoverEvalFixtures(evalsDir)).toEqual(['alpha', 'group/beta'])
  })

  it('loads strict Vitest fixtures and fingerprints files plus config', () => {
    writeFixture('alpha', { prompt: 'Build the dashboard' })

    const modelA = loadEvalFixture(evalsDir, 'alpha', {
      fingerprintConfig: { model: 'model-a' },
    })
    const modelB = loadEvalFixture(evalsDir, 'alpha', {
      fingerprintConfig: { model: 'model-b' },
    })

    expect(modelA.prompt).toBe('Build the dashboard')
    expect(modelA.evalPath?.endsWith('EVAL.ts')).toBe(true)
    expect(modelA.packageJsonPath?.endsWith('package.json')).toBe(true)
    expect(modelA.files.map((file) => file.path).sort()).toEqual([
      'EVAL.ts',
      'PROMPT.md',
      'package.json',
      'src/app.ts',
    ])
    expect(modelA.fingerprint).not.toBe(modelB.fingerprint)

    writeFileSync(join(evalsDir, 'alpha', 'src', 'app.ts'), 'export const changed = true\n')
    const changed = loadEvalFixture(evalsDir, 'alpha', {
      fingerprintConfig: { model: 'model-a' },
    })
    expect(changed.fingerprint).not.toBe(modelA.fingerprint)
  })

  it('fails loud on sloppy fixture casing and package shape', () => {
    const lowerPrompt = join(evalsDir, 'lower')
    mkdirSync(lowerPrompt, { recursive: true })
    writeFileSync(join(lowerPrompt, 'prompt.md'), 'wrong case\n')

    expect(() => loadEvalFixture(evalsDir, 'lower')).toThrow(/PROMPT\.md/)

    writeFixture('commonjs', { packageJson: { type: 'commonjs' } })
    expect(() => loadEvalFixture(evalsDir, 'commonjs')).toThrow(/type": "module/)
  })

  it('supports prompt-only fixtures when validation is none', () => {
    const promptOnly = join(evalsDir, 'prompt-only')
    mkdirSync(promptOnly, { recursive: true })
    writeFileSync(join(promptOnly, 'PROMPT.md'), 'No test file yet\n')

    const fixture = loadEvalFixture(evalsDir, 'prompt-only', { validation: 'none' })
    expect(fixture.prompt).toBe('No test file yet\n')
    expect(fixture.evalPath).toBeUndefined()
    expect(fixture.packageJsonPath).toBeUndefined()
  })

  it('plans fixture campaigns before and after cached runs', async () => {
    writeFixture('alpha', { prompt: 'Fix alpha' })
    writeFixture('beta', { prompt: 'Fix beta' })

    const dispatch: DispatchFn<EvalFixtureScenario, FixtureArtifact> = async (scenario, ctx) => {
      const paid = await ctx.cost.runPaidCall({
        actor: 'fixture-agent',
        model: 'fixture-model',
        execute: async () => ({ prompt: scenario.prompt, fingerprint: scenario.fingerprint }),
        receipt: () => ({
          model: 'fixture-model',
          inputTokens: 0,
          outputTokens: 0,
          actualCostUsd: 0.01,
        }),
      })
      if (!paid.succeeded) throw paid.error
      return paid.value
    }

    const before = planEvalFixtureRun<FixtureArtifact>({
      evalsDir,
      runDir,
      dispatchRef: 'fixture-dispatch',
    })
    expect(before.totalCells).toBe(2)
    expect(before.cellsToRun).toBe(2)
    expect(before.cellsCached).toBe(0)
    expect(before.fixtures.map((fixture) => fixture.fixtureName)).toEqual(['alpha', 'beta'])

    const scenarios = loadEvalFixtureScenarios(evalsDir)
    await runCampaign({
      scenarios,
      dispatch,
      dispatchRef: 'fixture-dispatch',
      runDir,
    })

    const after = planEvalFixtureRun<FixtureArtifact>({
      evalsDir,
      runDir,
      dispatchRef: 'fixture-dispatch',
    })
    expect(after.cellsToRun).toBe(0)
    expect(after.cellsCached).toBe(2)
    expect(after.cells.every((cell) => existsSync(cell.cachePath))).toBe(true)
  })
})

function writeFixture(
  name: string,
  options: {
    prompt?: string
    packageJson?: Record<string, unknown>
  } = {},
): void {
  const dir = join(evalsDir, name)
  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(join(dir, 'PROMPT.md'), options.prompt ?? `Prompt for ${name}\n`)
  writeFileSync(join(dir, 'EVAL.ts'), "import { test } from 'vitest'\ntest('ok', () => {})\n")
  writeFileSync(
    join(dir, 'package.json'),
    `${JSON.stringify(options.packageJson ?? { type: 'module' }, null, 2)}\n`,
  )
  writeFileSync(join(dir, 'src', 'app.ts'), 'export const app = true\n')
}
