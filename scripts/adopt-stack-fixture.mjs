import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, relative } from 'node:path'

/** Commit identity belongs to disposable repositories, never the runner or source checkout. */
export function fixtureGit(cwd, ...args) {
  const path = relative(realpathSync(tmpdir()), realpathSync(cwd))
  if (!path || path === '..' || path.startsWith('../') || path.startsWith('..\\') || isAbsolute(path)) {
    throw new Error('fixture Git requires a disposable directory beneath the temporary root')
  }
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Adoption integration',
      GIT_AUTHOR_EMAIL: 'adoption-integration@example.invalid',
      GIT_COMMITTER_NAME: 'Adoption integration',
      GIT_COMMITTER_EMAIL: 'adoption-integration@example.invalid',
    },
  }).trim()
}
