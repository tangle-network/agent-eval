import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const workflow = readFileSync(
  resolve(process.cwd(), '.github/workflows/official-optimizer-benchmark.yml'),
  'utf8',
)
const benchmark = readFileSync(
  resolve(process.cwd(), 'examples/compare-optimization-methods/index.ts'),
  'utf8',
)
type WorkflowStep = {
  name?: string
  uses?: string
  run?: string
  if?: string
  env?: Record<string, string>
  with?: Record<string, string>
}
const document = parse(workflow) as {
  on: { workflow_dispatch: { inputs: Record<string, unknown> } }
  permissions: { contents: string }
  concurrency: { group: string; 'cancel-in-progress': boolean }
  jobs: { benchmark: { steps: WorkflowStep[] } }
}
const steps = document.jobs.benchmark.steps
const stepNamed = (name: string) => {
  const step = steps.find((candidate) => candidate.name === name)
  if (!step) throw new Error(`Missing workflow step: ${name}`)
  return step
}

describe('official optimizer benchmark workflow', () => {
  it('installs and runs both pinned upstream optimizers', () => {
    expect(stepNamed('Install pinned official optimizers').run).toBe(
      'uv sync --frozen --group skillopt-source --group gepa-source',
    )
    const compare = stepNamed('Compare official GEPA and SkillOpt')
    expect(compare.run).toBe('pnpm tsx examples/compare-optimization-methods/index.ts')
    expect(compare.env?.OPTIMIZERS).toContain('gepa,skillopt')
    expect(compare.env?.OPTIMIZER_PYTHON).toContain('/clients/python/.venv/bin/python')
  })

  it('uses the controls read by the current benchmark', () => {
    const compareEnv = stepNamed('Compare official GEPA and SkillOpt').env ?? {}
    for (const name of [
      'SKILLOPT_EPOCHS',
      'SKILLOPT_BATCH_SIZE',
      'MAX_OPTIMIZER_MODEL_COST_USD',
      'MAX_TOTAL_COST_USD',
    ]) {
      expect(compareEnv).toHaveProperty(name)
      expect(benchmark).toContain(`'${name}'`)
    }
    for (const staleName of ['POPULATION', 'GENERATIONS', 'EPOCHS']) {
      expect(compareEnv).not.toHaveProperty(staleName)
    }
  })

  it('requires reproducible model and price metadata before paid work', () => {
    const config = stepNamed('Check benchmark configuration')
    expect(config.run).toContain('[ -z "$MODEL" ]')
    expect(config.run).toContain('[ -z "$PRICE_IN" ]')
    expect(config.run).toContain('[ -z "$PRICE_OUT" ]')
    const upload = stepNamed('Upload method comparison artifact')
    expect(upload.if).toBe("always() && steps.config.outputs.run == 'true'")
    expect(upload.with?.['if-no-files-found']).toBe('error')
    expect(Object.keys(document.on.workflow_dispatch.inputs)).toEqual(
      expect.arrayContaining(['model', 'price_in_per_m', 'price_out_per_m']),
    )
  })

  it('serializes paid runs with read-only repository access', () => {
    expect(document.permissions).toEqual({ contents: 'read' })
    expect(document.concurrency).toEqual({
      group: 'official-optimizer-benchmark',
      'cancel-in-progress': false,
    })
  })
})
