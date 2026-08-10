import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const SCRIPT = fileURLToPath(new URL('./certify-task-oracle.sh', import.meta.url))

function run(args) {
  try {
    return {
      status: 0,
      stdout: execFileSync('bash', [SCRIPT, ...args], { encoding: 'utf8', stdio: 'pipe' }),
      stderr: '',
    }
  } catch (error) {
    return {
      status: error.status ?? 1,
      stdout: String(error.stdout ?? ''),
      stderr: String(error.stderr ?? ''),
    }
  }
}

describe('certify-task-oracle.sh', () => {
  it('agrees with the flip-rate and verdict tables it ships with', () => {
    const result = run(['--self-test'])
    expect(result.stderr).toBe('')
    expect(result.stdout.trim()).toBe('self-test OK')
    expect(result.status).toBe(0)
  })

  it('refuses a replicate count that cannot show a flip', () => {
    const result = run(['--determinism', '1', 'any-task'])
    expect(result.status).toBe(2)
    expect(result.stderr).toMatch(/measures no flip/)
  })

  it('refuses a non-numeric replicate count instead of grading zero times', () => {
    expect(run(['--determinism', 'lots', 'any-task']).status).toBe(2)
    expect(run(['--determinism-load', '-1', 'any-task']).status).toBe(2)
  })

  it('names phase C and its skip verdict in its own help', () => {
    const help = run(['--help']).stdout
    expect(help).toMatch(/--determinism N/)
    expect(help).toMatch(/CERTIFIED_UNCHECKED_DETERMINISM/)
  })
})
