import type {
  SearchModelIdentity,
  SearchProposerKind,
  SearchSourceRef,
} from '../../campaign/search-ledger-types'
import type { SearchStateView } from '../../campaign/search-state'
import { compareCodeUnits, hashCanonical } from '../../ledger-core/canonical'
import type { SearchPolicyGenome } from './meta-search-contract'

/**
 * The genome of a search: the configuration its ledger records. Declared
 * parts come from the header; the proposer comes from what the edges and
 * candidate-generation operations name, because the header declares none.
 */
export function searchPolicyGenome(state: SearchStateView): SearchPolicyGenome {
  const header = state.header
  if (!header) throw new Error(`search ${state.searchId} has not been opened`)
  const { maxUsd, maxCells, maxNodes, maxConcurrency, reservedClaimUsd } = header.budget
  const proposers = new Map<
    string,
    { kind: SearchProposerKind; name: string; source: SearchSourceRef }
  >()
  const operations = new Set<string>()
  for (const edge of state.edges()) {
    if (!edge.proposer) continue
    const { kind, name, source, operationId } = edge.proposer
    const proposer = { kind, name, source }
    proposers.set(hashCanonical(proposer), proposer)
    if (operationId !== null) operations.add(operationId)
  }
  const executions = new Map<
    string,
    | { kind: 'model'; model: SearchModelIdentity }
    | { kind: 'deterministic'; source: SearchSourceRef }
  >()
  for (const operationId of operations) {
    const execution = state.operation(operationId)?.execution
    if (!execution) continue
    const entry =
      execution.kind === 'model'
        ? { kind: 'model' as const, model: execution.model }
        : { kind: 'deterministic' as const, source: execution.source }
    executions.set(hashCanonical(entry), entry)
  }
  return {
    expansion: withoutSearchSeed(header.policy.expansion, header.policy.seed),
    allocation: withoutSearchSeed(header.policy.allocation, header.policy.seed),
    budget: { maxUsd, maxCells, maxNodes, maxConcurrency, reservedClaimUsd },
    proposers:
      proposers.size > 0
        ? sortedValues(proposers)
        : { unknown: 'the search recorded no proposal, so its proposer is not in the ledger' },
    proposerExecution:
      executions.size > 0
        ? sortedValues(executions)
        : { unknown: 'no recorded candidate-generation operation names what ran the proposer' },
  }
}

// ── helpers ──────────────────────────────────────────────────────────

/** A policy or allocator name carries `seed=<n>` when it is seeded from the
 * search's own seed; the genome names it `seed=<search>` so searches of one
 * configuration on different seeds share a genome. */
function withoutSearchSeed(name: string, seed: number): string {
  return name.replace(new RegExp(`\\bseed=${seed}(?![\\d.])`, 'g'), 'seed=<search>')
}

function sortedValues<T>(map: ReadonlyMap<string, T>): T[] {
  return [...map.entries()]
    .sort(([left], [right]) => compareCodeUnits(left, right))
    .map(([, value]) => value)
}
