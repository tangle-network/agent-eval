/**
 * Synthetic supervision-tree bytes. The whole point of the analyzer's source
 * contract is that every metric is derivable from strings — no supervisor
 * process, no filesystem, no network — so the fixtures are strings.
 */

import { NO_SOURCE_LIMITS, type SupervisorRunSources, type WorkerLogSource } from './types'

export const FIXTURE_T0 = Date.parse('2026-07-23T00:00:00.000Z')

export const fixtureAt = (sec: number): string => new Date(FIXTURE_T0 + sec * 1000).toISOString()

export interface JournalPlan {
  root?: string
  /** [label, spawnSec, settleSec | null, status?] */
  workers: Array<[string, number, number | null, ('done' | 'down' | 'cancelled')?]>
  /** driver inference events: [sec, inTok, outTok, usd] */
  metered?: Array<[number, number, number, number]>
  endSec?: number
}

export function fixtureJournal(plan: JournalPlan): string {
  const root = plan.root ?? 'sup-1-test'
  const lines: string[] = [
    JSON.stringify({
      kind: 'spawned',
      id: root,
      label: 'root',
      budget: {},
      runtime: 'inline',
      seq: 0,
      at: fixtureAt(0),
    }),
  ]
  const timed: Array<{ sec: number; line: string }> = []
  plan.workers.forEach(([label, spawnSec, settleSec, status], i) => {
    const id = `${root}:s${i}`
    timed.push({
      sec: spawnSec,
      line: JSON.stringify({
        kind: 'spawned',
        id,
        parent: root,
        label,
        budget: {},
        runtime: 'inline',
        seq: i,
        at: fixtureAt(spawnSec),
      }),
    })
    if (settleSec !== null) {
      timed.push({
        sec: settleSec,
        line:
          status === 'cancelled'
            ? JSON.stringify({
                kind: 'cancelled',
                id,
                reason: 'budget',
                seq: i,
                at: fixtureAt(settleSec),
              })
            : JSON.stringify({
                kind: 'settled',
                id,
                status: status ?? 'done',
                verdict: status === 'down' ? 'no-winner' : 'winner',
                spent: { iterations: 1, tokens: { input: 100, output: 20 }, usd: 0.001, ms: 0 },
                seq: i,
                at: fixtureAt(settleSec),
              }),
      })
    }
  })
  for (const [sec, tin, tout, usd] of plan.metered ?? []) {
    timed.push({
      sec,
      line: JSON.stringify({
        kind: 'metered',
        id: root,
        spend: { iterations: 0, tokens: { input: tin, output: tout }, usd, ms: 0 },
        seq: sec,
        at: fixtureAt(sec),
      }),
    })
  }
  timed.sort((a, b) => a.sec - b.sec)
  return `${[...lines, ...timed.map((t) => t.line)].join('\n')}\n`
}

export function fixtureState(plan: {
  startSec: number
  endSec: number
  usd?: number
  verdict?: string
}): string {
  return JSON.stringify({
    id: 'sup-1-test',
    status: 'completed',
    startedAt: fixtureAt(plan.startSec),
    completedAt: fixtureAt(plan.endSec),
    verdict: plan.verdict ?? 'delivered',
    result: { delivered: true, spentTokens: 1000, spentUsd: plan.usd ?? 0.5 },
  })
}

export interface WorkerPlan {
  startSec: number
  finishSec?: number
  passed?: boolean
  patchBytes?: number
  steers?: string[]
  questions?: number
}

export function fixtureWorker(label: string, opts: WorkerPlan = { startSec: 0 }): WorkerLogSource {
  const events: string[] = [
    JSON.stringify({
      at: fixtureAt(opts.startSec),
      label,
      kind: 'started',
      cwd: `/tmp/clone-${label}`,
    }),
  ]
  const inboxLines: string[] = []
  for (const [i, msg] of (opts.steers ?? []).entries()) {
    const requestId = `req-${label}-${i}`
    inboxLines.push(
      JSON.stringify({
        id: requestId,
        at: fixtureAt(opts.startSec + 1 + i),
        source: 'brain',
        worker: label,
        message: msg,
      }),
    )
    events.push(
      JSON.stringify({
        at: fixtureAt(opts.startSec + 1 + i),
        label,
        kind: 'message',
        direction: 'down',
        source: 'brain',
        requestId,
        message: msg,
        queued: false,
        delivered: true,
      }),
    )
  }
  for (let q = 0; q < (opts.questions ?? 0); q += 1) {
    events.push(
      JSON.stringify({
        at: fixtureAt(opts.startSec + 2),
        label,
        kind: 'message',
        direction: 'up',
        text: 'which file?',
      }),
    )
  }
  if (opts.finishSec !== undefined) {
    events.push(
      JSON.stringify({
        at: fixtureAt(opts.finishSec),
        label,
        kind: 'finished',
        passed: opts.passed ?? true,
        testPassed: opts.passed ?? true,
        typecheckPassed: true,
        patchBytes: opts.patchBytes ?? 100,
        evidence: 'verify PASSED\n',
      }),
    )
  }
  return {
    label,
    events: `${events.join('\n')}\n`,
    inbox: inboxLines.length === 0 ? null : `${inboxLines.join('\n')}\n`,
    patchBytes: opts.patchBytes ?? null,
  }
}

export function fixtureSources(over: Partial<SupervisorRunSources> = {}): SupervisorRunSources {
  return {
    runRef: '/tmp/cell/runs/inst-1/ARM',
    instanceId: 'inst-1',
    arm: 'ARM',
    supRunDir: '/tmp/cell/ws/.loops/supervisor/sup-1-test',
    journal: null,
    brainLog: null,
    state: null,
    progress: null,
    workers: null,
    workersMissingReason: null,
    result: null,
    judge: null,
    judgeSource: null,
    patch: null,
    driverLog: null,
    harnessWorkerTokens: null,
    harnessMissingReason: null,
    limits: NO_SOURCE_LIMITS,
    traceCommand: null,
    ...over,
  }
}
