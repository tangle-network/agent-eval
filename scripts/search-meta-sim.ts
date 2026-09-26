/**
 * An outer search whose cells are inner searches, on the simulator: the real
 * kernel, ledger, claim and `metaSearch` lens, with no model spend.
 *
 *   node --import tsx scripts/search-meta-sim.ts --out DIR [options]
 *
 * The outer search's nodes are inner search configurations: an expansion
 * policy, an allocator, a population and a number of expansions. Its tasks
 * are problems: selection problem `p<i>` is simulator seed `--problem-seed + i`
 * and test problem `x<i>` is seed `--problem-seed + 1000 + i`, so no test
 * problem is ever a selection problem. `runNestedSearch` runs each outer cell
 * as one `search-sim` search of the node's configuration on the task's
 * problem, in memory; the inner ledger records the outer cell attempt as its
 * containment and is written to DIR/inner/<searchId>.jsonl when it closes.
 * The outer ledger is DIR/outer/ledger.jsonl. An outer cell scores the inner
 * search's held-out lift per known dollar (`metaSearchScore`), the lens's own
 * number, and costs what the inner search spent.
 *
 * The outer proposer is a fixed grid: its one proposal from the root returns
 * the other configurations. Allocation is uniform, so every configuration runs
 * every selection problem. With test problems, the outer search claims once,
 * on held-out problems, whether a configuration beats the root configuration.
 *
 * Every inner search audits its own ledger (`search-sim`'s allocator replay);
 * a failed audit stops the run. Output is one JSON document on stdout, and the
 * lens over every ledger is written to DIR/meta-search.json.
 *
 * Options: --out DIR (required), --seed N (1, the outer policy seed),
 * --selection-problems N (6), --test-problems N (20), --problem-seed N (1000),
 * --capacity N (2, inner searches at once), --min-effect X (0.005, the outer
 * claim's minimum effect in lift per dollar), --inner-selection N (12),
 * --inner-test N (20), --inner-min-effect X (0.1), --grid JSON (the configurations
 * the outer proposer returns, each a partial configuration over the root:
 * default crowded-frontier, asha, and population 2 with expansions 2).
 */

import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { uniform } from '../src/campaign/allocation'
import { searchClaimReserveUsd } from '../src/campaign/search-claim'
import type { SearchProposerPort } from '../src/campaign/search-kernel'
import { openSearchLedger, replaySearchLedgerText } from '../src/campaign/search-ledger'
import { developmentClaim, SearchRecorder } from '../src/campaign/search-ledger-recording'
import type { SearchSourceRef, SearchTask } from '../src/campaign/search-ledger-types'
import { incumbent } from '../src/campaign/search-policy'
import type { SearchStateView } from '../src/campaign/search-state'
import { renderSearchSummary } from '../src/campaign/search-summary'
import { hashCanonical } from '../src/ledger-core/canonical'
import {
  META_SEARCH_SCORE_SOURCE,
  metaSearch,
  objectiveKey,
  renderMetaSearchText,
} from '../src/search/lenses/meta-search'
import { runNestedSearch } from '../src/search/nested-search'
import { memoryStore, runSimulation, type SimOptions } from './search-sim'

/** One inner search configuration: the outer search's artifact. */
interface InnerConfig {
  policy: 'incumbent' | 'crowded-frontier'
  allocation: 'uniform' | 'asha'
  population: number
  expansions: number
}

const ROOT_CONFIG: InnerConfig = {
  policy: 'incumbent',
  allocation: 'uniform',
  population: 3,
  expansions: 4,
}

/** The other configurations, each one change from the root. */
const DEFAULT_GRID: InnerConfig[] = [
  { ...ROOT_CONFIG, policy: 'crowded-frontier' },
  { ...ROOT_CONFIG, allocation: 'asha' },
  { ...ROOT_CONFIG, population: 2, expansions: 2 },
]

/** The script as the outer proposer and process: its revision covers the
 * grid it proposes. */
function metaSimSource(grid: readonly InnerConfig[]): SearchSourceRef {
  return {
    uri: 'script:scripts/search-meta-sim.ts',
    revision: hashCanonical({ simulator: 'search-meta-sim', version: 1, root: ROOT_CONFIG, grid }),
  }
}

/** `--grid`: a JSON array of configurations to propose instead of the default. */
function parseGrid(text: string | undefined): InnerConfig[] {
  if (text === undefined) return DEFAULT_GRID
  const grid = JSON.parse(text) as unknown
  if (!Array.isArray(grid) || grid.length === 0) throw new Error('--grid must be a non-empty JSON array')
  return grid.map((item, index) => {
    const config = { ...ROOT_CONFIG, ...(item as Partial<InnerConfig>) }
    const valid =
      (config.policy === 'incumbent' || config.policy === 'crowded-frontier') &&
      (config.allocation === 'uniform' || config.allocation === 'asha') &&
      Number.isSafeInteger(config.population) &&
      config.population > 0 &&
      Number.isSafeInteger(config.expansions) &&
      config.expansions > 0
    if (!valid) throw new Error(`--grid entry ${index} is not a configuration: ${JSON.stringify(item)}`)
    return config
  })
}
const OUTER_SEARCH_ID = 'meta-sim'
const INNER_CELL_USD = 0.05

function describe(config: InnerConfig): string {
  return `${config.policy} · ${config.allocation} · population ${config.population} · expansions ${config.expansions}`
}

function problems(prefix: string, count: number): SearchTask[] {
  return Array.from({ length: count }, (_, index) => ({
    taskId: `${prefix}${index}`,
    unitId: `${prefix}${index}`,
    source: { uri: `sim://problem/${prefix}${index}`, revision: hashCanonical([prefix, index]) },
  }))
}

function problemSeed(taskId: string, base: number): number {
  const match = /^([px])(\d+)$/.exec(taskId)
  if (!match) throw new Error(`unknown problem ${taskId}`)
  return base + (match[1] === 'x' ? 1000 : 0) + Number(match[2])
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      out: { type: 'string' },
      seed: { type: 'string', default: '1' },
      'selection-problems': { type: 'string', default: '6' },
      'test-problems': { type: 'string', default: '20' },
      'problem-seed': { type: 'string', default: '1000' },
      capacity: { type: 'string', default: '2' },
      'min-effect': { type: 'string', default: '0.005' },
      'inner-selection': { type: 'string', default: '12' },
      'inner-test': { type: 'string', default: '20' },
      'inner-min-effect': { type: 'string', default: '0.1' },
      grid: { type: 'string' },
    },
  })
  if (!values.out) throw new Error('--out DIR is required')
  const out = resolve(values.out)
  const seed = Number(values.seed)
  const baseSeed = Number(values['problem-seed'])
  const innerSelection = Number(values['inner-selection'])
  const innerTest = Number(values['inner-test'])
  const innerMinEffect = Number(values['inner-min-effect'])
  const grid = parseGrid(values.grid)
  const source = metaSimSource(grid)
  rmSync(out, { recursive: true, force: true })
  mkdirSync(join(out, 'outer'), { recursive: true })
  mkdirSync(join(out, 'inner'), { recursive: true })

  const innerOptions = (
    config: InnerConfig,
    problem: number,
    searchId: string,
    containment: SimOptions['containment'],
  ): SimOptions => ({
    searchId,
    containment,
    policy: config.policy,
    seed: problem,
    train: 2,
    selection: innerSelection,
    test: innerTest,
    reps: 1,
    population: config.population,
    expansions: config.expansions,
    capacity: 4,
    maxUsd: null,
    // The simulator's cells cost up to 1.2 times the lane price.
    claimUsd: searchClaimReserveUsd({
      testTasks: innerTest,
      reps: 1,
      cellUsd: INNER_CELL_USD * 1.2,
    }),
    cellUsd: INNER_CELL_USD,
    costCap: 'estimate',
    faultRate: 0,
    delayMs: 0,
    patience: undefined,
    deadline: null,
    minEffect: innerMinEffect,
    nullSteps: false,
    plantGain: null,
    plantDivergence: false,
    judgeRevision: 1,
    binary: false,
    minimize: false,
    costScale: 1,
    allocation: config.allocation,
    poolGap: null,
    poolPlant: null,
  })

  const policy = incumbent()
  const allocation = uniform()
  const claim = developmentClaim('search-sim problems')
  const ledger = openSearchLedger({
    path: join(out, 'outer', 'ledger.jsonl'),
    searchId: OUTER_SEARCH_ID,
  })
  const recorder = await SearchRecorder.open(
    { ledger },
    {
      subject: 'meta/search-sim',
      process: { name: 'search-meta-sim', executionRef: source },
      artifactKind: 'runtime-config',
      objective: {
        metric: 'held-out-lift-per-usd',
        direction: 'maximize',
        judge: META_SEARCH_SCORE_SOURCE,
        claim: { ...claim, minimumEffect: Number(values['min-effect']) },
      },
      splits: {
        train: [],
        selection: problems('p', Number(values['selection-problems'])),
        test: problems('x', Number(values['test-problems'])),
        heldOutUnits: true,
      },
      policy: { expansion: policy.name, allocation: allocation.name, seed },
      budget: {
        maxUsd: null,
        maxCells: null,
        maxNodes: 1 + grid.length,
        deadline: null,
        maxConcurrency: null,
        reservedClaimUsd: 0,
      },
      containment: null,
      derivedFrom: null,
      identity: {
        model: { provider: 'sim', alias: 'sim', unknown: 'the simulator runs no model' },
        agent: source,
        benchmark: {
          uri: 'sim://problems',
          revision: hashCanonical({ baseSeed, innerSelection, innerTest, innerMinEffect }),
        },
      },
    },
  )

  const proposer: SearchProposerPort<InnerConfig> = {
    name: 'config-grid',
    kind: 'optimizer',
    source: source,
    execution: { kind: 'deterministic', source: source },
    reservationUsd: 0,
    childrenPerProposal: grid.length,
    async propose() {
      return {
        children: grid.map((config) => ({
          artifact: config,
          label: describe(config),
          rationale: `grid point ${describe(config)}, one change from the root configuration`,
        })),
        accounting: {
          tokens: { status: 'known', inputTokens: 0, outputTokens: 0, cachedTokens: 0 },
          cost: { status: 'known', usd: 0, source: 'pricing-table' },
        },
      }
    },
  }

  const startedAt = Date.now()
  let innerRuns = 0
  const result = await runNestedSearch<InnerConfig>({
    recorder,
    root: ROOT_CONFIG,
    policy,
    allocation,
    proposer,
    maxExpansions: 1,
    lane: {
      name: 'inner-search',
      capacity: Number(values.capacity),
      costCap: 'estimate',
      cellUsd: 12,
    },
    async runInner({ config, containment, searchId, task }) {
      const store = memoryStore()
      const dir = `mem://search-meta-sim/${searchId}`
      const { result: inner, summary } = await runSimulation(
        dir,
        innerOptions(config, problemSeed(task.taskId, baseSeed), searchId, containment),
        store,
      )
      const checks = summary.ledgerChecks as { ok: boolean; decisions: unknown }
      if (!checks.ok) {
        throw new Error(
          `inner search ${searchId} failed its ledger audit: ${JSON.stringify(checks.decisions)}`,
        )
      }
      const text = store.storage!.read(join(dir, 'ledger.jsonl'))
      if (text === undefined) throw new Error(`inner search ${searchId} kept no ledger`)
      writeFileSync(join(out, 'inner', `${searchId}.jsonl`), text)
      innerRuns += 1
      process.stderr.write(
        `inner ${innerRuns}: ${searchId} ${task.split}/${task.taskId} ${describe(config)} -> ${inner.claim?.decision ?? 'no claim'}\n`,
      )
      return inner.state
    },
  })

  // Read every ledger back from disk: the lens sees exactly what
  // `agent-eval search show --meta` sees.
  const outerPath = join(out, 'outer', 'ledger.jsonl')
  const outer = replaySearchLedgerText(readFileSync(outerPath, 'utf8'), OUTER_SEARCH_ID, outerPath)
  const inners: SearchStateView[] = readdirSync(join(out, 'inner'))
    .filter((name) => name.endsWith('.jsonl'))
    .sort()
    .map((name) => {
      const path = join(out, 'inner', name)
      return replaySearchLedgerText(readFileSync(path, 'utf8'), name.slice(0, -'.jsonl'.length), path)
    })
  const innerObjective = objectiveKey(inners[0]!.header!)
  const lens = metaSearch([outer, ...inners], { objective: innerObjective })
  writeFileSync(join(out, 'meta-search.json'), `${JSON.stringify(lens, null, 2)}\n`)
  writeFileSync(join(out, 'meta-search.txt'), `${renderMetaSearchText(lens)}\n`)
  writeFileSync(
    join(out, 'outer-summary.txt'),
    `${renderSearchSummary(outer, { split: 'selection' })}\n`,
  )

  const configOf = (nodeId: string): InnerConfig =>
    recorder.readBlob(outer.node(nodeId)!.artifact) as InnerConfig
  const nodes = outer.nodes().map((node) => {
    const selection = outer.unitScores(node.nodeId, 'selection')
    const test = outer.unitScores(node.nodeId, 'test')
    return {
      nodeId: node.nodeId,
      config: describe(configOf(node.nodeId)),
      status: node.status,
      selection: {
        problems: selection.length,
        meanLiftPerUsd: mean(selection.map((unit) => unit.mean)),
      },
      test: { problems: test.length, meanLiftPerUsd: mean(test.map((unit) => unit.mean)) },
      unscoredCells: outer
        .cells({ nodeId: node.nodeId })
        .filter((cell) => cell.final && cell.score === null).length,
    }
  })
  const report = {
    wallSeconds: Math.round((Date.now() - startedAt) / 1000),
    outer: {
      ledger: outerPath,
      reason: result.reason,
      leader: result.leader,
      claim: result.claim && {
        decision: result.claim.decision,
        selected: result.claim.selected,
        reason: result.claim.reason,
        power: result.claim.power,
        finalists: result.claim.finalists.map((finalist) => ({
          nodeId: finalist.nodeId,
          config: describe(configOf(finalist.nodeId)),
          promote: finalist.promote,
          test: finalist.test,
        })),
      },
      claimVerification: result.claimVerification,
      audit: {
        cells: outer.audit.cells,
        spend: outer.audit.spend,
      },
      nodes,
    },
    inner: {
      searches: inners.length,
      decisions: tally(inners.map((inner) => inner.closed?.claim?.decision ?? 'none')),
      containmentRecorded: inners.every(
        (inner) => inner.header!.containment?.searchId === OUTER_SEARCH_ID,
      ),
    },
    signal: lens.signal,
    configurations: lens.data.configurations.map((configuration) => ({
      genomeDigest: configuration.genomeDigest,
      objectiveKey: configuration.objectiveKey,
      expansion: configuration.genome.expansion,
      allocation: configuration.genome.allocation,
      maxNodes: configuration.genome.budget.maxNodes,
      searches: configuration.searches.length,
      decisions: configuration.decisions,
      scored: configuration.scored,
      unscored: configuration.unscored,
      estimate: configuration.estimate,
    })),
  }
  console.log(JSON.stringify(report, null, 2))
}

function mean(values: readonly number[]): number | null {
  return values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length
}

function tally(values: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1
  return counts
}

await main()
