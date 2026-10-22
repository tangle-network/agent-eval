/**
 * Runtime supervisor-run reader and report writers.
 *
 * Runtime's file-backed supervision context is the only live on-disk contract.
 * Other stores implement `SupervisorRunReader` and feed the same pure analyzer;
 * this module owns path discovery and report output for Runtime runs.
 */

import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { analyzeSupervisorRunSources } from './analyze'

import { isRuntimeSupervisorRunDir, readRuntimeSupervisorRun } from './runtime-reader'
import type { SupervisorRunReader, SupervisorRunReport, SupervisorRunSources } from './types'

/**
 * Analyze a supervisor run. Accepts a Runtime run directory, any
 * `SupervisorRunReader`, or already-read source bytes — so a
 * caller with its own store never has to touch the filesystem layout.
 */
export async function analyzeSupervisorRun(
  input: string | SupervisorRunReader | SupervisorRunSources,
): Promise<SupervisorRunReport> {
  if (typeof input === 'string') {
    return analyzeSupervisorRunSources(await readRuntimeSupervisorRun(input))
  }
  if (isReader(input)) return analyzeSupervisorRunSources(await input.read())
  return analyzeSupervisorRunSources(input)
}

function isReader(input: SupervisorRunReader | SupervisorRunSources): input is SupervisorRunReader {
  return typeof (input as SupervisorRunReader).read === 'function'
}

export interface WriteSupervisorRunOptions {
  /** Append the headline block here (the experiment's run log). */
  readonly appendHeadlineTo?: string
  /** Also console.log the headline (default true). */
  readonly echo?: boolean
  /**
   * Write `run-report.{json,md}` here instead of into the run dir. Set when
   * reporting over a run directory that must stay READ-ONLY (a live run, an
   * archived generation).
   */
  readonly reportDir?: string
}







/**
 * Every Runtime supervisor run below `root`.
 *
 * When `root` itself is one run, return no children so callers can distinguish
 * a single report from a parent-directory rollup.
 */
export async function findSupervisorRunDirs(root: string): Promise<string[]> {
  if (await isRuntimeSupervisorRunDir(root)) {
    return []
  }
  const found: string[] = []
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 8) return
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const e of entries) {
      if (!e.isDirectory()) continue
      if (e.name === 'node_modules' || e.name === '.git') continue
      const full = join(dir, e.name)
      if (await isRuntimeSupervisorRunDir(full)) {
        found.push(full)
        continue
      }
      await walk(full, depth + 1)
    }
  }
  await walk(root, 0)
  return found.sort()
}
