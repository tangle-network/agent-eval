/**
 * Build gates for one submission workdir: install, typecheck, production build,
 * and the contestant's own tests. Run once per submission; every grading run
 * serves the build this step produced.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { EngineeringGates } from './verdict'

function run(workdir: string, command: string, args: string[], timeoutMs: number) {
  const started = Date.now()
  const result = spawnSync(command, args, {
    cwd: workdir,
    encoding: 'utf8',
    timeout: timeoutMs,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      CI: '1',
      NEXT_TELEMETRY_DISABLED: '1',
    },
  })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  return {
    command: [command, ...args].join(' '),
    exit: result.status,
    ms: Date.now() - started,
    tail: output.slice(-2_500),
  }
}

export function prepare(workdir: string) {
  const steps: Record<string, ReturnType<typeof run> | { skipped: string }> = {}
  if (!existsSync(join(workdir, 'node_modules', '.bin', 'next'))) {
    steps.install = run(workdir, 'npm', ['install', '--no-audit', '--no-fund'], 600_000)
  } else {
    steps.install = { skipped: 'node_modules present from the materialize step' }
  }
  // Build before the typecheck: `next build` rewrites tsconfig.json, and a contestant's
  // pulled workdir already carries those rewrites from its own builds. A replayed trace
  // only has its Write/Edit calls, so building first restores the same tsconfig.
  steps.build = run(workdir, 'npm', ['run', 'build'], 600_000)
  steps.typecheck = run(workdir, 'npx', ['tsc', '--noEmit', '-p', '.'], 300_000)
  const pkg = JSON.parse(readFileSync(join(workdir, 'package.json'), 'utf8')) as {
    scripts?: Record<string, string>
  }
  const testScript = pkg.scripts?.test
  steps.tests =
    testScript && !/no test specified/.test(testScript)
      ? run(workdir, 'npm', ['test'], 300_000)
      : { skipped: 'no test script' }
  const exit = (key: string) => ('exit' in steps[key]! ? steps[key]!.exit : 0)
  const gates: EngineeringGates = {
    install: existsSync(join(workdir, 'node_modules', '.bin', 'next')),
    typecheck: exit('typecheck') === 0,
    build: exit('build') === 0 && existsSync(join(workdir, '.next', 'BUILD_ID')),
    tests: 'skipped' in steps.tests! ? 'absent' : exit('tests') === 0 ? 'pass' : 'fail',
  }
  return { gates, steps }
}
