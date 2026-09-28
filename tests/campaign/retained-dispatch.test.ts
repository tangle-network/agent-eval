import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

it('retains real external effects across contention, SIGKILL, replay and scope changes', () => {
  const script = fileURLToPath(new URL('../../scripts/prove-retained-dispatch.ts', import.meta.url))
  const output = execFileSync(process.execPath, ['--import', 'tsx', script], {
    encoding: 'utf8',
    timeout: 60000,
  })
  const report = JSON.parse(output)
  expect(report.passed).toBe(true)
  expect(report.checks).toHaveLength(9)
  expect(report.modelCalls).toBe(0)
}, 65000)
