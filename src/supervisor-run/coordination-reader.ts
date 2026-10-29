/**
 * Optional Runtime run-dir files, read as bytes.
 *
 * `coordination-log.jsonl` is Runtime's JSONL of `{ runId, seq, at, event }`:
 * questions, steers, answers and peer mail between nodes. The `team-shape`
 * analyst reads communication and steer edges from it.
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const COORDINATION_FILE = 'coordination-log.jsonl'
export const readFileText = (path: string): Promise<string> => readFile(path, 'utf8')

/** File text, or null when the file does not exist. Any other read error throws. */
export async function readMaybe(path: string, read = readFileText): Promise<string | null> {
  return read(path).catch((error: unknown) => {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code: unknown }).code === 'ENOENT'
    ) {
      return null
    }
    throw error
  })
}

/** The run's coordination log, or null when Runtime wrote none. */
export function readCoordinationLog(runDir: string, read = readFileText): Promise<string | null> {
  return readMaybe(join(runDir, COORDINATION_FILE), read)
}
