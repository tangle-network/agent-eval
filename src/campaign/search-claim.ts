/**
 * The claim: the one statement a search makes about its nodes, made once, on
 * its sealed test split, after the search stops expanding.
 *
 * `planSearchClaim` fixes the claim's design from the ledger before any test
 * cell runs: up to 3 finalists ranked by selection mean, the estimator the
 * paired decision will use, the number of finalists the family-wise confidence
 * is divided among, and a power check on selection data. The kernel stores the
 * plan on the ledger's `claim` operation, so the ledger proves the design was
 * fixed before the test data existed. `decideSearchClaim` then reads the test
 * cells of the root and the finalists, which ran together, and decides each
 * finalist against the root with `decidePairedPromotion` at the Bonferroni
 * confidence `1 - 0.05 / k`.
 *
 * Every number is a pure function of the ledger: the power simulation is
 * seeded from the search's seed and the decisions from the digest of the test
 * cells they read, so a verifier with the same ledger gets the same claim.
 */

import { canonicalString, hashCanonical } from '../ledger-core/canonical'
import { decidePairedPromotion, type PairedPromotionDecision } from '../paired-promotion-decision'
import {
  type PairedPromotionAlternative,
  type PairedPromotionPowerCall,
  pairedPromotionPower,
} from '../paired-promotion-power'
import { estimateNode, searchPosterior, seedFromDigest } from './estimate-node'
import type {
  NodeEstimate,
  SearchClaim,
  SearchClaimEstimator,
  SearchClaimFinalist,
  SearchClaimPower,
  SearchClaimTest,
  SearchCloseReason,
  SearchNodeDecision,
  SearchSourceRef,
} from './search-ledger-types'
import {
  SEARCH_CLAIM_MAX_FINALISTS,
  type SearchStateView,
  type SearchUnitScore,
} from './search-state'

const FAMILY_CONFIDENCE = 0.95
const TARGET_POWER = 0.8
const POWER_SIMULATIONS = 500
const RESAMPLES = 2000

/**
 * Every rule and parameter the claim depends on. Its digest is the claim's
 * revision; change a value here whenever the procedure changes, so the
 * revision moves with it.
 */
const CLAIM_DEFINITION = {
  name: 'tangle.search-claim.2026-09',
  finalists: `up to ${SEARCH_CLAIM_MAX_FINALISTS} non-root nodes not decided invalid that scored every selection unit and beat the root's mean on the selection units they share, ranked by selection mean in the objective's direction, then registration order`,
  familyConfidence: FAMILY_CONFIDENCE,
  correction: 'Bonferroni: each of k finalists against the root at 1 - (1 - familyConfidence) / k',
  finalistCount:
    'the largest k whose test cells the unspent claim reserve and headroom cover and whose power reaches the target',
  estimator:
    'binary with scale s when every train, selection and test unit has one task at one repeat and every pre-test score is 0 or s; otherwise continuous',
  power: {
    method: 'pairedPromotionPower of the claim decision, simulated at the claim minimumEffect',
    continuous: 'per-unit improvement normal with the pooled selection variance',
    binary:
      'discordant units at the pooled selection variance over 2 s^2 per side, shifted by minimumEffect / s; concordant units pass at the root selection pass rate',
    targetPower: TARGET_POWER,
    simulations: POWER_SIMULATIONS,
    seed: 'the first 32 bits of hashCanonical([search seed, k])',
  },
  decision: {
    call: 'decidePairedPromotion(root, finalist) on per-unit test means in the objective direction',
    threshold: 0,
    minPairs: 'every test unit',
    resamples: RESAMPLES,
    seed: "the first 32 bits of the finalist's test cellSetDigest",
  },
  select: 'the promoted finalist with the largest improvement; ties to the better selection rank',
  ship: 'a promoted finalist that scored every test unit, with the root, on held-out units, under a pinned judge',
} as const

/** The claim procedure every `SearchClaim` and claim plan names. */
export const SEARCH_CLAIM_RULE: SearchSourceRef = {
  uri: 'npm:@tangle-network/agent-eval#searchClaim',
  revision: hashCanonical(CLAIM_DEFINITION),
}

/** The rule name decisions made by the claim record. */
export const SEARCH_CLAIM_RULE_NAME = CLAIM_DEFINITION.name

/**
 * The claim reserve a search needs: the root and 3 finalists on every test
 * task at `reps` repeats, each held at `cellUsd`. Declare at least this as
 * `budget.reservedClaimUsd`; `runSearch` refuses to start a capped search
 * with less.
 */
export function searchClaimReserveUsd(input: {
  testTasks: number
  reps: number
  cellUsd: number
}): number {
  return (1 + SEARCH_CLAIM_MAX_FINALISTS) * input.testTasks * input.reps * input.cellUsd
}

/**
 * The claim's design, fixed before any test cell runs, and stored as the
 * `claim-plan` artifact of the ledger's `claim` operation.
 */
export interface SearchClaimPlan {
  kind: 'search-claim-plan'
  rule: SearchSourceRef
  /** Why expansion stopped; the search closes with this reason. */
  stopReason: SearchCloseReason
  /** Best first. Every one is decided `finalist` and named by the claim. */
  finalists: Array<{ nodeId: string; selectionMean: number }>
  power: SearchClaimPower
  /** `run`: the root and the finalists run every test task. Otherwise the
   * claim closes with this decision and spends nothing on test cells. */
  test: 'run' | 'hold' | 'test-cannot-resolve'
  reason: string
}

export interface PlanSearchClaimInput {
  stopReason: SearchCloseReason
  /** Repeats per test task. */
  reps: number
  /** Whether the budget admits the test cells of the root and `finalists`. */
  affordable(finalists: number): boolean
}

/** Fix the claim's design from a search that stopped expanding. */
export function planSearchClaim(
  state: SearchStateView,
  input: PlanSearchClaimInput,
): SearchClaimPlan {
  const header = requireHeader(state)
  const root = state.rootNodeId!
  const plan = (
    finalists: SearchClaimPlan['finalists'],
    power: SearchClaimPower,
    test: SearchClaimPlan['test'],
    reason: string,
  ): SearchClaimPlan => ({
    kind: 'search-claim-plan',
    rule: SEARCH_CLAIM_RULE,
    stopReason: input.stopReason,
    finalists,
    power,
    test,
    reason,
  })
  const selectionUnits = unitIds(header.splits.selection.tasks)
  const testUnits = unitIds(header.splits.test.tasks)
  if (testUnits.length === 0) {
    return plan(
      [],
      { unknown: 'the search has no test split' },
      'hold',
      'the search has no test split, so it makes no claim',
    )
  }
  if (selectionUnits.length === 0) {
    return plan(
      [],
      { unknown: 'the search has no selection split to choose finalists on' },
      'hold',
      'the search has no selection split, so no finalist can be chosen without the test data',
    )
  }
  const candidates = rankFinalists(state, selectionUnits)
  if (candidates.length === 0) {
    return plan(
      [],
      { unknown: 'no node went to test' },
      'hold',
      "no node scored every selection unit and beat the root's selection mean, so the search keeps the root",
    )
  }
  const minimumEffect = header.objective.claim.minimumEffect
  if (minimumEffect === undefined) {
    return plan(
      candidates.slice(0, 1),
      { unknown: 'the claim declares no minimumEffect' },
      'test-cannot-resolve',
      'the claim declares no minimumEffect, so no test split can be shown to resolve it',
    )
  }
  const { pooledVariance } = searchPosterior(state, { split: 'selection' })
  if (pooledVariance === null) {
    return plan(
      candidates.slice(0, 1),
      { unknown: 'no node shares 2 selection units with the root, so the variance is unknown' },
      'test-cannot-resolve',
      'the selection split gives no variance for the power check, so the test cannot be shown to resolve the minimum effect',
    )
  }
  const estimator = claimEstimator(state, input.reps)
  const rootPassRate = passRate(state.unitScores(root, 'selection'), estimator)
  let best: SearchClaimPower | null = null
  let budgetBound = false
  for (let k = candidates.length; k >= 1; k--) {
    const power = claimPower({
      units: testUnits.length,
      finalists: k,
      minimumEffect,
      pooledVariance,
      estimator,
      rootPassRate,
      seed: header.policy.seed,
    })
    best = power
    if (!power.adequate) continue
    if (!input.affordable(k)) {
      budgetBound = true
      continue
    }
    return plan(
      candidates.slice(0, k),
      power,
      'run',
      `${k} finalist${k === 1 ? '' : 's'} go to test: power ${round(power.powerAtMinimumEffect)} at an improvement of ${minimumEffect} on ${testUnits.length} test units reaches ${TARGET_POWER} at confidence ${round(bonferroni(k))} each`,
    )
  }
  const power = best!
  return plan(
    candidates.slice(0, 1),
    power,
    'test-cannot-resolve',
    budgetBound
      ? 'the unspent claim reserve and headroom do not cover the test cells of the root and one finalist'
      : `even one finalist reaches power ${round('adequate' in power ? power.powerAtMinimumEffect : 0)} at an improvement of ${minimumEffect} on ${testUnits.length} test units, below ${TARGET_POWER}`,
  )
}

/** A node decision the claim makes, ready for `recorder.decideNode`. */
export interface SearchClaimDecision {
  nodeId: string
  decision: SearchNodeDecision
  basis: NodeEstimate | null
  rule: string
  reason: string
}

/**
 * Decide the claim from the test cells of the root and the finalists. Call it
 * once every claim cell is settled or cancelled. It returns the claim and the
 * terminal decisions of the root and every finalist.
 */
export function decideSearchClaim(
  state: SearchStateView,
  plan: SearchClaimPlan,
): { claim: SearchClaim; decisions: SearchClaimDecision[] } {
  const header = requireHeader(state)
  const root = state.rootNodeId!
  const rootScored = (['train', 'selection', 'test'] as const).some(
    (split) => state.scoredCells(root, split).length > 0,
  )
  const keepRoot = rootScored ? root : null
  const rule = SEARCH_CLAIM_RULE_NAME
  const decisions: SearchClaimDecision[] = []
  const claimOf = (
    finalists: SearchClaimFinalist[],
    selected: string | null,
    decision: SearchClaim['decision'],
    reason: string,
  ): SearchClaim => ({
    rule: SEARCH_CLAIM_RULE,
    confidence: FAMILY_CONFIDENCE,
    power: plan.power,
    finalists,
    selected,
    decision,
    reason,
  })

  if (plan.test !== 'run') {
    for (const finalist of plan.finalists) {
      decisions.push({
        nodeId: finalist.nodeId,
        decision: { status: 'rejected' },
        basis: null,
        rule,
        reason: `no test cell ran: ${plan.reason}`,
      })
    }
    decisions.push(rootDecision(root, rootScored ? 'kept' : 'unscored', rule, plan.reason))
    return {
      claim: claimOf(
        plan.finalists.map((finalist) => ({
          nodeId: finalist.nodeId,
          estimate: null,
          test: null,
          promote: false,
        })),
        keepRoot,
        plan.test,
        plan.reason,
      ),
      decisions,
    }
  }

  const power = plan.power
  if (!('adequate' in power)) throw new Error('a claim that runs its test cells has a known power')
  const k = plan.finalists.length
  const confidence = bonferroni(k)
  const testUnits = unitIds(header.splits.test.tasks)
  const maximize = header.objective.direction === 'maximize'
  const rootUnits = state.unitScores(root, 'test')
  const tested = plan.finalists.map(({ nodeId }) => {
    const estimate = estimateNode(state, nodeId, { against: root, split: 'test' })
    const test = pairedTest({
      root: rootUnits,
      node: state.unitScores(nodeId, 'test'),
      testUnits,
      confidence,
      estimator: power.estimator,
      maximize,
      seed: seedFromDigest(estimate.cellSetDigest),
    })
    return { nodeId, estimate, ...test }
  })

  const promoted = tested
    .map((entry, rank) => ({ ...entry, rank }))
    .filter((entry) => entry.promote)
    .sort((a, b) => b.improvement! - a.improvement! || a.rank - b.rank)
  const winner = promoted[0] ?? null
  const blockers: string[] = []
  if (!header.splits.heldOutUnits) blockers.push('the test units also appear in train or selection')
  if ('unknown' in header.objective.judge) blockers.push('the judge is not pinned')
  const ship = winner !== null && blockers.length === 0
  const selected = ship ? winner.nodeId : keepRoot
  const reason = ship
    ? `finalist ${winner.nodeId} beat the root on the ${testUnits.length} test units at confidence ${round(confidence)} (${k} finalist${k === 1 ? '' : 's'}, family-wise ${FAMILY_CONFIDENCE})`
    : winner !== null
      ? `finalist ${winner.nodeId} beat the root, but the claim cannot ship: ${blockers.join('; ')}`
      : `no finalist beat the root on the test split at confidence ${round(confidence)} (${k} finalist${k === 1 ? '' : 's'}, family-wise ${FAMILY_CONFIDENCE})`

  for (const entry of tested) {
    decisions.push({
      nodeId: entry.nodeId,
      decision: { status: ship && entry.nodeId === winner!.nodeId ? 'selected' : 'rejected' },
      basis: entry.estimate,
      rule,
      reason:
        ship && entry.nodeId === winner!.nodeId
          ? reason
          : entry.promote
            ? ship
              ? `promoted, but finalist ${winner!.nodeId} improved more on the test split`
              : reason
            : entry.why,
    })
  }
  decisions.push(
    rootDecision(root, ship ? 'replaced' : rootScored ? 'kept' : 'unscored', rule, reason),
  )
  return {
    claim: claimOf(
      tested.map((entry) => ({
        nodeId: entry.nodeId,
        estimate: entry.estimate,
        test: entry.test,
        promote: entry.promote,
      })),
      selected,
      ship ? 'ship' : 'hold',
      reason,
    ),
    decisions,
  }
}

/** Whether a closed search's claim is the one its own ledger supports. */
export type SearchClaimVerification =
  | { status: 'verified' }
  /** The claim differs from the one the claim rule makes from the ledger. */
  | { status: 'mismatch'; differences: string[] }
  /** The claim names a rule revision this code does not implement, so this
   * code can neither confirm nor refute it. */
  | { status: 'unknown'; reason: string }

/**
 * Make a closed search's claim again from its ledger alone and compare it with
 * the recorded one, byte for byte: the power check, the finalists, each
 * finalist's test estimate and deciding interval, the selection, the decision
 * and the reason. A producer's claim is not evidence until this holds; a store
 * keeps what this function derives, not what the producer wrote.
 *
 * It needs no blob, so it works on a store that keeps digests only. The
 * finalists are the nodes the ledger decided `finalist`, in decision order.
 * The one input the ledger cannot replay is whether the budget covered k
 * finalists' test cells; the claim cells that ran answer it (none ran: the
 * budget covered none). Test repeats come from the claim cells too; without
 * test cells, the recorded estimator stands for them (binary needs one repeat,
 * so any other count reproduces continuous).
 *
 * Returns null for a search that made no claim.
 */
export function verifySearchClaim(state: SearchStateView): SearchClaimVerification | null {
  const closed = state.closed
  if (!closed) {
    throw new Error(`search ${state.searchId} is open; its claim is made when it closes`)
  }
  const recorded = closed.claim
  if (recorded === null) return null
  if (recorded.rule.revision !== SEARCH_CLAIM_RULE.revision) {
    return {
      status: 'unknown',
      reason: `the claim names rule revision ${recorded.rule.revision}; this code implements ${SEARCH_CLAIM_RULE.revision}`,
    }
  }
  const claimCells = state.cells().filter((cell) => cell.stage === 'claim')
  const decided = state
    .nodes()
    .flatMap((node) => {
      const first = node.decisions.find((record) => record.decision.status === 'finalist')
      return first ? [{ nodeId: node.nodeId, sequence: first.sequence }] : []
    })
    .sort((a, b) => a.sequence - b.sequence)
    .map((entry) => entry.nodeId)
  const reps =
    claimCells.length > 0
      ? 1 + Math.max(...claimCells.map((cell) => cell.rep))
      : 'adequate' in recorded.power && recorded.power.estimator.kind === 'binary'
        ? 1
        : 2
  const plan = planSearchClaim(state, {
    stopReason: closed.reason,
    reps,
    affordable: (finalists) => claimCells.length > 0 && finalists <= decided.length,
  })
  const differences: string[] = []
  const planned = plan.finalists.map((finalist) => finalist.nodeId)
  if (canonicalString(planned) !== canonicalString(decided)) {
    differences.push(
      `finalists: the rule picks [${planned.join(', ')}], the ledger decided [${decided.join(', ')}]`,
    )
  }
  if ((plan.test === 'run') !== claimCells.length > 0) {
    differences.push(
      `test: the plan ${plan.test === 'run' ? 'runs' : 'skips'} the test cells, and ${claimCells.length} ran`,
    )
  }
  const expected = decideSearchClaim(state, plan).claim
  for (const key of ['decision', 'selected', 'confidence', 'power', 'reason'] as const) {
    if (canonicalString(expected[key]) !== canonicalString(recorded[key])) {
      differences.push(
        `${key}: the ledger supports ${canonicalString(expected[key])}, the claim records ${canonicalString(recorded[key])}`,
      )
    }
  }
  const count = Math.max(expected.finalists.length, recorded.finalists.length)
  for (let index = 0; index < count; index++) {
    const want = expected.finalists[index]
    const have = recorded.finalists[index]
    if (canonicalString(want ?? null) === canonicalString(have ?? null)) continue
    const fields = (['nodeId', 'promote', 'test', 'estimate'] as const).filter(
      (field) => canonicalString(want?.[field] ?? null) !== canonicalString(have?.[field] ?? null),
    )
    differences.push(
      `finalist ${index + 1} (${have?.nodeId ?? want?.nodeId}): ${fields.join(', ')} differ from what the ledger supports`,
    )
  }
  return differences.length === 0 ? { status: 'verified' } : { status: 'mismatch', differences }
}

/** Per-finalist confidence for `k` finalists. */
function bonferroni(k: number): number {
  return 1 - (1 - FAMILY_CONFIDENCE) / k
}

function rootDecision(
  root: string,
  fate: 'kept' | 'replaced' | 'unscored',
  rule: string,
  reason: string,
): SearchClaimDecision {
  return {
    nodeId: root,
    decision: { status: fate === 'kept' ? 'selected' : 'rejected' },
    basis: null,
    rule,
    reason:
      fate === 'kept'
        ? `the search keeps the root: ${reason}`
        : fate === 'replaced'
          ? `a finalist replaces the root: ${reason}`
          : 'the root has no scored cell, so the search keeps nothing',
  }
}

/** Nodes eligible to go to test, best first, at most `SEARCH_CLAIM_MAX_FINALISTS`. */
function rankFinalists(
  state: SearchStateView,
  selectionUnits: readonly string[],
): Array<{ nodeId: string; selectionMean: number }> {
  const header = requireHeader(state)
  const sign = header.objective.direction === 'maximize' ? 1 : -1
  const root = state.rootNodeId!
  const rootMeans = new Map(
    state.unitScores(root, 'selection').map((unit) => [unit.unitId, unit.mean]),
  )
  const ranked: Array<{ nodeId: string; selectionMean: number; ordinal: number }> = []
  for (const node of state.nodes()) {
    if (node.nodeId === root || node.status === 'invalid') continue
    const units = state.unitScores(node.nodeId, 'selection')
    if (units.length !== selectionUnits.length) continue
    let gain = 0
    let shared = 0
    for (const unit of units) {
      const rootMean = rootMeans.get(unit.unitId)
      if (rootMean === undefined) continue
      gain += sign * (unit.mean - rootMean)
      shared += 1
    }
    if (shared === 0 || gain <= 0) continue
    ranked.push({
      nodeId: node.nodeId,
      selectionMean: mean(units.map((unit) => unit.mean)),
      ordinal: node.ordinal,
    })
  }
  ranked.sort((a, b) => sign * (b.selectionMean - a.selectionMean) || a.ordinal - b.ordinal)
  return ranked
    .slice(0, SEARCH_CLAIM_MAX_FINALISTS)
    .map(({ nodeId, selectionMean }) => ({ nodeId, selectionMean }))
}

/**
 * The paired decision's estimator, fixed from pre-test data. A per-unit mean
 * is binary only when each unit holds one task at one repeat and every score
 * seen before the test is 0 or one positive value.
 */
function claimEstimator(state: SearchStateView, reps: number): SearchClaimEstimator {
  const header = requireHeader(state)
  const oneTaskPerUnit = (['train', 'selection', 'test'] as const).every((split) => {
    const tasks = header.splits[split].tasks
    return unitIds(tasks).length === tasks.length
  })
  if (!oneTaskPerUnit || reps !== 1) return { kind: 'continuous' }
  let scale: number | null = null
  for (const nodeId of state.nodeIds()) {
    for (const split of ['train', 'selection'] as const) {
      for (const cell of state.scoredCells(nodeId, split)) {
        if (cell.score === 0) continue
        if (cell.score < 0 || (scale !== null && cell.score !== scale))
          return { kind: 'continuous' }
        scale = cell.score
      }
    }
  }
  return scale === null ? { kind: 'continuous' } : { kind: 'binary', scale }
}

function passRate(units: readonly SearchUnitScore[], estimator: SearchClaimEstimator): number {
  if (estimator.kind !== 'binary' || units.length === 0) return 0
  return units.filter((unit) => unit.mean === estimator.scale).length / units.length
}

function claimPower(input: {
  units: number
  finalists: number
  minimumEffect: number
  pooledVariance: number
  estimator: SearchClaimEstimator
  rootPassRate: number
  seed: number
}): Extract<SearchClaimPower, { adequate: boolean }> {
  const { units, finalists, minimumEffect, pooledVariance, estimator } = input
  const confidence = bonferroni(finalists)
  let alternative: PairedPromotionAlternative
  let call: PairedPromotionPowerCall
  if (estimator.kind === 'binary') {
    const s = estimator.scale
    const shift = Math.min(1, minimumEffect / s)
    const discordance = Math.min(0.5, pooledVariance / (2 * s * s))
    const loss = Math.max(0, discordance - shift / 2)
    const win = Math.min(1 - loss, loss + shift)
    const concordant = Math.max(0, 1 - win - loss)
    alternative = {
      cells: [
        {
          probability: win,
          pass: { control: false, treatment: true },
          delta: { kind: 'point', value: s },
        },
        {
          probability: loss,
          pass: { control: true, treatment: false },
          delta: { kind: 'point', value: -s },
        },
        {
          probability: concordant * input.rootPassRate,
          pass: { control: true, treatment: true },
          delta: { kind: 'point', value: 0 },
        },
        {
          probability: concordant * (1 - input.rootPassRate),
          pass: { control: false, treatment: false },
          delta: { kind: 'point', value: 0 },
        },
      ],
    }
    call = { outcome: 'pass', options: { binaryScale: s, confidence, threshold: 0 } }
  } else {
    alternative = {
      cells: [
        {
          probability: 1,
          delta: { kind: 'normal', mean: minimumEffect, sd: Math.sqrt(pooledVariance) },
        },
      ],
    }
    call = {
      outcome: 'delta',
      options: { continuous: true, confidence, threshold: 0, resamples: RESAMPLES },
    }
  }
  const simulated = pairedPromotionPower({
    n: units,
    alternative,
    calls: [call],
    simulations: POWER_SIMULATIONS,
    seed: seedFromDigest(hashCanonical([input.seed, finalists])),
  })
  return {
    adequate: simulated.power >= TARGET_POWER,
    minimumEffect,
    powerAtMinimumEffect: simulated.power,
    targetPower: TARGET_POWER,
    units,
    finalists,
    pooledVariance,
    estimator,
  }
}

/**
 * One finalist against the root on the test split, in the objective's
 * direction, requiring every test unit scored by both.
 */
function pairedTest(input: {
  root: readonly SearchUnitScore[]
  node: readonly SearchUnitScore[]
  testUnits: readonly string[]
  confidence: number
  estimator: SearchClaimEstimator
  maximize: boolean
  seed: number
}): { test: SearchClaimTest | null; promote: boolean; improvement: number | null; why: string } {
  const rootMeans = new Map(input.root.map((unit) => [unit.unitId, unit.mean]))
  const before: number[] = []
  const after: number[] = []
  for (const unit of input.node) {
    const rootMean = rootMeans.get(unit.unitId)
    if (rootMean === undefined) continue
    // `after - before` is the improvement in either direction.
    before.push(input.maximize ? rootMean : unit.mean)
    after.push(input.maximize ? unit.mean : rootMean)
  }
  const pairs = before.length
  if (pairs === 0) {
    return {
      test: null,
      promote: false,
      improvement: null,
      why: 'no test unit was scored by both it and the root',
    }
  }
  const { estimator } = input
  if (
    estimator.kind === 'binary' &&
    [...before, ...after].some((value) => value !== 0 && value !== estimator.scale)
  ) {
    return {
      test: null,
      promote: false,
      improvement: null,
      why: `a test score left the two-point scale {0, ${estimator.scale}} the claim fixed before the test`,
    }
  }
  const decision: PairedPromotionDecision = decidePairedPromotion(before, after, {
    confidence: input.confidence,
    threshold: 0,
    minPairs: input.testUnits.length,
    resamples: RESAMPLES,
    seed: input.seed,
    ...(estimator.kind === 'binary' ? { binaryScale: estimator.scale } : { continuous: true }),
  })
  const test: SearchClaimTest = {
    pairs,
    confidence: input.confidence,
    method: decision.method,
    delta: plain(input.maximize ? decision.delta : -decision.delta),
    interval: input.maximize
      ? [plain(decision.low), plain(decision.high)]
      : [plain(-decision.high), plain(-decision.low)],
  }
  const complete = pairs === input.testUnits.length
  const promote = decision.promote && complete
  const why = !complete
    ? `it and the root scored ${pairs} of ${input.testUnits.length} test units, and a claim needs every one`
    : decision.promote
      ? 'promoted'
      : !decision.sufficient
        ? `${pairs} test units are below the ${decision.minimumPairs} its paired test needs`
        : decision.indeterminate
          ? `its test interval has no width: ${decision.indeterminateCause}`
          : decision.exactTestVetoes
            ? "McNemar's exact test vetoes the improvement"
            : `its improvement interval [${round(decision.low)}, ${round(decision.high)}] at confidence ${round(input.confidence)} does not exclude 0`
  return { test, promote, improvement: decision.delta, why }
}

function requireHeader(state: SearchStateView) {
  const header = state.header
  if (!header) throw new Error(`search ${state.searchId} has not been opened`)
  if (state.rootNodeId === null) throw new Error(`search ${state.searchId} has no root node`)
  return header
}

function unitIds(tasks: ReadonlyArray<{ unitId: string }>): string[] {
  return [...new Set(tasks.map((task) => task.unitId))]
}

function mean(values: readonly number[]): number {
  let total = 0
  for (const value of values) total += value
  return total / values.length
}

function round(value: number): number {
  return Math.round(value * 1e4) / 1e4
}

/** Canonical JSON has one zero; never hand it a negative one. */
function plain(value: number): number {
  return value === 0 ? 0 : value
}
