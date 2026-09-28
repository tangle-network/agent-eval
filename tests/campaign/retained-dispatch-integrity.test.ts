import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

it('refuses journal loss and changed receipt interpretation across process restarts', () => {
  const script = fileURLToPath(new URL('../../scripts/prove-retained-dispatch-integrity.ts', import.meta.url))
  const output = execFileSync(process.execPath, ['--import', 'tsx', script], {
    encoding: 'utf8', timeout: 60000, maxBuffer: 4 * 1024 * 1024,
  })
  const report = JSON.parse(output)
  expect(report.passed).toBe(true)
  expect(report.checks).toHaveLength(8)
  expect(report.modelCalls).toBe(0)
}, 65000)
