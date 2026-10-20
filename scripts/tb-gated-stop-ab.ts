/**
 * Gated stop against blind continuation, at one matched token budget.
 *
 * The question: when an agent may stop only after an executable held-out check
 * passes, does a fixed total token budget finish more tasks than the same
 * budget spent on unconditional continuation? The mechanism under test is
 * budget ALLOCATION, not detection — a row that the check clears early returns
 * its unspent budget to the pool, and the pool pays for extra steps on rows
 * that have not cleared.
 *
 * Two arms, one policy, one grader:
 *
 *   blind-continue   resumes the recorded prefix and spends its whole per-row
 *                    allotment whatever the check says. Graded at its BEST
 *                    intermediate state, so it cannot lose a pass it reached
 *                    and then walked out of.
 *   gated-continue   resumes the same prefix under the same policy and stops
 *                    the moment the check passes. What it did not spend is
 *                    reallocated to rows still failing, until its realized
 *                    tokens match the blind arm.
 *
 * Both arms grade after every step with the task's own held-out suite,
 * injected from outside the container and purged after. The check that gates
 * the treatment arm is the same check that scores both, which is the strongest
 * form of the gate and the reason the blind arm is graded at its best
 * intermediate state rather than its last one.
 *
 * Every rule that decides anything is registered before a row is graded:
 * `sealExperiment` hashes the arms, the admission funnel, the estimand, the
 * interval, the matched-budget tolerance and the decision rule into one
 * digest, and `openSealedExperiment` is the only path that executes them.
 * The power floor is a registered gate, so a structure that cannot see the
 * effect refuses the spend instead of producing an interval nobody can read.
 *
 * The confirmatory draw is chosen on the power curve, not on appetite: the
 * admitted set is the ceiling, and `settlingDraw` returns the smallest draw
 * that clears the registered target at the settling effect.
 *
 * `confirm` evaluates the registered identity gate before it grades a row. A
 * seat that answers the pinned model id with another model aborts the run at
 * zero spend, because a contrast measured on a substituted model belongs to an
 * experiment nobody registered.
 *
 *   node --import tsx scripts/tb-gated-stop-ab.ts design [--take N]
 *   node --import tsx scripts/tb-gated-stop-ab.ts screen
 *   node --import tsx scripts/tb-gated-stop-ab.ts pilot --rows 6 --steps 8
 *   node --import tsx scripts/tb-gated-stop-ab.ts confirm
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { clusteredPower, type EvidenceRecord, openSealedExperiment, sealExperiment } from '../src/experiment'
import { WORK, MODEL, SEAT_CONCURRENCY, COST_CEILING_USD, STEP_ALLOTMENT } from './tb-gated-stop/settings'
import { type EndStateMeasurement, endStateScreen, pilotExposedRowIds } from './tb-gated-stop/corpus'
import { REGISTERED_EFFECT_GRID, POWER_TARGET, POWER_SIM, SETTLING_EFFECT, settlingDraw, buildSpec, prepare } from './tb-gated-stop/design'
import { run, type TaskFixture, loadTask } from './tb-gated-stop/container'
import { callModel } from './tb-gated-stop/model'
import { type RowRun, runRow } from './tb-gated-stop/row'
import { logger } from './tb-gated-stop/log'

export type { SettlingDraw } from './tb-gated-stop/design'
async function main(): Promise<void> {
  const mode = process.argv[2] ?? 'design'
  mkdirSync(WORK, { recursive: true })
  const design = prepare(mode === 'screen')
  // Rows the mechanism pilot ran on. They are registered as excluded so a
  // later confirmatory run meets its rows unexposed.
  const exposed = pilotExposedRowIds(design.records.map((record) => String(record.rowId)))

  // The draw runs through the registered rules before the registration that
  // pins it: a draft seal executes the admission funnel and the selection, and
  // the final seal carries the ids they produced. Re-running `select` against
  // the sealed subset below is what proves the two agree.
  const draft = await openSealedExperiment(
    await sealExperiment(buildSpec(design.certifiedTasks, [], design.take, exposed)),
  )
  const admitted = draft.admit(design.records)
  const admittedDraw = draft.select('confirmatory', admitted.survivors, { idField: 'rowId' })

  // The admitted set is the ceiling, not the draw. The row count is chosen on
  // the power curve: the smallest draw that clears the registered target at
  // the settling effect.
  const byTask = new Map<string, string[]>()
  for (const id of admittedDraw) {
    const task = id.split('::')[0]!
    byTask.set(task, [...(byTask.get(task) ?? []), id])
  }
  const admittedClusters = [...byTask.entries()].map(([taskName, rowIds]) => ({ taskName, rowIds }))
  const settling = settlingDraw(admittedClusters, admittedDraw.length)
  const takeArg = process.argv.indexOf('--take')
  const take = takeArg > 0 ? Number(process.argv[takeArg + 1]) : settling.rows

  const sized = await openSealedExperiment(
    await sealExperiment(buildSpec(design.certifiedTasks, [], take, exposed)),
  )
  const drawn = sized.select('confirmatory', admitted.survivors, { idField: 'rowId' })

  const sealed = await sealExperiment(buildSpec(design.certifiedTasks, drawn, take, exposed))
  const registered = await openSealedExperiment(sealed)
  const redrawn = registered.select('confirmatory', registered.admit(design.records).survivors, {
    idField: 'rowId',
  })
  if (redrawn.join('|') !== drawn.join('|')) {
    throw new Error('the sealed subset does not reproduce from the sealed selection rule')
  }

  const byRowId = new Map(design.rows.map((row) => [row.rowId, row]))
  const chosen = drawn.map((id) => byRowId.get(id)!)
  const clusters = [...new Set(chosen.map((row) => row.taskName))].sort().map((taskName) => ({
    taskName,
    rowIds: chosen.filter((row) => row.taskName === taskName).map((row) => row.rowId),
  }))
  const power = clusteredPower({
    clusterSizes: clusters.map((cluster) => cluster.rowIds.length),
    effects: [...REGISTERED_EFFECT_GRID],
    minimumEffect: SETTLING_EFFECT,
    seed: POWER_SIM.seed,
    trials: POWER_SIM.trials,
    resamples: POWER_SIM.resamples,
    targetPower: POWER_TARGET,
    baseWinRate: 0.05,
    baseLossRate: 0.05,
  })
  const powerGate = registered.gate('powerFloor', {
    kind: 'power-floor',
    curve: power.curve.map((point) => ({ effect: point.effect, power: point.power })),
  })
  const halt = registered.halt([powerGate])

  // The digest this draw replaces, read from the checked-in design so the
  // report carries the chain rather than a single current hash.
  const previousSealDigest = ((): string | null => {
    try {
      const held = JSON.parse(
        readFileSync(join(import.meta.dirname, '..', 'benchmarks', 'trace-repair', 'gated-stop-ab', 'design.json'), 'utf8'),
      ) as { sealDigest?: string }
      return held.sealDigest ?? null
    } catch {
      return null
    }
  })()

  const designReport = {
    generatedAt: new Date().toISOString(),
    previousSealDigest,
    sealDigest: sealed.digest,
    sealedAt: sealed.sealedAt,
    admittedRows: admittedDraw.length,
    clusters,
    clusterCount: clusters.length,
    rowCount: chosen.length,
    funnel: admitted.funnel,
    registeredEffectGrid: REGISTERED_EFFECT_GRID,
    power,
    powerGate,
    halt,
    settlingN: settling,
  }
  writeFileSync(join(WORK, 'design.json'), `${JSON.stringify(designReport, null, 2)}\n`)
  process.stdout.write(
    `previousSeal=${previousSealDigest ?? 'none'}\nseal=${sealed.digest}\n` +
      `clusters=${clusters.length} rows=${chosen.length} (admitted ${admittedDraw.length})\n` +
      `funnel: ${admitted.funnel.input} -> ${admitted.funnel.surviving} admitted -> ${chosen.length} drawn\n` +
      `settling: rows=${settling.rows} power@${settling.effect}=${settling.power.toFixed(4)} registeredSim=${settling.powerAtRegisteredSim.toFixed(4)} ` +
      `(ceiling rows=${settling.maxRows} power=${settling.maxPower.toFixed(4)})\n` +
      `power: ${power.curve.map((p) => `${p.effect}=>${p.power.toFixed(2)}`).join(' ')}\n` +
      `gate powerFloor passed=${powerGate.passed}; halt fired=${halt.fired} action=${halt.action ?? 'none'}\n`,
  )

  if (mode === 'design') return

  if (mode === 'screen') {
    // The end-state screen: replay each admitted row and grade the state the
    // recording ended on. A row whose own suite already passes there cannot
    // measure a repair, so the registered funnel drops it. No model call.
    const log = logger(join(WORK, 'screen.log'))
    // A row already screened keeps its measured verdict. The screen opens a
    // container per row and the corpus is hundreds of rows long, so a run that
    // restarted from zero after an interruption would pay for the whole set
    // again and could not be resumed at all.
    const measured = endStateScreen()
    const rows = admitted.survivors
      .map((record) => byRowId.get(String(record.rowId))!)
      .filter((row) => measured[row.rowId] === undefined)
    log(`screen start rows=${rows.length} alreadyMeasured=${Object.keys(measured).length}`)
    const tasks = new Map<string, TaskFixture>()
    for (const name of new Set(rows.map((row) => row.taskName))) tasks.set(name, await loadTask(name))
    const screened: Record<string, EndStateMeasurement> = { ...endStateScreen() }
    let next = 0
    await Promise.all(
      Array.from({ length: Math.min(SEAT_CONCURRENCY, rows.length) }, async () => {
        for (;;) {
          const index = next
          next += 1
          if (index >= rows.length) return
          const row = rows[index]!
          const result = await runRow({
            row,
            task: tasks.get(row.taskName)!,
            arm: 'end-state-screen',
            allotment: 0,
            stopOnPass: false,
            log,
          })
          // A row whose screen hit a boundary failure produced no verdict.
          // Writing its default `false` would admit it on a check that never
          // ran, which is the same corruption as a silent zero.
          if (result.error === null) {
            screened[row.rowId] = {
              endStatePassed: result.endStatePassed,
              replayedCommands: result.replayedCommands,
              replayDivergences: result.replayDivergences,
            }
            writeFileSync(join(WORK, 'end-state-screen.json'), `${JSON.stringify(screened, null, 2)}\n`)
          }
        }
      }),
    )
    const passing = Object.values(screened).filter((m) => m.endStatePassed).length
    log(`screen done rows=${rows.length} endStatePassed=${passing}`)
    return
  }

  if (mode === 'pilot') {
    // A pilot measures the mechanism's INPUT — how often a row clears the check
    // at all, and at which step — so the effect the confirmatory design would
    // need to see is estimated from data instead of assumed. It is not the
    // sealed contrast and never enters it.
    const rowsArg = Number(process.argv[process.argv.indexOf('--rows') + 1] ?? '6')
    const stepsArg = Number(process.argv[process.argv.indexOf('--steps') + 1] ?? String(STEP_ALLOTMENT))
    const log = logger(join(WORK, 'pilot.log'))
    // Rows the funnel admitted but the sealed draw did not take. The sealed 16
    // stay unexposed, so a later confirmatory run at a larger n still meets
    // them fresh.
    const drawnIds = new Set(drawn)
    const spare = admitted.survivors
      .map((record) => byRowId.get(String(record.rowId))!)
      .filter((row) => row !== undefined && !drawnIds.has(row.rowId))
      .sort((a, b) => a.rowId.localeCompare(b.rowId))
    const rows = spare.slice(0, rowsArg)
    if (rows.length < rowsArg) {
      log(`only ${rows.length} unsealed rows available; the pilot runs on those and never on the sealed draw`)
    }
    const tasks = new Map<string, TaskFixture>()
    for (const name of new Set(rows.map((r) => r.taskName))) tasks.set(name, await loadTask(name))
    log(`pilot rows=${rows.length} steps=${stepsArg} seal=${sealed.digest}`)
    const outPath = join(WORK, process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1]! : 'pilot.json')
    const results: RowRun[] = []
    let spent = 0
    let next = 0
    // Three rows at a time: the seat allows three calls in flight, so a fourth
    // row would only queue behind the same limiter and hold a container open.
    await Promise.all(
      Array.from({ length: Math.min(SEAT_CONCURRENCY, rows.length) }, async () => {
        for (;;) {
          const index = next
          next += 1
          if (index >= rows.length) return
          if (spent > COST_CEILING_USD) {
            log(`cost ceiling ${COST_CEILING_USD} reached, stopping`)
            return
          }
          const row = rows[index]!
          const result = await runRow({
            row,
            task: tasks.get(row.taskName)!,
            arm: 'pilot-blind-continue',
            allotment: stepsArg,
            stopOnPass: false,
            log,
          })
          spent += result.costUsd
          results.push(result)
          writeFileSync(outPath, `${JSON.stringify({ sealDigest: sealed.digest, stepAllotment: stepsArg, results }, null, 2)}\n`)
        }
      }),
    )
    log(`pilot done rows=${results.length} spentUsd=${spent.toFixed(4)}`)
    return
  }

  if (mode === 'confirm') {
    const log = logger(join(WORK, 'confirm.log'))

    // The registered halt runs before a token is spent. A draw that fails the
    // power floor records `refuse-spend` in design.json; opening spend anyway
    // would run an experiment the registration refused.
    if (halt.fired) {
      const refusal = {
        generatedAt: new Date().toISOString(),
        sealDigest: sealed.digest,
        halt,
        powerGate,
        onFail: 'refuse-spend',
        spentUsd: 0,
        rowsGraded: 0,
        note:
          'The registered halt fired on the power floor before any row was run. No arm was ' +
          'started and no token was spent. The refusal is the verdict object for this draw.',
      }
      writeFileSync(join(WORK, 'confirm-refusal.json'), `${JSON.stringify(refusal, null, 2)}\n`)
      process.stdout.write(
        `REFUSE-SPEND powerFloor: halt fired for gates [${halt.failedGates.join(', ')}]; no spend, no rows graded\n`,
      )
      process.exitCode = 4
      return
    }

    // The identity gate runs before a row is graded and before a token is
    // spent. A seat that answers the pinned id with another model produces a
    // contrast for a model nobody registered, so the registered action here is
    // to abort rather than to record the substitution and continue.
    const probe = await callModel([{ role: 'user', content: 'reply with the single word ok' }])
    const identity = registered.gate('servedModel', {
      kind: 'identity',
      pinned: MODEL,
      served: probe.servedModel,
    })
    log(`servedModel gate: pinned=${MODEL} served=${probe.servedModel} passed=${identity.passed}`)
    if (!identity.passed) {
      const refusal = {
        generatedAt: new Date().toISOString(),
        sealDigest: sealed.digest,
        gate: identity,
        onFail: 'abort',
        spentUsd: 0,
        rowsGraded: 0,
        note:
          'The seat answered the pinned model id with a different model. No row was graded and no ' +
          'arm was run. The contrast is not refused on its statistics; it was never started.',
      }
      writeFileSync(join(WORK, 'confirm-refusal.json'), `${JSON.stringify(refusal, null, 2)}\n`)
      process.stdout.write(
        `ABORT servedModel: pinned=${MODEL} served=${probe.servedModel}; no spend, no rows graded\n`,
      )
      process.exitCode = 3
      return
    }

    const rows = chosen
    const tasks = new Map<string, TaskFixture>()
    for (const name of new Set(rows.map((row) => row.taskName))) tasks.set(name, await loadTask(name))

    // Runs persist as they finish. A transport fault hours in must not force a
    // re-spend of everything before it.
    const statePath = join(WORK, 'confirm-runs.json')
    const held: Record<string, RowRun> = (() => {
      try {
        return JSON.parse(readFileSync(statePath, 'utf8')) as Record<string, RowRun>
      } catch {
        return {}
      }
    })()
    const persist = (): void => writeFileSync(statePath, `${JSON.stringify(held, null, 2)}\n`)
    const spent = (): number => Object.values(held).reduce((total, run) => total + run.costUsd, 0)

    // ── Arm B: blind continuation, the whole allotment, whatever the check says.
    let next = 0
    await Promise.all(
      Array.from({ length: Math.min(SEAT_CONCURRENCY, rows.length) }, async () => {
        for (;;) {
          const index = next
          next += 1
          if (index >= rows.length) return
          const row = rows[index]!
          const key = `blind-continue::${row.rowId}`
          if (held[key] !== undefined) continue
          if (spent() > COST_CEILING_USD) {
            log(`cost ceiling ${COST_CEILING_USD} reached in blind-continue`)
            return
          }
          held[key] = await runRow({
            row,
            task: tasks.get(row.taskName)!,
            arm: 'blind-continue',
            allotment: STEP_ALLOTMENT,
            stopOnPass: false,
            log,
          })
          persist()
        }
      }),
    )

    // ── Arm C: gated continuation, one row at a time in the registered order.
    //
    // A row that clears the check early returns the rest of its entitlement to
    // a pool, and the pool pays for extra steps on rows still failing. The
    // entitlement is what the blind arm actually spent on the same row, so the
    // arms are matched on realized tokens rather than on steps.
    let pool = 0
    for (const row of rows) {
      const control = held[`blind-continue::${row.rowId}`]
      if (control === undefined) continue
      const key = `gated-continue::${row.rowId}`
      if (held[key] !== undefined) {
        pool += control.promptTokens + control.completionTokens - (held[key]!.promptTokens + held[key]!.completionTokens)
        continue
      }
      if (spent() > COST_CEILING_USD) {
        log(`cost ceiling ${COST_CEILING_USD} reached in gated-continue`)
        break
      }
      const entitlement = control.promptTokens + control.completionTokens
      const perStep = entitlement / Math.max(1, control.steps.length)
      const extra = perStep > 0 ? Math.max(0, Math.floor(pool / perStep)) : 0
      const result = await runRow({
        row,
        task: tasks.get(row.taskName)!,
        arm: 'gated-continue',
        allotment: STEP_ALLOTMENT + extra,
        stopOnPass: true,
        log,
      })
      held[key] = result
      pool += entitlement - (result.promptTokens + result.completionTokens)
      log(`${row.rowId} gated extra=${extra} pool=${Math.round(pool)}`)
      persist()
    }

    // ── The registered contrast. The estimand reads `passed` as a number,
    // so the boolean verdict is written as 1 or 0 here.
    const armRows = (arm: string, passedOf: (run: RowRun) => boolean): EvidenceRecord[] =>
      rows
        .map((row) => held[`${arm}::${row.rowId}`])
        .filter((run): run is RowRun => run !== undefined)
        .map((run) => ({
          rowId: run.rowId,
          taskName: run.taskName,
          arm: arm === 'blind-continue' ? 'blind-continue' : 'gated-continue',
          passed: passedOf(run) ? 1 : 0,
        }))
    const finalPassed = (run: RowRun): boolean => run.steps.at(-1)?.gradePassed === true
    const treatment = armRows('gated-continue', (run) => run.bestPassed)

    const contrasts: Record<string, unknown> = {}
    for (const [label, controlPassed] of [
      ['C-vs-B-best', (run: RowRun) => run.bestPassed],
      ['C-vs-B-final', finalPassed],
    ] as const) {
      const evidence = [...armRows('blind-continue', controlPassed), ...treatment]
      const byPair = new Map<string, EvidenceRecord[]>()
      for (const row of evidence) {
        const rowId = String(row.rowId)
        const pair = byPair.get(rowId) ?? []
        pair.push(row)
        byPair.set(rowId, pair)
      }
      const differences = [...byPair].map(([rowId, pair]) => ({
        rowId,
        taskName: pair[0]!.taskName,
        diff: registered.estimate('pairedContrast', pair).value,
      }))
      contrasts[label] = {
        estimand: registered.estimate('pairedContrast', evidence),
        interval: registered.interval('pairedContrast95', { kind: 'rows', rows: differences }),
      }
    }

    const realized = (arm: string): number =>
      rows
        .map((row) => held[`${arm}::${row.rowId}`])
        .filter((run): run is RowRun => run !== undefined)
        .reduce((total, run) => total + run.promptTokens + run.completionTokens, 0)
    const budgets = registered.matchedBudgets([
      { armId: 'blind-continue', realizedTokens: realized('blind-continue') },
      { armId: 'gated-continue', realizedTokens: realized('gated-continue') },
    ])

    const servedModels = [...new Set(Object.values(held).flatMap((run) => run.steps.map((s) => s.servedModel)))]
    const report = {
      generatedAt: new Date().toISOString(),
      sealDigest: sealed.digest,
      previousSealDigest,
      rows: rows.length,
      clusters: clusters.length,
      servedModels,
      contrasts,
      budgets,
      costUsd: spent(),
      settlingN: settling,
    }
    writeFileSync(join(WORK, 'confirm-report.json'), `${JSON.stringify(report, null, 2)}\n`)
    log(`confirm done rows=${rows.length} costUsd=${spent().toFixed(4)} matched=${budgets.matched}`)
    return
  }

  throw new Error(`unknown mode '${mode}'`)
}

main().catch((error) => {
  process.stderr.write(`${(error as Error).stack}\n`)
  process.exit(1)
})
