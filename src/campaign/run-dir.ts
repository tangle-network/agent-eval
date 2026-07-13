import { homedir } from 'node:os'
import { basename, isAbsolute, join } from 'node:path'

/** The shared, out-of-repo root for campaign/benchmark run bundles. Keeping run
 *  outputs here means they never land in a repo working tree (no per-repo
 *  gitignore, no clutter, no accidental commits). Layout:
 *    ~/.tangle/traces/<repo>/runs/<runName>/
 *  where <repo> disambiguates runs across repos in one place. */
export function tangleTracesRoot(): string {
  return join(homedir(), '.tangle', 'traces')
}

/** Resolve a campaign `runDir`. An absolute path is honored as-is (the caller
 *  chose an explicit location). A bare name is placed under the shared home root
 *  so bundles never pollute a repo working tree — the default the harness should
 *  compute so callers pass a *name*, not a path. */
export function resolveRunDir(runDir: string, repo?: string): string {
  if (isAbsolute(runDir) || runDir.startsWith('mem://')) return runDir
  const r = repo && repo.trim().length > 0 ? repo : basename(process.cwd())
  return join(tangleTracesRoot(), r, 'runs', runDir)
}
