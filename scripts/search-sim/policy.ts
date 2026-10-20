import { asha, type SearchAllocator, uniform } from '../../src/campaign/allocation'
import { type SearchSourceRef, type SearchUnknown } from '../../src/campaign/search-ledger-types'
import { aide, beam, crowdedFrontierParent, incumbent, type SearchPolicy } from '../../src/campaign/search-policy'
import { hashCanonical } from '../../src/ledger-core/canonical'
import { draftOnPlateau } from '../../src/search/lenses/plateau'
import { nextUnitExtension } from '../../src/search/lenses/skill-manifold'
import { type SimOptions } from './types'

export const SEARCH_ID = 'search-sim'

export const SIM_SOURCE: SearchSourceRef = {
  uri: 'script:scripts/search-sim.ts',
  revision: hashCanonical({ simulator: 'search-sim', version: 2 }),
}

export const PROPOSAL_USD = 0.002

export function benchmark(options: SimOptions): SearchSourceRef {
  const { seed, train, selection, test } = options
  return { uri: 'sim://tasks', revision: hashCanonical({ seed, train, selection, test }) }
}

export function judge(options: SimOptions): SearchSourceRef | SearchUnknown {
  if (options.judgeRevision === null)
    return { unknown: 'the judge is not pinned (--judge-revision none)' }
  return {
    uri: 'script:scripts/search-sim.ts#judge',
    revision: hashCanonical({ judge: 'sim-score', version: options.judgeRevision }),
  }
}

export const MAX_ATTEMPTS = 3

export function allocationOf(options: SimOptions): SearchAllocator {
  if (options.allocation === 'asha-adaptive') {
    if (options.calibration === null) throw new Error('asha-adaptive needs --calibration FILE')
    return asha({ reps: options.reps, extend: nextUnitExtension(options.calibration) })
  }
  return options.allocation === 'asha'
    ? asha({ reps: options.reps })
    : uniform({ reps: options.reps })
}

export function policyOf(options: SimOptions): SearchPolicy {
  if (options.policy === 'crowded-frontier') return crowdedFrontierParent({ seed: options.seed })
  if (options.policy === 'aide') return aide()
  if (options.policy === 'beam') return beam({ width: options.beamWidth })
  const base = incumbent({
    ...(options.patience === undefined ? {} : { patience: options.patience }),
    ...(options.minImprovement === undefined ? {} : { minImprovement: options.minImprovement }),
  })
  return options.policy === 'draft-on-plateau' ? draftOnPlateau(base) : base
}
