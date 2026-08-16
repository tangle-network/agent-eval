// Frozen golden-record fixtures.
//
// A version file is written once and never edited. A behaviour change mints a
// new file and registers it here beside the old one, so the diff between two
// versions is the reviewable record of what moved and the previous contract
// stays runnable.

import type { MultishotGoldenRecordSet } from '../types'
import v1 from './v1.json'

const VERSIONS: Record<string, MultishotGoldenRecordSet> = {
  v1: v1 as MultishotGoldenRecordSet,
}

/** Version a check uses when the caller names none. */
export const CURRENT_MULTISHOT_GOLDEN_VERSION = 'v1'

export function multishotGoldenVersions(): string[] {
  return Object.keys(VERSIONS)
}

export function goldenRecords(
  version: string = CURRENT_MULTISHOT_GOLDEN_VERSION,
): MultishotGoldenRecordSet {
  const set = VERSIONS[version]
  if (!set) {
    throw new Error(
      `multishot golden: no record set for version "${version}" — known versions are ${multishotGoldenVersions().join(', ')}`,
    )
  }
  return set
}
