/**
 * An outer search whose cells are inner searches (search-tree-design §2.6 and
 * §12, `metaSearch`).
 *
 * `runNestedSearch` runs the one kernel, `runSearch`, over search
 * configurations. Each outer node is a configuration; each outer task names a
 * problem; each outer cell runs one inner search with its node's configuration
 * on its task's problem. The inner search records the cell attempt as its
 * `containment`, so its ledger names the outer execution it belongs to, and
 * the outer cell binds the inner search's head hash, which commits to its
 * whole chain.
 *
 * An outer cell scores `metaSearchScore` of its closed inner search: the held-
 * out lift the inner claim measured per known dollar, the `metaSearch` lens's
 * own score, so the outer climb optimizes exactly what the lens shows. An inner
 * search without such a score (open, no claim, `test-cannot-resolve`, a lift on
 * fewer than 2 test units, a claim its ledger contradicts) or with only a spend
 * floor settles its outer cell `errored`, not retryable, with the reason: the
 * score is unknown, not 0, and a node with such a cell cannot lead. The outer
 * cell costs what the inner search spent.
 *
 * The outer search keeps every rule of the kernel: its policy ranks
 * configurations on the selection problems, and with a test split it claims
 * once, on held-out problems, whether a configuration beats the root
 * configuration.
 */

import type {
  RunSearchOptions,
  SearchArtifactCodec,
  SearchCellResult,
  SearchCellWork,
  SearchLane,
  SearchRunResult,
} from '../campaign/search-kernel'
import { runSearch } from '../campaign/search-kernel'
import type { SearchRecorder } from '../campaign/search-ledger-recording'
import type {
  SearchAttemptAccounting,
  SearchOpenedEvent,
  SearchSplit,
  SearchTaskOutcome,
} from '../campaign/search-ledger-types'
import type { SearchStateView } from '../campaign/search-state'
import { hashCanonical } from '../ledger-core/canonical'
import { META_SEARCH_SCORE_SOURCE, metaSearchScore } from './lenses/meta-search'

/** The outer cell attempt an inner search runs as. */
export type NestedSearchContainment = NonNullable<SearchOpenedEvent['containment']>

/** One inner search to run: a configuration on one outer task. */
export interface NestedSearchRunInput<TConfig> {
  config: TConfig
  /** Record this as the inner search's `containment`. */
  containment: NestedSearchContainment
  /** The inner search's id, a digest of `containment`: rerunning the same
   * attempt opens the same ledger, so an inner search resumes rather than
   * starting again. */
  searchId: string
  task: { taskId: string; unitId: string; split: SearchSplit; rep: number }
  signal: AbortSignal
}

export interface RunNestedSearchOptions<TConfig>
  extends Omit<RunSearchOptions<TConfig>, 'codec' | 'executor'> {
  /** How configurations are stored as nodes. Default `searchConfigCodec()`,
   * for plain JSON configurations. */
  codec?: SearchArtifactCodec<TConfig>
  /** How many inner searches run at once, and what one is expected to cost:
   * `cellUsd` is the admission rule's prior for one inner search. */
  lane: SearchLane
  /** Run the inner search for one outer cell attempt to its close, recording
   * `containment` in its header, and return its closed state. */
  runInner(input: NestedSearchRunInput<TConfig>): Promise<SearchStateView>
  /** The closed inner search of an attempt an earlier outer process started,
   * or null to run it through `runInner`. Default null. */
  adoptInner?(input: NestedSearchRunInput<TConfig>): Promise<SearchStateView | null>
}

/** The deterministic id of the inner search one outer cell attempt runs. */
export function nestedSearchId(containment: NestedSearchContainment): string {
  const { searchId, cellId, attempt } = containment
  return `nested_${hashCanonical({ searchId, cellId, attempt }).slice('sha256:'.length, 'sha256:'.length + 32)}`
}

/**
 * The codec for a plain JSON configuration: the node is the configuration's
 * canonical JSON, and the diff names each top-level key whose value changed.
 */
export function searchConfigCodec<TConfig>(): SearchArtifactCodec<TConfig> {
  return {
    node: (recorder, config) => {
      const artifact = recorder.blob('search-config', config)
      return {
        artifactDigest: hashCanonical(config),
        artifact,
        surfaces: [{ surfaceId: 'search-config', kind: 'runtime-config', artifact }],
      }
    },
    diff: (recorder, parent, child) => {
      const before = asRecord(parent)
      const after = asRecord(child)
      const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()
      const changes = keys
        .filter((key) => hashCanonical(before[key] ?? null) !== hashCanonical(after[key] ?? null))
        .map((key) => ({ key, from: before[key] ?? null, to: after[key] ?? null }))
      return recorder.blob('diff', { kind: 'search-config-diff', changes })
    },
    load: (recorder, node) => recorder.readBlob(node.artifact) as TConfig,
  }
}

/**
 * Run an outer search over search configurations to its close, or continue
 * one from its ledger. The outer search must maximize (its score is lift per
 * dollar), its nodes must be `runtime-config` artifacts, and its judge must be
 * `META_SEARCH_SCORE_SOURCE`.
 */
export async function runNestedSearch<TConfig>(
  options: RunNestedSearchOptions<TConfig>,
): Promise<SearchRunResult> {
  const { recorder, lane, runInner, adoptInner } = options
  const header = (await recorder.state()).header
  if (!header) throw new Error(`runNestedSearch: search ${recorder.searchId} has not been opened`)
  if (header.objective.direction !== 'maximize') {
    throw new Error(
      'runNestedSearch: an outer search scores held-out lift per dollar, so its objective must maximize',
    )
  }
  if (header.artifactKind !== 'runtime-config') {
    throw new Error(
      `runNestedSearch: an outer search's nodes are configurations (runtime-config), not ${header.artifactKind}`,
    )
  }
  // The cells are scored by metaSearchScore, so the header must name it as the
  // judge: a ledger that declared another judge would misstate its own scores.
  const judge = header.objective.judge
  if (
    !('uri' in judge) ||
    judge.uri !== META_SEARCH_SCORE_SOURCE.uri ||
    judge.revision !== META_SEARCH_SCORE_SOURCE.revision
  ) {
    throw new Error(
      `runNestedSearch: an outer search's judge must be META_SEARCH_SCORE_SOURCE (${META_SEARCH_SCORE_SOURCE.uri}@${META_SEARCH_SCORE_SOURCE.revision}), which scores its cells`,
    )
  }
  const input = (work: SearchCellWork<TConfig>): NestedSearchRunInput<TConfig> => {
    const containment = { searchId: work.searchId, cellId: work.cellId, attempt: work.attempt }
    return {
      config: work.artifact,
      containment,
      searchId: nestedSearchId(containment),
      task: { taskId: work.taskId, unitId: work.unitId, split: work.split, rep: work.rep },
      signal: work.signal,
    }
  }
  return runSearch({
    ...options,
    codec: options.codec ?? searchConfigCodec<TConfig>(),
    executor: {
      lanes: () => [lane],
      place: () => lane.name,
      async adopt(work) {
        if (!adoptInner) return null
        const request = input(work)
        const inner = await adoptInner(request)
        return inner ? outerResult(recorder, request, inner, work.lane, null) : null
      },
      async run(work) {
        const request = input(work)
        const startedAt = Date.now()
        const inner = await runInner(request)
        return outerResult(recorder, request, inner, work.lane, Date.now() - startedAt)
      },
    },
  })
}

/** The outer cell's result from its closed inner search. */
function outerResult<TConfig>(
  recorder: SearchRecorder,
  request: NestedSearchRunInput<TConfig>,
  inner: SearchStateView,
  lane: string,
  wallMs: number | null,
): SearchCellResult {
  const header = inner.header
  const expected = request.containment
  const recorded = header?.containment ?? null
  if (
    !header ||
    recorded === null ||
    recorded.searchId !== expected.searchId ||
    recorded.cellId !== expected.cellId ||
    recorded.attempt !== expected.attempt
  ) {
    throw new Error(
      `runNestedSearch: inner search ${inner.searchId} does not record outer cell ${expected.cellId} attempt ${expected.attempt} of ${expected.searchId} as its containment`,
    )
  }
  if (!inner.closed) {
    throw new Error(
      `runNestedSearch: inner search ${inner.searchId} is open; runInner must return it closed`,
    )
  }
  const score = metaSearchScore(inner)
  const { spend, tokens } = inner.audit
  const metrics: Record<string, number> = {
    knownUsd: spend.knownUsd,
    floorUsd: spend.floorUsd,
    nodes: inner.audit.nodes,
    cells: inner.audit.cells.settled,
  }
  if (score.status === 'scored') {
    metrics.lift = score.lift
    metrics.testUnits = score.estimate.pairs
  }
  const perUsd = score.status === 'scored' ? score.liftPerUsd : null
  const outcome: SearchTaskOutcome =
    perUsd?.status === 'known'
      ? { status: 'passed', score: perUsd.value, metrics }
      : {
          status: 'errored',
          metrics,
          error: {
            ...(score.status === 'unscored'
              ? { code: `inner-${score.reason}`, message: score.detail }
              : { code: `inner-cost-${perUsd!.status}`, message: perUsd!.reason }),
            retryable: false,
          },
        }
  const unknownCost = spend.unknownCostCells + spend.unknownCostOperations
  const accounting: SearchAttemptAccounting = {
    tokens:
      tokens.unknownTokenAttempts > 0
        ? {
            status: 'unknown',
            reason: `${tokens.unknownTokenAttempts} attempt(s) of inner search ${inner.searchId} recorded no token usage`,
          }
        : {
            status: 'known',
            inputTokens: tokens.inputTokens,
            outputTokens: tokens.outputTokens,
            cachedTokens: tokens.cachedTokens,
          },
    // The sum of the inner search's recorded costs, each already priced by the
    // inner ledger's own accounting.
    cost:
      unknownCost > 0
        ? {
            status: 'unknown',
            knownLowerBoundUsd: spend.committedUsd,
            reason: `${unknownCost} cost(s) of inner search ${inner.searchId} are known only as a floor`,
          }
        : { status: 'known', usd: spend.knownUsd, source: 'pricing-table' },
  }
  const nested = recorder.blob('nested-search', {
    kind: 'nested-search',
    searchId: inner.searchId,
    containment: expected,
    head: inner.head,
    score,
  })
  return {
    outcome,
    accounting,
    identity: header.identity,
    wallMs,
    placement: { lane, boxId: null },
    traceRef: {
      unknown: `the cell ran inner search ${inner.searchId}; its ledger records the execution`,
    },
    artifacts: [nested],
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : { value }
}
