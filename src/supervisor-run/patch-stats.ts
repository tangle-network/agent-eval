/** Unified-diff target, line, and test-file touch counts. */
import type { PatchStats } from './types'

/** Unified-diff stats. Counts `+++ b/<path>` targets, body +/- lines, and test-file touches. */
export function parsePatch(text: string): PatchStats {
  const files = new Set<string>()
  const testFiles = new Set<string>()
  let added = 0
  let removed = 0
  for (const line of text.split('\n')) {
    if (line.startsWith('+++ ')) {
      const p = line.slice(4).trim().replace(/^b\//, '')
      if (p !== '/dev/null') {
        files.add(p)
        if (isTestPath(p)) testFiles.add(p)
      }
      continue
    }
    if (line.startsWith('--- ') || line.startsWith('diff --git') || line.startsWith('index ')) {
      continue
    }
    if (line.startsWith('+')) added += 1
    else if (line.startsWith('-')) removed += 1
  }
  return {
    files: files.size,
    linesAdded: added,
    linesRemoved: removed,
    testFilesTouched: [...testFiles].sort(),
  }
}

function isTestPath(p: string): boolean {
  const base = p.split('/').pop() ?? p
  return (
    /(^|\/)(tests?|__tests__|testing|spec)(\/|$)/.test(p) ||
    /\.(test|spec)\.[cm]?[jt]sx?$/.test(base) ||
    /^test_.*\.py$/.test(base) ||
    /_test\.py$/.test(base)
  )
}
