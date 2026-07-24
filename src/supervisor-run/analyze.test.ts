import { describe, expect, it } from 'vitest'
import { analyzeSupervisorRunSources, parsePatch, rollupSupervisorRuns } from './analyze'
import {
  fixtureJournal as journal,
  fixtureSources as sources,
  fixtureState as state,
  fixtureWorker as worker,
} from './fixtures'
import {
  renderSupervisorRollupMarkdown,
  renderSupervisorRunHeadline,
  renderSupervisorRunMarkdown,
} from './render'
import { isUnavailable } from './types'

const analyze = analyzeSupervisorRunSources

describe('analyzeSupervisorRun — steers present', () => {
  const src = sources({
    journal: journal({
      workers: [
        ['fix-a', 10, 200],
        ['fix-b', 12, 300],
      ],
      metered: [[5, 1000, 100, 0.01]],
    }),
    state: state({ startSec: 0, endSec: 400 }),
    workers: [
      worker('w-0', {
        startSec: 10,
        finishSec: 200,
        passed: true,
        patchBytes: 500,
        steers: ['narrow the fix', 'add a test'],
      }),
      worker('w-1', {
        startSec: 12,
        finishSec: 300,
        passed: false,
        patchBytes: 0,
        steers: ['try the other module'],
        questions: 1,
      }),
    ],
  })
  const r = analyze(src)

  it('counts steers per worker and in total', () => {
    expect(r.orchestration.steers).toBe(3)
    expect(r.orchestration.steersDelivered).toBe(3)
    expect(r.orchestration.steersByWorker).toEqual([
      { worker: 'w-0', queued: 2, delivered: 2 },
      { worker: 'w-1', queued: 1, delivered: 1 },
    ])
  })

  it('counts worker questions as review traffic alongside steers', () => {
    expect(r.decision.reviewActions).toBe(4)
  })

  it('renders the steer count without the "no steering" note', () => {
    expect(renderSupervisorRunHeadline(r)).toContain('steers=3 queued / 3 delivered')
  })
})

describe('analyzeSupervisorRun — steers absent is a ZERO, not an unavailable', () => {
  const src = sources({
    journal: journal({
      workers: [
        ['a', 10, 100],
        ['b', 120, 200],
      ],
      metered: [[5, 500, 50, 0.005]],
    }),
    state: state({ startSec: 0, endSec: 300 }),
    workers: [
      worker('w-0', { startSec: 10, finishSec: 100 }),
      worker('w-1', { startSec: 120, finishSec: 200 }),
    ],
  })
  const r = analyze(src)

  it('reports 0 steers, not unavailable', () => {
    expect(r.orchestration.steers).toBe(0)
    expect(isUnavailable(r.orchestration.steers)).toBe(false)
  })

  it('says so explicitly in the headline', () => {
    expect(renderSupervisorRunHeadline(r)).toContain(
      'steers=0 (spawn→wait→respawn only; no mid-task steering)',
    )
  })

  it('records no gap for a real zero', () => {
    expect(r.gaps.join('|')).not.toContain('steers')
  })
})

describe('analyzeSupervisorRun — missing artifacts become unavailable, never zero', () => {
  it('marks steers unavailable when the workers dir is missing', () => {
    const r = analyze(
      sources({
        journal: journal({ workers: [['a', 10, 100]] }),
        state: state({ startSec: 0, endSec: 200 }),
        workers: null,
        workersMissingReason: 'workers/ directory absent under /tmp/sup',
      }),
    )
    expect(isUnavailable(r.orchestration.steers)).toBe(true)
    expect(r.orchestration.steers).toEqual({
      unavailable: 'workers/ directory absent under /tmp/sup',
    })
    expect(renderSupervisorRunHeadline(r)).toContain(
      'steers=unavailable — workers/ directory absent under /tmp/sup',
    )
    expect(r.gaps.some((g) => g.startsWith('steers:'))).toBe(true)
  })

  it('marks the whole orchestration block unavailable with no journal', () => {
    const r = analyze(sources({ supRunDir: null }))
    for (const v of [
      r.orchestration.workersSpawned,
      r.orchestration.waves,
      r.orchestration.maxConcurrency,
      r.orchestration.supervisorWallMs,
      r.orchestration.workerUtilization,
      r.economics.brain.tokensIn,
    ]) {
      expect(isUnavailable(v)).toBe(true)
    }
    expect(r.gaps.length).toBeGreaterThan(0)
  })

  it('marks judge fields unavailable without judge.json', () => {
    const r = analyze(sources({ journal: journal({ workers: [['a', 1, 2]] }) }))
    expect(isUnavailable(r.outcome.judgeResolved)).toBe(true)
    expect(r.outcome.judgeSource).toBeNull()
  })

  it('marks the patch unavailable when the patch file is missing', () => {
    const r = analyze(sources({ journal: journal({ workers: [] }) }))
    expect(isUnavailable(r.outcome.patch)).toBe(true)
  })

  it('renders unavailable and zero differently in markdown', () => {
    const zero = analyze(
      sources({
        journal: journal({ workers: [['a', 1, 2]] }),
        state: state({ startSec: 0, endSec: 10 }),
        workers: [worker('w-0', { startSec: 1, finishSec: 2 })],
      }),
    )
    const gone = analyze(
      sources({
        journal: journal({ workers: [['a', 1, 2]] }),
        state: state({ startSec: 0, endSec: 10 }),
        workers: null,
        workersMissingReason: 'no workers dir',
      }),
    )
    expect(renderSupervisorRunMarkdown(zero)).toContain(
      '| **Steers (mid-task messages to live workers)** | **0** |',
    )
    expect(renderSupervisorRunMarkdown(gone)).toContain(
      '| **Steers (mid-task messages to live workers)** | **unavailable — no workers dir** |',
    )
  })
})

describe('analyzeSupervisorRun — waves, concurrency, idle, utilization', () => {
  // Two overlapping workers, then two more after both settle: 2 waves.
  const r = analyze(
    sources({
      journal: journal({
        workers: [
          ['a', 10, 110],
          ['b', 20, 120],
          ['c', 200, 260],
          ['d', 210, 270],
        ],
      }),
      state: state({ startSec: 0, endSec: 300 }),
      workers: [
        worker('w-0', { startSec: 10, finishSec: 110 }),
        worker('w-1', { startSec: 20, finishSec: 120 }),
        worker('w-2', { startSec: 200, finishSec: 260 }),
        worker('w-3', { startSec: 210, finishSec: 270 }),
      ],
    }),
  )

  it('groups spawns into waves by intervening settlements', () => {
    expect(r.orchestration.waves).toBe(2)
    expect(r.orchestration.waveSizes).toEqual([2, 2])
  })

  it('measures max concurrency', () => {
    expect(r.orchestration.maxConcurrency).toBe(2)
  })

  it('measures idle wall as the time with zero live workers', () => {
    // idle = [0,10) + [120,200) + [270,300] = 10 + 80 + 30 = 120s
    expect(r.orchestration.idleMs).toBe(120_000)
    expect(r.orchestration.idlePct).toBe(40)
  })

  it('measures worker utilization as summed worker wall over supervisor wall', () => {
    // Σ worker wall = 100 + 100 + 60 + 60 = 320s over a 300s run.
    expect(r.orchestration.workerUtilization).toBeCloseTo(320 / 300, 3)
  })

  it('measures time to first spawn and respawn count', () => {
    expect(r.orchestration.timeToFirstSpawnMs).toBe(10_000)
    expect(r.orchestration.respawns).toBe(2)
  })

  it('counts evidence→respawn sequences', () => {
    expect(r.decision.observeThenRespawn).toBe(1)
    expect(r.decision.respawnWithoutEvidence).toBe(1)
  })
})

describe('analyzeSupervisorRun — cancelled workers', () => {
  const r = analyze(
    sources({
      journal: journal({
        workers: [
          ['a', 10, 100, 'done'],
          ['b', 20, 90, 'cancelled'],
          ['c', 30, null],
        ],
      }),
      state: state({ startSec: 0, endSec: 200 }),
      workers: [
        worker('w-0', { startSec: 10, finishSec: 100, passed: true, patchBytes: 10 }),
        worker('w-1', { startSec: 20 }),
        worker('w-2', { startSec: 30 }),
      ],
    }),
  )

  it('counts cancelled separately from settled', () => {
    expect(r.orchestration.workersSpawned).toBe(3)
    expect(r.orchestration.workersSettled).toBe(1)
    expect(r.orchestration.workersCancelled).toBe(1)
    expect(r.decision.settledByStatus).toEqual({ done: 1, cancelled: 1 })
  })

  it('leaves a never-settled worker live to the end of the run (no idle credit)', () => {
    // One worker is still live from t=30 to the end, so idle is only [0,10).
    expect(r.orchestration.idleMs).toBe(10_000)
  })

  it('reports per-worker wall as unavailable when no finished event exists', () => {
    const perWorker = r.economics.perWorker
    expect(isUnavailable(perWorker)).toBe(false)
    if (isUnavailable(perWorker)) return
    expect(perWorker.find((w) => w.worker === 'w-1')?.wallMs).toBeNull()
  })
})

describe('analyzeSupervisorRun — decision quality and economics', () => {
  const r = analyze(
    sources({
      journal: journal({
        workers: [
          ['a', 10, 100],
          ['b', 20, 110],
          ['c', 30, 120],
        ],
        metered: [
          [5, 1000, 200, 0.02],
          [50, 2000, 300, 0.03],
        ],
      }),
      state: state({ startSec: 0, endSec: 200, usd: 0.05 }),
      workers: [
        worker('w-0', { startSec: 10, finishSec: 100, passed: true, patchBytes: 400 }),
        worker('w-1', { startSec: 20, finishSec: 110, passed: false, patchBytes: 0 }),
        worker('w-2', { startSec: 30, finishSec: 120, passed: true, patchBytes: 0 }),
      ],
      harnessWorkerTokens: { store: 'opencode', sessions: 3, input: 50_000, output: 9_000 },
      judge: JSON.stringify({ resolved: true, score: 0.75, passed: 15, total: 20 }),
      judgeSource: '/tmp/cell/judge.json',
      result: JSON.stringify({ verify_pass: true, verify_rc: 0 }),
    }),
  )

  it('splits accepted / rejected / empty-pass', () => {
    expect(r.decision.accepted).toBe(1)
    expect(r.decision.rejected).toBe(1)
    expect(r.decision.emptyPass).toBe(1)
  })

  it('attributes brain spend to journal metered events', () => {
    expect(r.economics.brain.tokensIn).toBe(3000)
    expect(r.economics.brain.tokensOut).toBe(500)
    expect(r.economics.brain.usd).toBeCloseTo(0.05, 6)
    expect(r.economics.brain.source).toContain('n=2')
  })

  it('counts truncated brain completions from the brain tap, and never reports 0 when the tap is absent', () => {
    // A truncated brain turn means the supervisor acted on a half-written plan. It went
    // unnoticed once because nothing recorded finish_reason; the journal's metered rows carry
    // token counts only, so the count has to come from the per-call brain tap.
    const withTap = analyze(
      sources({
        journal: journal({ workers: [] }),
        state: state({ startSec: 0, endSec: 10 }),
        workers: [],
        brainLog: [
          JSON.stringify({
            finish_reason: 'length',
            completion_tokens: 8192,
            req_max_tokens: null,
          }),
          JSON.stringify({ finish_reason: 'stop', completion_tokens: 120, req_max_tokens: 128000 }),
        ].join('\n'),
      }),
    )
    expect(withTap.economics.brainTruncations).toBe(1)

    const clean = analyze(
      sources({
        journal: journal({ workers: [] }),
        state: state({ startSec: 0, endSec: 10 }),
        workers: [],
        brainLog: JSON.stringify({ finish_reason: 'stop', completion_tokens: 12_000 }),
      }),
    )
    expect(clean.economics.brainTruncations).toBe(0)

    // UNAVAILABLE != ZERO: an older supervisor wrote no tap, so truncation cannot be ruled out.
    expect(r.economics.brainTruncations).toEqual({
      unavailable:
        'brain.jsonl absent — loops predates the brain-call tap, so truncation cannot be ruled out',
    })
  })

  it('adds the harness session join to journal-settled worker tokens', () => {
    expect(r.economics.workers.tokensIn).toBe(300 + 50_000)
    expect(r.economics.workers.tokensOut).toBe(60 + 9_000)
    expect(r.economics.workers.source).toContain('n=3')
    expect(r.economics.workers.source).toContain('opencode sessions')
  })

  it('marks worker tokens unavailable when the store is gone and the journal metered nothing', () => {
    const r2 = analyze(
      sources({
        journal: journal({ workers: [] }),
        state: state({ startSec: 0, endSec: 10 }),
        workers: [],
        harnessWorkerTokens: null,
        harnessMissingReason: 'opencode session store unreadable (ENOENT)',
      }),
    )
    expect(r2.economics.workers.tokensIn).toEqual({
      unavailable: 'opencode session store unreadable (ENOENT)',
    })
  })

  it('computes cost per accepted patch, and refuses it with no denominator', () => {
    expect(r.economics.costPerAcceptedPatchUsd).toBeCloseTo(0.05, 6)
    const none = analyze(
      sources({
        journal: journal({ workers: [] }),
        state: state({ startSec: 0, endSec: 10 }),
        workers: [],
      }),
    )
    expect(isUnavailable(none.economics.costPerAcceptedPatchUsd)).toBe(true)
  })

  it('carries judge provenance and outcome', () => {
    expect(r.outcome.judgeResolved).toBe(true)
    expect(r.outcome.judgeScore).toBe(0.75)
    expect(r.outcome.judgeSource).toBe('/tmp/cell/judge.json')
    expect(r.outcome.verifyPass).toBe(true)
  })

  it('flags brain-only totals so an unpriced worker arm cannot read as full cost', () => {
    expect(r.economics.totalUsdSource).toContain('state.json result.spentUsd')
  })
})

describe('driver.log steer verbs', () => {
  it('ignores the tool-registration banner and counts real invocations', () => {
    const log = [
      '[driver] registered tools: spawn_supervisor, supervisor_watch, supervisor_steer, loop_run',
      '[watch] 30s status=running',
      '[driver] supervisor_steer(sup-1, w-0): tighten the diff',
      '[driver] supervisor_steer(sup-1, w-1): re-run verify',
    ].join('\n')
    const r = analyze(sources({ journal: journal({ workers: [] }), driverLog: log }))
    expect(r.orchestration.driverSteerCalls).toBe(2)
  })

  it('is unavailable without a driver.log', () => {
    const r = analyze(sources({ journal: journal({ workers: [] }) }))
    expect(isUnavailable(r.orchestration.driverSteerCalls)).toBe(true)
  })
})

describe('parsePatch', () => {
  it('counts files, lines, and test-file touches', () => {
    const patch = [
      'diff --git a/src/foo.ts b/src/foo.ts',
      'index 111..222 100644',
      '--- a/src/foo.ts',
      '+++ b/src/foo.ts',
      '@@ -1,2 +1,3 @@',
      ' keep',
      '+added',
      '-removed',
      'diff --git a/src/foo.test.ts b/src/foo.test.ts',
      '--- /dev/null',
      '+++ b/src/foo.test.ts',
      '@@ -0,0 +1,2 @@',
      '+it("works", () => {})',
      '+// end',
    ].join('\n')
    const stats = parsePatch(patch)
    expect(stats.files).toBe(2)
    expect(stats.linesAdded).toBe(3)
    expect(stats.linesRemoved).toBe(1)
    expect(stats.testFilesTouched).toEqual(['src/foo.test.ts'])
  })

  it('recognizes python test paths', () => {
    const stats = parsePatch('+++ b/tests/test_thing.py\n+assert True\n')
    expect(stats.testFilesTouched).toEqual(['tests/test_thing.py'])
  })
})

describe('rollupSupervisorRuns', () => {
  const withSteers = analyze(
    sources({
      journal: journal({ workers: [['a', 10, 100]] }),
      state: state({ startSec: 0, endSec: 200 }),
      workers: [worker('w-0', { startSec: 10, finishSec: 100, steers: ['go'] })],
      judge: JSON.stringify({ resolved: true }),
      judgeSource: 'j',
    }),
  )
  const withoutSteers = analyze(
    sources({
      journal: journal({ workers: [['a', 10, 100]] }),
      state: state({ startSec: 0, endSec: 200 }),
      workers: [worker('w-0', { startSec: 10, finishSec: 100 })],
      judge: JSON.stringify({ resolved: false }),
      judgeSource: 'j',
    }),
  )
  const blind = analyze(sources({ supRunDir: null }))

  it('separates unavailable cells from zero cells in the rollup', () => {
    const rollup = rollupSupervisorRuns([withSteers, withoutSteers, blind])
    expect(rollup.cells).toBe(3)
    expect(rollup.steersTotal).toBe(1)
    expect(rollup.cellsWithSteers).toBe(1)
    expect(rollup.cellsWithUnavailableSteers).toBe(1)
    expect(rollup.resolvedCount).toBe(1)
  })

  it('renders a per-cell table', () => {
    const md = renderSupervisorRollupMarkdown(rollupSupervisorRuns([withSteers, withoutSteers]))
    expect(md).toContain('| Instance | Arm | Steers | Waves |')
    expect(md).toContain('Steers across all cells: 1')
  })

  it('reports unavailable rather than 0 when NO cell measured a metric', () => {
    const rollup = rollupSupervisorRuns([blind])
    expect(isUnavailable(rollup.steersTotal)).toBe(true)
    expect(isUnavailable(rollup.utilizationMean)).toBe(true)
  })
})
