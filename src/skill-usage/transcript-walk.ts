/** Finding the session files under a harness's store: one walk, shared by every reader. */

import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { errorMessage } from '../errors'

export interface TranscriptWalk {
  files: string[]
  unreadable: Array<{ source: string; error: string }>
}

export async function walkTranscripts(
  directory: string,
  walk: TranscriptWalk,
  wanted: (name: string) => boolean = (name) => name.endsWith('.jsonl'),
): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true })
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      try {
        await walkTranscripts(path, walk, wanted)
      } catch (error) {
        walk.unreadable.push({ source: path, error: errorMessage(error) })
      }
    } else if ((entry.isFile() || entry.isSymbolicLink()) && wanted(entry.name)) {
      // A link is read through; one that points nowhere is a failed read, not a skipped file.
      walk.files.push(path)
    }
  }
}
