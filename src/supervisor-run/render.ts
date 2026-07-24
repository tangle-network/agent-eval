/**
 * Human-readable renderings of a supervisor-run report. Zero and unavailable
 * render differently on purpose (`0` vs `unavailable — <reason>`), because the
 * two have driven opposite conclusions about the same architecture.
 */

import { round } from './analyze'
import {
  isUnavailable,
  type Measured,
  type SupervisorRunReport,
  type SupervisorRunRollup,
  showMeasured,
} from './types'

/**
 * The block appended to a run log after every run — the answers an operator asks
 * for, in the log tail, with no extra command.
 */
export function renderSupervisorRunHeadline(r: SupervisorRunReport): string {
  const o = r.orchestration
  const steerNote = isUnavailable(o.steers)
    ? `unavailable — ${o.steers.unavailable}`
    : o.steers === 0
      ? '0 (spawn→wait→respawn only; no mid-task steering)'
      : `${o.steers} queued / ${showMeasured(o.steersDelivered)} delivered`
  return [
    `RUN-REPORT ${r.instanceId ?? '?'} [${r.arm ?? '?'}]`,
    `  steers=${steerNote}`,
    `  waves=${showMeasured(o.waves)} sizes=${isUnavailable(o.waveSizes) ? `unavailable — ${o.waveSizes.unavailable}` : `[${o.waveSizes.join(',')}]`}` +
      ` workers=${showMeasured(o.workersSpawned)} settled=${showMeasured(o.workersSettled)} cancelled=${showMeasured(o.workersCancelled)}`,
    `  concurrency max=${showMeasured(o.maxConcurrency)} utilization=${showMeasured(o.workerUtilization)}` +
      ` idle=${fmtMs(o.idleMs)} (${showMeasured(o.idlePct)}%) wall=${fmtMs(o.supervisorWallMs)}`,
    `  respawns=${showMeasured(o.respawns)} evidence→respawn=${showMeasured(r.decision.observeThenRespawn)}` +
      ` blind-respawn=${showMeasured(r.decision.respawnWithoutEvidence)} depth=${showMeasured(o.delegationDepth)}`,
    `  accepted=${showMeasured(r.decision.accepted)} rejected=${showMeasured(r.decision.rejected)} empty-pass=${showMeasured(r.decision.emptyPass)}`,
    `  brain=$${showMeasured(r.economics.brain.usd)} total=$${showMeasured(r.economics.totalUsd)}` +
      ` judge.resolved=${showMeasured(r.outcome.judgeResolved)} score=${showMeasured(r.outcome.judgeScore)}` +
      ` verify=${showMeasured(r.outcome.verifyPass)}`,
    r.gaps.length > 0 ? `  gaps(${r.gaps.length}): ${r.gaps.join('; ')}` : '  gaps: none',
  ].join('\n')
}

function fmtMs(v: Measured<number>): string {
  if (isUnavailable(v)) return `unavailable — ${v.unavailable}`
  if (v < 1000) return `${v}ms`
  const s = v / 1000
  if (s < 120) return `${round(s, 1)}s`
  return `${round(s / 60, 1)}min`
}

export function renderSupervisorRunMarkdown(r: SupervisorRunReport): string {
  const o = r.orchestration
  const d = r.decision
  const e = r.economics
  const out: string[] = []
  out.push(`# Run report — ${r.instanceId ?? 'unknown instance'} [${r.arm ?? 'unknown arm'}]`)
  out.push('')
  out.push('```')
  out.push(renderSupervisorRunHeadline(r))
  out.push('```')
  out.push('')
  out.push(`- Run: \`${r.runRef}\``)
  out.push(`- Supervisor: \`${showMeasured(r.supervisorId)}\``)
  out.push(`- Generated: ${r.generatedAt}`)
  out.push('')

  out.push('## Orchestration')
  out.push('')
  out.push('| Metric | Value |')
  out.push('|---|---|')
  out.push(`| Workers spawned | ${showMeasured(o.workersSpawned)} |`)
  out.push(`| Workers settled | ${showMeasured(o.workersSettled)} |`)
  out.push(`| Workers cancelled | ${showMeasured(o.workersCancelled)} |`)
  out.push(`| **Steers (mid-task messages to live workers)** | **${showMeasured(o.steers)}** |`)
  out.push(`| Steers delivered | ${showMeasured(o.steersDelivered)} |`)
  out.push(`| Outer-driver \`supervisor_steer\` calls | ${showMeasured(o.driverSteerCalls)} |`)
  out.push(`| Spawn waves | ${showMeasured(o.waves)} |`)
  out.push(
    `| Wave sizes | ${isUnavailable(o.waveSizes) ? showMeasured(o.waveSizes) : `[${o.waveSizes.join(', ')}]`} |`,
  )
  out.push(`| Max concurrency | ${showMeasured(o.maxConcurrency)} |`)
  out.push(`| Respawns (spawns after first settle) | ${showMeasured(o.respawns)} |`)
  out.push(
    `| Repeated labels | ${isUnavailable(o.repeatedLabels) ? showMeasured(o.repeatedLabels) : o.repeatedLabels.length === 0 ? 'none' : o.repeatedLabels.join(', ')} |`,
  )
  out.push(`| Delegation depth | ${showMeasured(o.delegationDepth)} |`)
  out.push(`| Time to first spawn | ${fmtMs(o.timeToFirstSpawnMs)} |`)
  out.push(`| Supervisor wall | ${fmtMs(o.supervisorWallMs)} |`)
  out.push(`| Idle (zero live workers) | ${fmtMs(o.idleMs)} (${showMeasured(o.idlePct)}%) |`)
  out.push(
    `| Worker utilization (Σ worker wall ÷ supervisor wall) | ${showMeasured(o.workerUtilization)} |`,
  )
  out.push('')

  if (!isUnavailable(o.steersByWorker) && o.steersByWorker.length > 0) {
    out.push('### Steers per worker')
    out.push('')
    out.push('| Worker | Queued | Delivered |')
    out.push('|---|---:|---:|')
    for (const s of o.steersByWorker) out.push(`| \`${s.worker}\` | ${s.queued} | ${s.delivered} |`)
    out.push('')
  } else if (isUnavailable(o.steersByWorker)) {
    out.push(`### Steers per worker\n\nunavailable — ${o.steersByWorker.unavailable}\n`)
  }

  out.push('## Decision quality')
  out.push('')
  out.push('| Metric | Value |')
  out.push('|---|---|')
  out.push(`| Settled by status | ${fmtCounts(d.settledByStatus)} |`)
  out.push(`| Settled verdicts | ${fmtCounts(d.settledVerdicts)} |`)
  out.push(`| Accepted (verify green + patch bytes) | ${showMeasured(d.accepted)} |`)
  out.push(`| Rejected (verify red) | ${showMeasured(d.rejected)} |`)
  out.push(`| Empty pass (green, no patch) | ${showMeasured(d.emptyPass)} |`)
  out.push(`| Evidence → respawn sequences | ${showMeasured(d.observeThenRespawn)} |`)
  out.push(
    `| Respawn with no settled evidence in front | ${showMeasured(d.respawnWithoutEvidence)} |`,
  )
  out.push(`| Review actions (steers + worker questions) | ${showMeasured(d.reviewActions)} |`)
  out.push(
    `| Worker evidence returned | ${isUnavailable(d.workerEvidenceBytes) ? showMeasured(d.workerEvidenceBytes) : `${d.workerEvidenceBytes} bytes`} |`,
  )
  out.push('')

  out.push('## Economics')
  out.push('')
  out.push('| Role | Tokens in | Tokens out | Cache read | Cache write | USD | Source |')
  out.push('|---|---:|---:|---:|---:|---:|---|')
  out.push(
    `| brain | ${showMeasured(e.brain.tokensIn)} | ${showMeasured(e.brain.tokensOut)} | ${showMeasured(e.brain.cacheRead)} | ${showMeasured(e.brain.cacheWrite)} | ${showMeasured(e.brain.usd)} | ${e.brain.source} |`,
  )
  out.push(
    `| workers | ${showMeasured(e.workers.tokensIn)} | ${showMeasured(e.workers.tokensOut)} | ${showMeasured(e.workers.cacheRead)} | ${showMeasured(e.workers.cacheWrite)} | ${showMeasured(e.workers.usd)} | ${e.workers.source} |`,
  )
  out.push('')
  if (!isUnavailable(e.brainTruncations) && e.brainTruncations > 0) {
    out.push(
      `- **BRAIN OUTPUT TRUNCATED: ${e.brainTruncations} completion(s) hit \`finish_reason: "length"\`** — the supervisor ` +
        'acted on a half-written plan. Its output ceiling is too low; see `brain.jsonl` for the per-call `req_max_tokens`.',
    )
  } else {
    out.push(
      `- Brain completions truncated (finish_reason=length): ${showMeasured(e.brainTruncations)}`,
    )
  }
  out.push(`- Total USD: ${showMeasured(e.totalUsd)} (source: ${e.totalUsdSource})`)
  out.push(`- Cost per accepted patch: ${showMeasured(e.costPerAcceptedPatchUsd)}`)
  if (isUnavailable(e.workerWallMsDistribution)) {
    out.push(`- Worker wall distribution: unavailable — ${e.workerWallMsDistribution.unavailable}`)
  } else {
    const w = e.workerWallMsDistribution
    out.push(
      `- Worker wall (n=${w.n}): min ${fmtMs(w.min)} / p50 ${fmtMs(w.p50)} / p90 ${fmtMs(w.p90)} / max ${fmtMs(w.max)} / Σ ${fmtMs(w.sum)}`,
    )
  }
  out.push('')
  if (!isUnavailable(e.perWorker) && e.perWorker.length > 0) {
    out.push('| Worker | Wall | Tokens in | Tokens out | Patch bytes | Verify passed |')
    out.push('|---|---:|---:|---:|---:|---|')
    for (const w of e.perWorker) {
      out.push(
        `| \`${w.worker}\` | ${w.wallMs === null ? 'unavailable — no start/finish pair' : fmtMs(w.wallMs)} | ${w.tokensIn ?? 'unavailable — store does not attribute tokens per worker'} | ${w.tokensOut ?? 'unavailable — store does not attribute tokens per worker'} | ${w.patchBytes ?? 'unavailable — no worker patch file'} | ${w.passed === null ? 'unavailable — no finished event' : String(w.passed)} |`,
      )
    }
    out.push('')
  }

  out.push('## Outcome')
  out.push('')
  out.push('| Metric | Value |')
  out.push('|---|---|')
  out.push(`| Supervisor status | ${showMeasured(r.outcome.supStatus)} |`)
  out.push(`| Supervisor verdict | ${showMeasured(r.outcome.supVerdict)} |`)
  out.push(`| Delivered | ${showMeasured(r.outcome.delivered)} |`)
  out.push(`| Judge resolved | ${showMeasured(r.outcome.judgeResolved)} |`)
  out.push(`| Judge score | ${showMeasured(r.outcome.judgeScore)} |`)
  out.push(
    `| Judge passed / total | ${showMeasured(r.outcome.judgePassed)} / ${showMeasured(r.outcome.judgeTotal)} |`,
  )
  out.push(
    `| Judge source | ${r.outcome.judgeSource ?? 'unavailable — no judge.json and no ledger row'} |`,
  )
  out.push(
    `| Verify gate | pass=${showMeasured(r.outcome.verifyPass)} rc=${showMeasured(r.outcome.verifyRc)} |`,
  )
  if (isUnavailable(r.outcome.patch)) {
    out.push(`| Patch | unavailable — ${r.outcome.patch.unavailable} |`)
  } else {
    const p = r.outcome.patch
    out.push(
      `| Patch | ${p.files} file(s), +${p.linesAdded}/-${p.linesRemoved}, test files touched: ${p.testFilesTouched.length === 0 ? 'none' : p.testFilesTouched.join(', ')} |`,
    )
  }
  out.push('')
  out.push('## Gaps')
  out.push('')
  if (r.gaps.length === 0) out.push('None — every metric above is backed by a present artifact.')
  else for (const g of r.gaps) out.push(`- ${g}`)
  out.push('')
  out.push(
    `> Harness-session view of the same run (model calls, stuck loops, tool errors): \`${r.traceCommand}\``,
  )
  out.push('')
  return out.join('\n')
}

function fmtCounts(v: Measured<Record<string, number>>): string {
  if (isUnavailable(v)) return showMeasured(v as unknown as Measured<string>)
  const entries = Object.entries(v)
  return entries.length === 0 ? 'none' : entries.map(([k, n]) => `${k}=${n}`).join(', ')
}

export function renderSupervisorRollupMarkdown(
  rollup: SupervisorRunRollup,
  title = 'Round rollup',
): string {
  const out: string[] = []
  out.push(`# ${title}`)
  out.push('')
  out.push(`- Cells: ${rollup.cells}`)
  out.push(
    `- **Steers across all cells: ${showMeasured(rollup.steersTotal)}** (cells with ≥1 steer: ${showMeasured(rollup.cellsWithSteers)}; cells where the steer count is unavailable: ${rollup.cellsWithUnavailableSteers})`,
  )
  out.push(`- Waves per cell (mean): ${showMeasured(rollup.wavesMean)}`)
  out.push(`- Max concurrency observed: ${showMeasured(rollup.maxConcurrencyMax)}`)
  out.push(`- Worker utilization (mean): ${showMeasured(rollup.utilizationMean)}`)
  out.push(`- Idle share (mean): ${showMeasured(rollup.idlePctMean)}%`)
  out.push(
    `- Workers spawned: ${showMeasured(rollup.workersSpawnedTotal)} · accepted: ${showMeasured(rollup.acceptedTotal)}`,
  )
  out.push(
    `- Spend: $${showMeasured(rollup.usdTotal)} · judged resolved: ${showMeasured(rollup.resolvedCount)}/${rollup.cells}`,
  )
  out.push('')
  out.push('| Instance | Arm | Steers | Waves | Utilization | Idle % | Resolved | USD |')
  out.push('|---|---|---:|---:|---:|---:|---|---:|')
  for (const c of rollup.perCell) {
    out.push(
      `| ${c.instanceId ?? '?'} | ${c.arm ?? '?'} | ${showMeasured(c.steers)} | ${showMeasured(c.waves)} | ${showMeasured(c.utilization)} | ${showMeasured(c.idlePct)} | ${showMeasured(c.resolved)} | ${showMeasured(c.usd)} |`,
    )
  }
  out.push('')
  return out.join('\n')
}
