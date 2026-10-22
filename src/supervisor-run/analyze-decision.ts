import type { Analysis } from './analyze-context'
import type { StepFacts } from './analyze-orchestration'
import { workerSourceKey } from './source-facts'
import { type DecisionMetrics, unavailable } from './types'

/** Settled verdicts, acceptance and review effort, with a named gap wherever the store never said. */
export function measureDecision(a: Analysis, m: StepFacts): DecisionMetrics {
  const {
    src,
    gap,
    journalMissing,
    haveJournal,
    tree,
    workerCloses,
    spawnForSource,
    closeById,
    workersGapReason,
  } = a
  const {
    steerQueuedTotal,
    upLegMessages,
    queuedGapReason,
    workerEventsGapReason,
    observeThenRespawn,
    respawnWithoutEvidence,
  } = m
  // ── decision quality ───────────────────────────────────────────────────
  const settledByStatus: Record<string, number> = {}
  const settledVerdicts: Record<string, number> = {}
  for (const c of workerCloses) {
    const key = c.status ?? 'unknown'
    settledByStatus[key] = (settledByStatus[key] ?? 0) + 1
    if (c.verdict !== null) settledVerdicts[c.verdict] = (settledVerdicts[c.verdict] ?? 0) + 1
  }

  // A store with no verify step never says pass or fail. Counting its silent
  // workers as `rejected: 0 / accepted: 0` would read as "nothing was accepted".
  const verdictLimit = src.limits.workerVerdicts
  // A store that retains no delivered patch still SETTLES a verdict, and that verdict is
  // the acceptance decision it recorded. Only the split between a green verdict backed by
  // a patch and a green verdict with nothing behind it needs patch bytes, so the
  // deliverables limit takes `emptyPass` and leaves `accepted` measured.
  const deliverablesLimit = src.limits.deliverables
  let accepted = 0
  let emptyPass = 0
  let evidenceBytes = 0
  const sourceVerdicts: boolean[] = []
  for (const w of src.workers ?? []) {
    const f = tree.workerLogs.get(workerSourceKey(w))
    if (f?.finished) evidenceBytes += f.evidenceBytes
    const spawn = spawnForSource(w)
    const close = spawn === null ? null : (closeById.get(spawn.id) ?? null)
    const passed = close?.valid ?? f?.passed ?? null
    if (passed !== null) sourceVerdicts.push(passed)
    if (passed === true) {
      if (deliverablesLimit !== null || (w.patchBytes ?? f?.finishedPatchBytes ?? 0) > 0) {
        accepted += 1
      } else {
        emptyPass += 1
      }
    }
  }
  const settledCloses = workerCloses.filter((close) => close.kind === 'settled')
  const structuredVerdicts = settledCloses
    .map((close) => close.valid)
    .filter((valid): valid is boolean => valid !== null)
  const journalVerdictsComplete =
    settledCloses.length > 0 && structuredVerdicts.length === settledCloses.length
  const sourceVerdictsComplete =
    sourceVerdicts.length > 0 && sourceVerdicts.length >= settledCloses.length
  const rejected = journalVerdictsComplete
    ? structuredVerdicts.filter((valid) => !valid).length
    : sourceVerdictsComplete
      ? sourceVerdicts.filter((valid) => !valid).length
      : 0
  const rejectedLimit =
    journalVerdictsComplete || sourceVerdictsComplete
      ? null
      : settledCloses.length > 0
        ? (verdictLimit ?? 'a settled journal verdict has no validity and no matched worker log')
        : verdictLimit !== null
          ? verdictLimit
          : !haveJournal && src.workers === null
            ? workersGapReason
            : null

  const decision: DecisionMetrics = {
    settledByStatus: haveJournal ? settledByStatus : gap('settledByStatus', journalMissing),
    settledVerdicts:
      verdictLimit !== null
        ? unavailable(verdictLimit)
        : haveJournal
          ? settledVerdicts
          : unavailable(journalMissing),
    accepted:
      verdictLimit !== null
        ? gap('accepted', verdictLimit)
        : src.workers === null
          ? unavailable(workersGapReason)
          : accepted,
    rejected: rejectedLimit === null ? rejected : unavailable(rejectedLimit),
    emptyPass:
      verdictLimit !== null
        ? gap('emptyPass', verdictLimit)
        : deliverablesLimit !== null
          ? gap('emptyPass', deliverablesLimit)
          : src.workers === null
            ? unavailable(workersGapReason)
            : emptyPass,
    observeThenRespawn: haveJournal ? observeThenRespawn : unavailable(journalMissing),
    respawnWithoutEvidence: haveJournal ? respawnWithoutEvidence : unavailable(journalMissing),
    reviewActions:
      src.workers === null
        ? unavailable(workersGapReason)
        : queuedGapReason === null
          ? steerQueuedTotal + upLegMessages
          : unavailable(queuedGapReason),
    workerEvidenceBytes:
      src.workers === null
        ? unavailable(workersGapReason)
        : workerEventsGapReason === null
          ? evidenceBytes
          : unavailable(workerEventsGapReason),
  }
  return decision
}
