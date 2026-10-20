import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { TestSuiteFile } from '../src/trace-repair'

/** Read the suite in filesystem traversal order using Harbor's container paths. */
export function readTerminalBenchTestSuite(dir: string): TestSuiteFile[] {
  const files: TestSuiteFile[] = []
  const walk = (rel: string): void => {
    for (const entry of readdirSync(join(dir, rel))) {
      const relPath = rel ? `${rel}/${entry}` : entry
      if (statSync(join(dir, relPath)).isDirectory()) walk(relPath)
      else files.push({ path: `/tests/${relPath}`, contents: readFileSync(join(dir, relPath), 'utf8') })
    }
  }
  walk('')
  return files
}
