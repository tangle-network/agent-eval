// Collects slice-1 certification measurements from per-task evidence directories into one
// slice file, so six concurrent agents never write the shared task-oracles.json.
import { readFileSync, existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const SLICE_ID = 'slice-1'
const TASKS = [
  'bn-fit-modify', 'cancel-async-tasks', 'configure-git-webserver', 'distribution-search',
  'feal-linear-cryptanalysis', 'gcode-to-text', 'install-windows-3.11', 'mailman',
  'mteb-leaderboard', 'password-recovery', 'protein-assembly', 'qemu-startup',
  'rstan-to-pystan', 'sqlite-with-gcov', 'vulnerable-secret',
]
// Evidence roots in priority order. The first root holding a task's determinism.json wins.
const ROOTS = [
  { dir: process.env.HOME + '/bench-cache/certify-slice1', run: 'slice-1' },
  { dir: process.env.HOME + '/bench-cache/certify-scale-20260813', run: 'serial-20260813' },
]

const summaryRow = (root, task) => {
  const p = join(root, 'summary.psv')
  if (!existsSync(p)) return null
  const lines = readFileSync(p, 'utf8').trim().split('\n')
  const head = lines[0].split('|')
  for (const line of lines.slice(1).reverse()) {
    const cells = line.split('|')
    if (cells[0] === task) return Object.fromEntries(head.map((h, i) => [h, cells[i]]))
  }
  return null
}

// Why a refused task cannot be ground truth, keyed by the measured failure, not by guesswork.
// Each entry cites the file under `evidenceDir` that shows it.
const REFUSALS = {
  'cancel-async-tasks': {
    class: 'wall-clock-threshold assertion under CPU contention',
    units: [
      'test_outputs.py::test_tasks_cancel_at_max_concurrent',
      'test_outputs.py::test_tasks_cancel_below_max_concurrent',
    ],
    detail:
      'On byte-identical solved state the suite returns reward 1 on all 3 idle replicates and reward 0 on both contended replicates. Suite wall time doubles under load, 29s idle to 69s contended.',
    evidence: 'determinism.json',
  },
  'install-windows-3.11': {
    class: 'background-process liveness assertion',
    units: ['test_outputs.py::test_qemu_running_with_correct_params'],
    detail:
      'After the reference solution the graded QEMU process cmdline reads empty, so the snapshot-mode assertion fails and phase B scores 0. Phase C measured no flip: the suite fails both states consistently.',
    evidence: 'solved-tests.txt',
  },
  'protein-assembly': {
    class: 'stochastic reference solution',
    units: [],
    detail:
      'The reference solve.sh exits 1: dnachisel raises NoSolutionError from its constraint solver, which the library itself says can be retried. Phase B never reaches a solved state.',
    evidence: 'oracle.txt',
  },
  'rstan-to-pystan': {
    class: 'decayed image dependency',
    units: [],
    detail:
      "The reference solve.sh exits 1 after 1528s: `import stan` raises ModuleNotFoundError for pkg_resources inside the pinned image. Phase C is stable at reward granularity, both states 0/5 pass.",
    evidence: 'oracle.txt',
  },
}

const out = { sliceId: SLICE_ID, generatedAt: new Date().toISOString(), tasks: [] }
for (const task of TASKS) {
  let rec = { task, state: 'not-reached' }
  for (const { dir, run } of ROOTS) {
    const det = join(dir, task, 'determinism.json')
    const ver = join(dir, task, 'determinism-verdict.json')
    if (!existsSync(det)) continue
    const row = summaryRow(dir, task)
    const verdictJson = existsSync(ver) ? JSON.parse(readFileSync(ver, 'utf8')) : null
    rec = {
      task,
      state: row?.verdict === 'CERTIFIED' ? 'certified' : 'refused',
      verdict: row?.verdict ?? null,
      evidenceRun: run,
      evidenceDir: join(dir, task),
      image: row?.image ?? null,
      imageDigest: verdictJson?.image ?? null,
      suiteDigest: verdictJson?.suiteDigest ?? null,
      unsolvedReward: row?.unsolved_reward ?? null,
      solvedReward: row?.solved_reward ?? null,
      solveRc: row?.solve_rc ?? null,
      testsBeforeAgentPhase: row?.tests_before_agent_phase ?? null,
      determinism: verdictJson
        ? {
            replicates: verdictJson.replicates,
            flipRate: verdictJson.flipRate,
            stable: verdictJson.stable,
            byState: verdictJson.byState?.map((s) => ({
              state: s.state,
              replicates: s.replicates,
              granularity: s.granularity,
              flipRate: s.flipRate,
              flipped: s.flipped,
              loadSensitive: s.loadSensitive,
              rewardsObserved: s.rewardsObserved,
            })),
          }
        : null,
      refusal: row?.verdict === 'CERTIFIED' ? null : (REFUSALS[task] ?? null),
      measurements: JSON.parse(readFileSync(det, 'utf8')),
    }
    break
  }
  out.tasks.push(rec)
}
out.counts = {
  total: out.tasks.length,
  certified: out.tasks.filter((t) => t.state === 'certified').length,
  refused: out.tasks.filter((t) => t.state === 'refused').length,
  notReached: out.tasks.filter((t) => t.state === 'not-reached').length,
}
writeFileSync('benchmarks/trace-repair/.slices/slice-1.json', JSON.stringify(out, null, 2) + '\n')
console.log(JSON.stringify(out.counts))
for (const t of out.tasks) console.log(t.task, t.state, t.verdict ?? '', t.evidenceRun ?? '')
