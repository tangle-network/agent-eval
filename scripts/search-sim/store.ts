import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type SearchCellResult } from '../../src/campaign/search-kernel'
import { type CampaignStorage, inMemoryCampaignStorage } from '../../src/campaign/storage'

/** Where a simulation keeps its ledger, blobs and executor results: a
 * directory, or process memory for the many searches of `claims`. */
export interface SimStore {
  storage: CampaignStorage | null
  has(runId: string): boolean
  read(runId: string): SearchCellResult
  write(runId: string, result: SearchCellResult): void
  log(kind: 'started' | 'finished' | 'adopted', runId: string): void
}

export function diskStore(dir: string): SimStore {
  const executorDir = join(dir, 'executor')
  mkdirSync(executorDir, { recursive: true })
  const resultPath = (runId: string): string =>
    join(executorDir, `${createHash('sha256').update(runId).digest('hex').slice(0, 24)}.json`)
  return {
    storage: null,
    has: (runId) => existsSync(resultPath(runId)),
    read: (runId) => JSON.parse(readFileSync(resultPath(runId), 'utf8')) as SearchCellResult,
    write: (runId, result) => writeFileSync(resultPath(runId), JSON.stringify(result)),
    log: (kind, runId) => appendFileSync(join(executorDir, `${kind}.log`), `${runId}\n`),
  }
}

export function memoryStore(): SimStore & { files(): Map<string, string> } {
  const results = new Map<string, SearchCellResult>()
  const inner = inMemoryCampaignStorage()
  const paths = new Set<string>()
  const storage: CampaignStorage = {
    ...inner,
    write(path, content) {
      paths.add(path)
      inner.write(path, content)
    },
    append(path, content, expectedBytes) {
      paths.add(path)
      return inner.append(path, content, expectedBytes)
    },
  }
  return {
    /** Every file the search wrote, by path: the ledger and its blobs. */
    files: () => new Map([...paths].map((path) => [path, inner.read(path) ?? ''])),
    storage,
    has: (runId) => results.has(runId),
    read: (runId) => results.get(runId)!,
    write: (runId, result) => results.set(runId, result),
    log: () => {},
  }
}
