import { roundDecimal as round } from '../math/round-decimal'
import { summarizeNumberSeries } from '../statistics'
import type { Analysis } from './analyze-context'
import type { SpendFacts, TotalUsd, WorkerTokens } from './analyze-spend'
import { parseJsonl, workerSourceKey } from './source-facts'
import {
  type DecisionMetrics,
  type EconomicsMetrics,
  isUnavailable,
  type PerWorkerRow,
  type SpendMeasurements,
  type SupervisorRunSources,
  unavailable,
} from './types'

const NO_CACHE_COUNTERS = 'the journal carries no cache-token counters for this role'

const NO_CACHE_BREAKDOWN =
  'Runtime recorded cacheBreakdownKnown:false — the provider reported a total without splitting cache reads from writes'

/** One row per worker log, plus the capture gaps of the root and every worker. */
export function buildPerWorker(a: Analysis, f: SpendFacts, t: TotalUsd): PerWorkerRow[] {
  const { src, gaps, tree, rootId, spawnsForSource, spawnForSource, closeById } = a
  const { workerUsdById, workerUsdByLabel } = f
  const { usdLimit } = t
  const noteCaptureGaps = (
    owner: string,
    captures: SupervisorRunSources['rootWorkspaceCaptures'],
  ): void => {
    if (captures === null || captures?.length === 0) {
      gaps.push(`${owner} workspaceCapture: no retained output capture evidence`)
    } else if (captures !== undefined) {
      for (const [index, capture] of captures.entries()) {
        const source = `${owner} workspaceCapture[${index + 1}]`
        if (capture.projectionGap !== null) gaps.push(`${source}: ${capture.projectionGap}`)
        if (capture.coverageComplete === false) {
          gaps.push(
            `${source}: ${capture.incompleteReason ?? 'provider reported incomplete coverage'}`,
          )
        }
        if (capture.coverageComplete === null && capture.projectionGap === null) {
          gaps.push(`${source}: capture coverage was not recorded`)
        }
      }
    }
  }
  noteCaptureGaps(`root ${rootId ?? src.runRef}`, src.rootWorkspaceCaptures)
  const perWorker: PerWorkerRow[] = (src.workers ?? []).map((w) => {
    noteCaptureGaps(`worker ${w.workerId ?? w.label}`, w.workspaceCaptures)
    const f = tree.workerLogs.get(workerSourceKey(w))
    const matchingSpawns = spawnsForSource(w)
    const spawn = spawnForSource(w)
    const close = spawn === null ? null : (closeById.get(spawn.id) ?? null)
    const passed = close?.valid ?? f?.passed ?? null
    const matchingRoles = new Set(matchingSpawns.map((candidate) => candidate.role))
    const matchingRuntimes = new Set(matchingSpawns.map((candidate) => candidate.runtime))
    const matchingProfiles = new Set(matchingSpawns.map((candidate) => candidate.profileDigest))
    const journalWallMs =
      spawn?.at !== null &&
      spawn?.at !== undefined &&
      close?.at !== null &&
      close?.at !== undefined &&
      close.at >= spawn.at
        ? close.at - spawn.at
        : null
    return {
      workerId: w.workerId ?? null,
      worker: w.label,
      role: matchingRoles.size === 1 ? (matchingSpawns[0]?.role ?? null) : null,
      runtime: matchingRuntimes.size === 1 ? (matchingSpawns[0]?.runtime ?? null) : null,
      profileDigest:
        matchingProfiles.size === 1 ? (matchingSpawns[0]?.profileDigest ?? null) : null,
      status: close?.status ?? null,
      failure: close?.reason ?? null,
      infra: close?.infra ?? null,
      wallMs: f?.started != null && f.finishedAt != null ? f.finishedAt - f.started : journalWallMs,
      tokensIn:
        w.tokensIn ??
        (close?.hasSpend === true && close.spend.tokensKnown ? close.spend.tokens.input : null),
      tokensOut:
        w.tokensOut ??
        (close?.hasSpend === true && close.spend.tokensKnown ? close.spend.tokens.output : null),
      usd:
        usdLimit !== null
          ? null
          : w.workerId === undefined
            ? (workerUsdByLabel.get(w.label) ?? null)
            : (workerUsdById.get(w.workerId) ?? null),
      patchBytes: w.patchBytes ?? f?.finishedPatchBytes ?? null,
      passed,
      score: close?.score ?? f?.score ?? null,
      workspaceCaptures: w.workspaceCaptures ?? null,
    }
  })
  return perWorker
}

/** The supervisor brain's tokens, cache and USD. */
export function buildBrainSpend(
  a: Analysis,
  f: SpendFacts,
  t: TotalUsd,
): EconomicsMetrics['brain'] {
  const { src, gap, journalMissing, haveJournal, tree } = a
  const { brainTokensUnreported, brainUsdUnreported } = f
  const { usdLimit } = t
  const managerTokenLimit = src.limits.managerTokens
  return {
    tokensIn:
      managerTokenLimit !== null
        ? gap('brain.tokensIn', managerTokenLimit)
        : !haveJournal
          ? gap('brain.tokensIn', journalMissing)
          : brainTokensUnreported !== null
            ? gap('brain.tokensIn', brainTokensUnreported)
            : tree.brain.tokensIn,
    tokensOut:
      managerTokenLimit !== null
        ? unavailable(managerTokenLimit)
        : !haveJournal
          ? unavailable(journalMissing)
          : brainTokensUnreported !== null
            ? unavailable(brainTokensUnreported)
            : tree.brain.tokensOut,
    usd:
      usdLimit !== null
        ? unavailable(usdLimit)
        : !haveJournal
          ? unavailable(journalMissing)
          : brainUsdUnreported !== null
            ? unavailable(brainUsdUnreported)
            : round(tree.brain.usd, 6),
    cacheRead:
      managerTokenLimit !== null
        ? unavailable(managerTokenLimit)
        : !haveJournal
          ? unavailable(journalMissing)
          : brainTokensUnreported !== null
            ? unavailable(brainTokensUnreported)
            : !tree.brain.hasCache
              ? unavailable(NO_CACHE_COUNTERS)
              : tree.brain.cacheBreakdownKnown
                ? tree.brain.cacheRead
                : unavailable(NO_CACHE_BREAKDOWN),
    cacheWrite:
      managerTokenLimit !== null
        ? unavailable(managerTokenLimit)
        : !haveJournal
          ? unavailable(journalMissing)
          : brainTokensUnreported !== null
            ? unavailable(brainTokensUnreported)
            : !tree.brain.hasCache
              ? unavailable(NO_CACHE_COUNTERS)
              : tree.brain.cacheBreakdownKnown
                ? tree.brain.cacheWrite
                : unavailable(NO_CACHE_BREAKDOWN),
    source:
      managerTokenLimit ??
      (haveJournal
        ? `journal metered events (n=${tree.brain.meteredCount})${
            tree.brain.usdKnownCount > 0 && tree.brain.usdUnknownCount > 0
              ? ` — ${tree.brain.usdUnknownCount} unpriced`
              : ''
          }`
        : journalMissing),
  }
}

/** The workers' tokens, cache and USD. */
export function buildWorkerSpend(
  a: Analysis,
  f: SpendFacts,
  t: TotalUsd,
  w: WorkerTokens,
): EconomicsMetrics['workers'] {
  const { src, journalMissing, haveJournal } = a
  const { rootChildSpends, workerUsdUnknownNodes, journalWorkerUsd, workerUsdUnreported } = f
  const { usdLimit } = t
  const { sq, workerTokenLimit, workerIn, workerOut } = w
  return {
    tokensIn: workerIn,
    tokensOut: workerOut,
    cacheRead:
      workerTokenLimit !== null
        ? unavailable(workerTokenLimit)
        : sq?.cacheRead !== undefined
          ? sq.cacheRead
          : unavailable(NO_CACHE_COUNTERS),
    cacheWrite:
      workerTokenLimit !== null
        ? unavailable(workerTokenLimit)
        : sq?.cacheWrite !== undefined
          ? sq.cacheWrite
          : unavailable(NO_CACHE_COUNTERS),
    usd:
      usdLimit !== null
        ? unavailable(usdLimit)
        : !haveJournal
          ? unavailable(journalMissing)
          : workerUsdUnreported !== null
            ? unavailable(workerUsdUnreported)
            : round(journalWorkerUsd, 6),
    source: `${
      workerTokenLimit !== null
        ? workerTokenLimit
        : sq !== null
          ? `journal settled spend + ${sq.store} sessions (n=${sq.sessions})`
          : `journal settled spend only — ${src.harnessMissingReason ?? 'harness session store unavailable'}`
    }${
      workerUsdUnknownNodes.length > 0 && workerUsdUnknownNodes.length < rootChildSpends.length
        ? ` — ${workerUsdUnknownNodes.length} unpriced`
        : ''
    }`,
  }
}

export function buildEconomics(
  a: Analysis,
  f: SpendFacts,
  t: TotalUsd,
  w: WorkerTokens,
  e: EconomicsParts,
): EconomicsMetrics {
  const { src, gap, journalMissing, haveJournal, tree, workersGapReason } = a
  const { rootChildCloses, journalWorkerUsd, usdUnknownRecords } = f
  const { stateUsd, usdLimit, totalUsd, usdUnreportedReason } = t
  const { decision, spend, perWorker } = e
  const wallDistribution = summarizeNumberSeries(
    perWorker.map((w) => w.wallMs).filter((w): w is number => w !== null),
  )

  const brainCalls = parseJsonl(src.brainLog)
  return {
    resourceRecords:
      src.journal === null && !tree.resourceRecords?.length
        ? unavailable(journalMissing)
        : (tree.resourceRecords ?? []),
    brain: buildBrainSpend(a, f, t),
    brainTruncations:
      src.brainLog === null
        ? gap(
            'brain.brainTruncations',
            src.brainLogMissingReason ??
              (src.supRunDir === null
                ? 'no Runtime supervisor run directory'
                : 'brain.jsonl absent — this source has no brain-call tap, so truncation cannot be ruled out'),
          )
        : brainCalls.filter((c) => c.finish_reason === 'length').length,
    workers: buildWorkerSpend(a, f, t, w),
    spend,
    totalUsd,
    totalUsdSource:
      usdLimit !== null
        ? usdLimit
        : stateUsd !== null
          ? `state.json result.spentUsd${rootChildCloses.length > 0 && journalWorkerUsd === 0 ? ' — brain-priced only; worker CLI inference is unpriced (see worker token counts)' : ''}`
          : !haveJournal
            ? journalMissing
            : usdUnknownRecords > 0
              ? usdUnreportedReason
              : 'journal metered + settled usd',
    costPerAcceptedPatchUsd: isUnavailable(totalUsd)
      ? unavailable(totalUsd.unavailable)
      : isUnavailable(decision.accepted)
        ? unavailable(decision.accepted.unavailable)
        : decision.accepted === 0
          ? unavailable('no accepted worker patch (cost has no denominator)')
          : round(totalUsd / decision.accepted, 6),
    workerWallMsDistribution:
      wallDistribution === null
        ? unavailable(
            src.workers === null ? workersGapReason : 'no worker start/finish pairs captured',
          )
        : wallDistribution,
    perWorker: src.workers === null ? unavailable(workersGapReason) : perWorker,
  }
}

export interface EconomicsParts {
  decision: DecisionMetrics
  spend: SpendMeasurements
  perWorker: PerWorkerRow[]
}
