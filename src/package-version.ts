/**
 * Version of this package as built — the `version` field of the nearest
 * package.json above this file. Certifications cite it as the checker
 * version for in-package checkers, so a verdict names the exact code that
 * certified it; the wire server reports it as the service version.
 */

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

let cached: string | undefined

/**
 * Read the package version once and cache it. Both `src/` and the flat
 * `dist/` output sit one level below the package root, so a single `..`
 * hop finds package.json in either layout. Returns `0.0.0-unknown` when no
 * package.json is readable — an honest, greppable sentinel, never a throw:
 * version is provenance metadata, not a measurement.
 */
export function packageVersion(): string {
  if (cached) return cached
  const here = dirname(fileURLToPath(import.meta.url))
  try {
    const pkg = JSON.parse(readFileSync(resolve(here, '..', 'package.json'), 'utf-8')) as {
      version?: string
    }
    if (pkg.version) {
      cached = pkg.version
      return pkg.version
    }
  } catch {
    // fall through to the sentinel
  }
  return '0.0.0-unknown'
}
