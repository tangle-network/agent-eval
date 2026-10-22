import { roundDecimal as round } from '../math/round-decimal'
import type { Analysis } from './analyze-context'
import { asRecord } from './source-facts'
import { type Measured, type SpendMeasurements, unavailable } from './types'

/** Spend records of the root and its children, split into reporting and unreporting. */
export function collectSpendFacts(a: Analysis) {
  const { tree, rootId, workerSpawns, workerCloses } = a
  const rootChildIds = new Set(
    workerSpawns.filter((spawn) => spawn.parent === rootId).map((spawn) => spawn.id),
  )
  const rootChildCloses = workerCloses.filter((close) => rootChildIds.has(close.id))
  // Runtime marks a spend record `usdKnown: false` / `tokensKnown: false` when the work
  // HAPPENED but no provider receipt covered its price or its tokens. Folding such a record
  // in prices unreported work at zero; dropping the whole channel discards every record that
  // DID report. So each channel sums only the reporting records and names the rest.
  const rootChildSpends = rootChildCloses.filter((close) => close.hasSpend)
  const workerUsdUnknownNodes = rootChildSpends
    .filter((close) => !close.spend.usdKnown)
    .map((close) => close.id)
  const workerTokensUnknownNodes = rootChildSpends
    .filter((close) => !close.spend.tokensKnown)
    .map((close) => close.id)
  const workerTokenSpends = rootChildSpends.filter((close) => close.spend.tokensKnown)
  const journalWorkerIn = workerTokenSpends.reduce((a, c) => a + c.spend.tokens.input, 0)
  const journalWorkerOut = workerTokenSpends.reduce((a, c) => a + c.spend.tokens.output, 0)
  const journalWorkerUsd = rootChildSpends
    .filter((close) => close.spend.usdKnown)
    .reduce((a, c) => a + c.spend.usd, 0)
  const usdUnknownIds = new Set(
    workerCloses.filter((close) => close.hasSpend && !close.spend.usdKnown).map((c) => c.id),
  )
  const workerUsdById = new Map<string, number>()
  for (const c of workerCloses) {
    if (usdUnknownIds.has(c.id)) continue
    workerUsdById.set(c.id, (workerUsdById.get(c.id) ?? 0) + c.spend.usd)
  }
  const labelById = new Map(workerSpawns.map((spawn) => [spawn.id, spawn.label]))
  const usdUnknownLabels = new Set(
    [...usdUnknownIds].map((id) => labelById.get(id)).filter((l): l is string => l !== undefined),
  )
  const workerUsdByLabel = new Map<string, number>()
  for (const close of workerCloses) {
    const label = labelById.get(close.id)
    if (label === undefined || usdUnknownLabels.has(label)) continue
    workerUsdByLabel.set(label, (workerUsdByLabel.get(label) ?? 0) + close.spend.usd)
  }
  const brainUsdUnknownNodes =
    tree.brain.usdUnknownCount > 0 && rootId !== null ? ([rootId] as const) : []
  const brainTokensUnknownNodes =
    tree.brain.tokensUnknownCount > 0 && rootId !== null ? ([rootId] as const) : []
  const usdKnownRecords =
    tree.brain.usdKnownCount + rootChildSpends.filter((close) => close.spend.usdKnown).length
  const usdUnknownRecords = tree.brain.usdUnknownCount + workerUsdUnknownNodes.length
  const usdUnknownNodes = [...brainUsdUnknownNodes, ...workerUsdUnknownNodes]
  // The named nodes are what makes the gap actionable, but a fleet run can have hundreds,
  // and this string lands in a report line. Name the first few and count the rest.
  const NAMED_NODE_LIMIT = 5
  const nameNodes = (nodes: readonly string[]): string => {
    if (nodes.length === 0) return ''
    const shown = nodes.slice(0, NAMED_NODE_LIMIT)
    const rest = nodes.length - shown.length
    return ` (${shown.join(', ')}${rest === 0 ? '' : ` +${rest} more`})`
  }
  const unpriced = (unknown: number, total: number, nodes: readonly string[]): string =>
    `Runtime recorded usdKnown:false on ${unknown} of ${total} spend record(s)${nameNodes(nodes)}`
  // A token total is a bare `Measured<number>` with no record denominator beside it, so a
  // partial sum there would be an unlabelled floor — the exact collapse this module refuses.
  // Spend has `SpendMeasurement.records`/`unknownRecords` to carry the split, so it stays
  // partial; tokens go absent with the unreporting nodes named.
  const unreportedTokens = (unknown: number, total: number, nodes: readonly string[]): string =>
    `Runtime recorded tokensKnown:false on ${unknown} of ${total} spend record(s)${nameNodes(nodes)}`
  const usdPartial = usdKnownRecords > 0 && usdUnknownRecords > 0
  const usdAllUnknown = usdKnownRecords === 0 && usdUnknownRecords > 0
  // A role whose records are ALL unreported has nothing measured to report, so it stays
  // unavailable. A role with some of each keeps its sum and labels it in `source`.
  const brainTokensUnreported =
    tree.brain.tokensUnknownCount === 0
      ? null
      : unreportedTokens(
          tree.brain.tokensUnknownCount,
          tree.brain.meteredCount,
          brainTokensUnknownNodes,
        )
  const brainUsdUnreported =
    tree.brain.usdKnownCount > 0 || tree.brain.usdUnknownCount === 0
      ? null
      : unpriced(tree.brain.usdUnknownCount, tree.brain.meteredCount, brainUsdUnknownNodes)
  const workerUsdUnreported =
    workerUsdUnknownNodes.length === 0 || workerUsdUnknownNodes.length < rootChildSpends.length
      ? null
      : unpriced(workerUsdUnknownNodes.length, rootChildSpends.length, workerUsdUnknownNodes)
  return {
    rootChildCloses,
    rootChildSpends,
    workerUsdUnknownNodes,
    workerTokensUnknownNodes,
    journalWorkerIn,
    journalWorkerOut,
    journalWorkerUsd,
    workerUsdById,
    workerUsdByLabel,
    usdKnownRecords,
    usdUnknownRecords,
    usdUnknownNodes,
    brainUsdUnknownNodes,
    brainTokensUnknownNodes,
    unpriced,
    unreportedTokens,
    usdPartial,
    usdAllUnknown,
    brainTokensUnreported,
    brainUsdUnreported,
    workerUsdUnreported,
  }
}

/** Worker token totals: journal spend plus harness session counts, or the reason they are absent. */
export function measureWorkerTokens(a: Analysis, f: SpendFacts) {
  const { src, gap, haveJournal } = a
  const {
    rootChildSpends,
    workerTokensUnknownNodes,
    journalWorkerIn,
    journalWorkerOut,
    unreportedTokens,
  } = f
  const sq = src.harnessWorkerTokens
  const harnessGapReason =
    src.harnessMissingReason ?? 'harness session store unavailable and journal settled spend is 0'
  const workerTokenLimit = src.limits.workerTokens
  const workerTokensUnreported =
    workerTokensUnknownNodes.length === 0
      ? null
      : unreportedTokens(
          workerTokensUnknownNodes.length,
          rootChildSpends.length,
          workerTokensUnknownNodes,
        )
  const workerIn: Measured<number> =
    workerTokenLimit !== null
      ? gap('workers.tokensIn', workerTokenLimit)
      : workerTokensUnreported !== null
        ? gap('workers.tokensIn', workerTokensUnreported)
        : sq !== null
          ? journalWorkerIn + sq.input
          : haveJournal
            ? journalWorkerIn
            : gap('workers.tokensIn', harnessGapReason)
  const workerOut: Measured<number> =
    workerTokenLimit !== null
      ? unavailable(workerTokenLimit)
      : workerTokensUnreported !== null
        ? unavailable(workerTokensUnreported)
        : sq !== null
          ? journalWorkerOut + sq.output
          : haveJournal
            ? journalWorkerOut
            : unavailable(harnessGapReason)
  return { sq, workerTokenLimit, workerIn, workerOut }
}

/** Total USD and the close record it is read against. */
export function measureTotalUsd(a: Analysis, f: SpendFacts) {
  const { src, gap, journalMissing, haveJournal, tree, state, result } = a
  const { journalWorkerUsd, usdKnownRecords, usdUnknownRecords, usdUnknownNodes, unpriced } = f
  const stateResult = asRecord(state?.result)
  const stateUsd = typeof stateResult.spentUsd === 'number' ? stateResult.spentUsd : null
  const resultSpentTotal = asRecord(result?.spentTotal)
  const resultCloseUsd =
    typeof resultSpentTotal.usd === 'number' && Number.isFinite(resultSpentTotal.usd)
      ? resultSpentTotal.usd
      : null
  // The close record: what the store wrote as settled when the run closed.
  const closeUsd = stateUsd ?? resultCloseUsd
  // A store that logs tokens but never a price yields usd 0 from every sum. That
  // 0 is the store's silence, not a free run, so the limit outranks the sum.
  const usdLimit = src.limits.spendUsd
  // The close record carries its own completeness flag: `spentTotal.usdKnown: false` means
  // Runtime priced part of the run from a catalog, so the number is a floor, not a total.
  const closeUsdUnreported =
    stateUsd === null && resultCloseUsd !== null && resultSpentTotal.usdKnown === false
  const usdUnreportedReason = unpriced(
    usdUnknownRecords,
    usdKnownRecords + usdUnknownRecords,
    usdUnknownNodes,
  )
  // Which numbers may be partial, and which must go absent: a number may be a floor only
  // when its own record carries the known/unknown split beside it — `SpendMeasurement`
  // has `records`/`unknownRecords`, and `RoleSpend` has `source`. `totalUsd` is a bare
  // scalar, so a floor there is an unlabelled understatement and stays unavailable; the
  // partial sum with its denominators lives in `spend.journalDerived`, which this type's
  // own doc already names as the field to prefer.
  const totalUsd: Measured<number> =
    usdLimit !== null
      ? gap('totalUsd', usdLimit)
      : stateUsd !== null
        ? round(stateUsd, 6)
        : !haveJournal
          ? gap('totalUsd', journalMissing)
          : usdUnknownRecords > 0
            ? gap('totalUsd', usdUnreportedReason)
            : round(tree.brain.usd + journalWorkerUsd, 6)
  return {
    stateResult,
    stateUsd,
    usdLimit,
    totalUsd,
    closeUsd,
    closeUsdUnreported,
    usdUnreportedReason,
  }
}

export function buildSpend(a: Analysis, f: SpendFacts, t: TotalUsd): SpendMeasurements {
  const { journalMissing, haveJournal, tree, rootId } = a
  const {
    journalWorkerUsd,
    usdKnownRecords,
    usdUnknownRecords,
    usdUnknownNodes,
    usdPartial,
    usdAllUnknown,
  } = f
  const { usdLimit, closeUsd, closeUsdUnreported, usdUnreportedReason } = t
  const journalSpendRecords = usdKnownRecords
  // `journalDerived` keeps its partial sum: `records` and `unknownRecords` state exactly
  // how much of the run it covers. Only an all-unreported channel has nothing to report.
  const journalDerivedAvailable = usdLimit === null && haveJournal && !usdAllUnknown
  const closeRecordAvailable = usdLimit === null && closeUsd !== null && !closeUsdUnreported
  const spend: SpendMeasurements = {
    journalDerived: {
      usd: journalDerivedAvailable
        ? round(tree.brain.usd + journalWorkerUsd, 6)
        : unavailable(usdLimit ?? (haveJournal ? usdUnreportedReason : journalMissing)),
      records: journalDerivedAvailable ? journalSpendRecords : 0,
      unknownRecords: usdLimit === null && haveJournal ? usdUnknownRecords : 0,
      partial: journalDerivedAvailable && usdPartial,
      unknownNodes: usdLimit === null && haveJournal ? usdUnknownNodes : [],
    },
    closeRecord: {
      usd: closeRecordAvailable
        ? round(closeUsd as number, 6)
        : unavailable(
            usdLimit ??
              (closeUsdUnreported
                ? 'close record incomplete: result.json spentTotal.usdKnown is false'
                : 'no close record: neither state.json result.spentUsd nor result.json spentTotal.usd is present'),
          ),
      records: closeRecordAvailable ? 1 : 0,
      unknownRecords: closeUsdUnreported ? 1 : 0,
      partial: false,
      unknownNodes: closeUsdUnreported && rootId !== null ? [rootId] : [],
    },
  }
  return spend
}

export type SpendFacts = ReturnType<typeof collectSpendFacts>
export type WorkerTokens = ReturnType<typeof measureWorkerTokens>
export type TotalUsd = ReturnType<typeof measureTotalUsd>
