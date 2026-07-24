import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const workflow = readFileSync(
  resolve(process.cwd(), '.github/workflows/official-optimizer-benchmark.yml'),
  'utf8',
)
const benchmark = readFileSync(
  resolve(process.cwd(), 'examples/compare-optimization-methods/index.ts'),
  'utf8',
)

describe('official optimizer benchmark workflow', () => {
  it('installs and runs both pinned upstream optimizers', () => {
    expect(workflow).toContain('uv sync --frozen --group skillopt-source --group gepa-source')
    expect(workflow).toContain('github.event.inputs.optimizers')
    expect(workflow).toContain("'gepa,skillopt'")
    expect(workflow).toContain('github.workspace')
    expect(workflow).toContain('/clients/python/.venv/bin/python')
    expect(workflow).toContain('pnpm tsx examples/compare-optimization-methods/index.ts')
  })

  it('uses the controls read by the current benchmark', () => {
    for (const name of [
      'SKILLOPT_EPOCHS',
      'SKILLOPT_BATCH_SIZE',
      'MAX_OPTIMIZER_MODEL_COST_USD',
      'MAX_TOTAL_COST_USD',
    ]) {
      expect(workflow).toContain(`${name}:`)
      expect(benchmark).toContain(`'${name}'`)
    }
    for (const staleName of ['POPULATION', 'GENERATIONS', 'EPOCHS']) {
      expect(workflow).not.toMatch(new RegExp(`^\\s+${staleName}:`, 'm'))
    }
  })

  it('requires reproducible model and price metadata before paid work', () => {
    expect(workflow).toContain('[ -z "$MODEL" ]')
    expect(workflow).toContain('[ -z "$PRICE_IN" ]')
    expect(workflow).toContain('[ -z "$PRICE_OUT" ]')
    expect(workflow).toContain('if-no-files-found: error')
  })
})
