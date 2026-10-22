/**
 * The pure analyzer. Takes already-read bytes (`SupervisorRunSources`) and
 * returns the report — every metric derivable from a synthetic journal string
 * with no filesystem, no process, and no network. All I/O lives in a reader
 * (`reader.ts` is one).
 *
 * The metric groups live in `analyze-*.ts`; this file only runs them in the
 * order the report's `gaps` list is written.
 */

import { createAnalysis } from './analyze-context'
import { measureDecision } from './analyze-decision'
import { buildEconomics, buildPerWorker } from './analyze-economics'
import {
  buildOrchestration,
  measureConcurrency,
  measureDelegationDepth,
  measureRespawns,
  measureSteers,
  measureWall,
} from './analyze-orchestration'
import { buildOutcome } from './analyze-outcome'
import {
  buildSpend,
  collectSpendFacts,
  measureTotalUsd,
  measureWorkerTokens,
} from './analyze-spend'
import {
  SUPERVISOR_RUN_SCHEMA,
  type SupervisorRunReport,
  type SupervisorRunSources,
  unavailable,
} from './types'

/**
 * Analyze already-read supervisor-run bytes. Pure and synchronous: same bytes
 * in, same report out (modulo `generatedAt`, which `now` pins in tests).
 */
export function analyzeSupervisorRunSources(
  src: SupervisorRunSources,
  now: () => number = Date.now,
): SupervisorRunReport {
  const a = createAnalysis(src)
  const { gap, gaps, rootId, rootSpawn, journalMissing } = a
  // Measurements record their gaps as they run, so the order below is the order of `report.gaps`.
  const wall = measureWall(a)
  const steerFacts = measureSteers(a)
  const concurrency = measureConcurrency(a, wall.wallEndAt)
  const respawns = measureRespawns(a)
  const steps = {
    ...wall,
    ...steerFacts,
    ...concurrency,
    ...respawns,
    delegationDepth: measureDelegationDepth(a),
  }
  const orchestration = buildOrchestration(a, steps)
  const decision = measureDecision(a, steps)
  const spendFacts = collectSpendFacts(a)
  const tokens = measureWorkerTokens(a, spendFacts)
  const totals = measureTotalUsd(a, spendFacts)
  const spend = buildSpend(a, spendFacts, totals)
  const perWorker = buildPerWorker(a, spendFacts, totals)
  const economics = buildEconomics(a, spendFacts, totals, tokens, { decision, spend, perWorker })
  const outcome = buildOutcome(a, totals)
  return {
    schema: SUPERVISOR_RUN_SCHEMA,
    runRef: src.runRef,
    instanceId: src.instanceId,
    arm: src.arm,
    supervisorId: rootId !== null ? rootId : unavailable(journalMissing),
    supervisorProfileDigest:
      rootSpawn?.profileDigest !== null && rootSpawn?.profileDigest !== undefined
        ? rootSpawn.profileDigest
        : gap('supervisorProfileDigest', 'root spawned event has no profile digest'),
    generatedAt: new Date(now()).toISOString(),
    orchestration,
    decision,
    economics,
    outcome,
    rootWorkspaceCaptures: src.rootWorkspaceCaptures ?? null,
    gaps,
    traceCommand:
      src.traceCommand ??
      'npx --yes @tangle-network/traces@latest analyze --harness opencode --cwd <worker-clone-cwd>',
  }
}
