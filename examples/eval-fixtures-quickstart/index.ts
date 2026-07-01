/**
 * Eval fixture quickstart — Vercel-style folders, campaign-grade execution.
 *
 * Run with: pnpm tsx examples/eval-fixtures-quickstart/index.ts
 */

import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  type DispatchFn,
  type EvalFixtureScenario,
  type JudgeConfig,
  loadEvalFixtureScenarios,
  planEvalFixtureRun,
  runCampaign,
} from '../../src/campaign'

interface FixtureArtifact {
  answer: string
  filesTouched: string[]
}

const here = dirname(fileURLToPath(import.meta.url))
const evalsDir = join(here, 'evals')
const runDir = join(tmpdir(), 'agent-eval-fixtures-quickstart')
const dispatchRef = 'offline-fixture-agent/v1'

const dispatch: DispatchFn<EvalFixtureScenario, FixtureArtifact> = async (scenario, ctx) => {
  ctx.cost.observe(0.001, 'offline-agent')
  ctx.cost.observeTokens({ input: scenario.prompt.length, output: 64 })
  return {
    answer: `Implemented ${scenario.fixtureName}: ${scenario.prompt.trim()}`,
    filesTouched: ['src/app.ts', 'README.md'],
  }
}

const judge: JudgeConfig<FixtureArtifact, EvalFixtureScenario> = {
  name: 'fixture-completion',
  dimensions: [
    { key: 'mentions_fixture', description: 'Artifact names the fixture it solved.' },
    { key: 'touched_files', description: 'Artifact reports changed files.' },
  ],
  score({ artifact, scenario }) {
    const mentionsFixture = artifact.answer.includes(scenario.fixtureName) ? 1 : 0
    const touchedFiles = artifact.filesTouched.length > 0 ? 1 : 0
    return {
      dimensions: {
        mentions_fixture: mentionsFixture,
        touched_files: touchedFiles,
      },
      composite: (mentionsFixture + touchedFiles) / 2,
      notes: `${scenario.fixtureName}: ${artifact.filesTouched.join(', ')}`,
    }
  },
}

async function main() {
  rmSync(runDir, { recursive: true, force: true })

  const before = planEvalFixtureRun<FixtureArtifact>({
    evalsDir,
    runDir,
    dispatchRef,
    judges: [judge],
    fingerprintConfig: { dispatchRef },
  })
  console.log(`Before: ${before.cellsToRun} to run / ${before.cellsCached} cached`)

  const scenarios = loadEvalFixtureScenarios(evalsDir, {
    fingerprintConfig: { dispatchRef },
  })
  const result = await runCampaign({
    scenarios,
    dispatch,
    dispatchRef,
    judges: [judge],
    runDir,
    expectUsage: 'assert',
  })

  const after = planEvalFixtureRun<FixtureArtifact>({
    evalsDir,
    runDir,
    dispatchRef,
    judges: [judge],
    fingerprintConfig: { dispatchRef },
  })

  console.log(`After:  ${after.cellsToRun} to run / ${after.cellsCached} cached`)
  console.log(`Mean:   ${result.aggregates.byJudge['fixture-completion']?.mean.toFixed(3)}`)
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
