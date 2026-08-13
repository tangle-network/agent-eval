import { describe, expect, it } from 'vitest'

import {
  cellCachePath,
  inMemoryCampaignStorage,
  readCachedCell,
} from './index'

describe('public campaign cache reader', () => {
  it('reads a cache through the campaign storage contract and rejects stale identity', () => {
    const storage = inMemoryCampaignStorage()
    const runDir = '/tmp/eval-cache-reader'
    const path = cellCachePath(runDir, 'case:0')
    const cell = {
      cellId: 'case:0',
      scenarioId: 'case',
      rep: 0,
      manifestHash: 'manifest-a',
      artifact: { ok: true },
      judgeScores: {},
      costUsd: 0,
      costProvenance: { kind: 'observed', usd: 0 },
      tokenUsage: { input: 0, output: 0 },
      durationMs: 1,
      seed: 42,
      cached: false,
    }
    storage.ensureDir(runDir)
    storage.ensureDir(path.slice(0, path.lastIndexOf('/')))
    storage.write(path, JSON.stringify(cell))

    expect(readCachedCell({ storage, cachePath: path, cellId: 'case:0', manifestHash: 'manifest-a' })).toEqual({
      status: 'hit',
      cell,
    })
    expect(readCachedCell({ storage, cachePath: path, cellId: 'case:0', manifestHash: 'manifest-b' })).toEqual({
      status: 'miss',
      reason: 'manifest-mismatch',
    })
  })
})
