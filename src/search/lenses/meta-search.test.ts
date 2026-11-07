import { describe, expect, it } from 'vitest'
import { openSearchLedger } from '../../campaign/search-ledger'
import { SearchRecorder } from '../../campaign/search-ledger-recording'
import type { SearchOpenedEvent } from '../../campaign/search-ledger-types'
import type { SearchStateView } from '../../campaign/search-state'
import { inMemoryCampaignStorage } from '../../campaign/storage'
import { hashCanonical } from '../../ledger-core/canonical'
import { metaSearch, objectiveKey } from './meta-search'

const SOURCE = { uri: 'test:objective-key', revision: hashCanonical('objective-key') }

function opening(
  judge: SearchOpenedEvent['objective']['judge'],
): Parameters<typeof SearchRecorder.open>[1] {
  return {
    subject: 'vb/coder',
    process: { name: 'objective-key', executionRef: SOURCE },
    artifactKind: 'prompt',
    objective: {
      metric: 'score',
      direction: 'maximize',
      judge,
      claim: {
        population: { id: 'objective-key', description: 'one unit' },
        samplingFrame: 'the unit',
        independentUnit: 'id',
        generalization: 'new-units',
        use: 'comparison',
        minimumEffect: 0.2,
      },
    },
    splits: {
      train: [],
      selection: [],
      test: [],
      heldOutUnits: true,
    },
    policy: { expansion: 'incumbent', allocation: 'uniform', seed: 1 },
    budget: {
      maxUsd: null,
      maxCells: null,
      maxNodes: 1,
      deadline: null,
      maxConcurrency: null,
      reservedClaimUsd: 0,
    },
    containment: null,
    derivedFrom: null,
    identity: {
      model: { provider: 'test', alias: 'test', unknown: 'no model' },
      agent: SOURCE,
      benchmark: { uri: 'test://tasks', revision: SOURCE.revision },
    },
  }
}

async function opened(
  id: string,
  judge: SearchOpenedEvent['objective']['judge'],
): Promise<SearchStateView> {
  const storage = inMemoryCampaignStorage()
  const recorder = await SearchRecorder.open(
    {
      ledger: openSearchLedger({ path: `/search/${id}.jsonl`, searchId: id, store: storage }),
      storage,
    },
    opening(judge),
  )
  return recorder.state()
}

describe('objectiveKey names the judge revision (#1995)', () => {
  it('a check that gained a floor is a different objective', async () => {
    const before = await opened('before', {
      uri: 'test:judge',
      revision: hashCanonical({ floor: null }),
    })
    const after = await opened('after', {
      uri: 'test:judge',
      revision: hashCanonical({ floor: 0 }),
    })
    const unknown = await opened('unknown', { unknown: 'the check has no revision' })
    const beforeKey = objectiveKey(before.header!)
    const afterKey = objectiveKey(after.header!)
    expect(beforeKey).not.toBe(afterKey)
    expect(beforeKey).toBe(`vb/coder · score (maximize) · ${hashCanonical({ floor: null })}`)
    expect(afterKey).toBe(`vb/coder · score (maximize) · ${hashCanonical({ floor: 0 })}`)
    expect(objectiveKey(unknown.header!)).toBe(
      'vb/coder · score (maximize) · the check has no revision',
    )
    const unknownKey = objectiveKey(unknown.header!)
    const compared = metaSearch([before, after, unknown])
    expect(compared.data.objectives).toHaveLength(3)
    expect(new Set(compared.data.objectives)).toEqual(new Set([beforeKey, afterKey, unknownKey]))
  })
})
