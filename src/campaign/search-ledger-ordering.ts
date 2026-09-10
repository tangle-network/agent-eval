import { canonicalString } from '../ledger-core'
import type { SearchArtifactRef } from './search-ledger-types'

export function artifactKey(artifact: SearchArtifactRef): string {
  return canonicalString(artifact)
}

export function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}
