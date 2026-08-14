// Assemble benchmarks/trace-repair/.slices/slice-4.json from measured evidence.
// Verdicts are re-derived from the replicates by the substrate rule, never copied
// from a log line, so a reader can recount them.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const repo = '/home/drew/code/agent-eval/.worktrees/certify-oracles-scale'
const home = homedir()
const lock = JSON.parse(readFileSync(join(repo, 'benchmarks/trace-repair/tb-images.lock.json'), 'utf8'))
const candidates = Object.keys(lock.images).filter((t) => t !== 'make-doom-for-mips').sort()
const assigned = candidates.filter((_, i) => i % 6 === 4)

// evidence directory per task: reused prior runs first, then this slice's own runs
const reused = {
  'build-pmars': ['certify-slice4/build-pmars', 'serial slice-4 predecessor run 2026-08-13T22:06 local'],
  'cobol-modernization': ['certify-slice4/evidence-cobol-modernization/cobol-modernization', 'serial slice-4 predecessor run 2026-08-13T22:24 local'],
  'crack-7z-hash': ['certify-scale-20260813/crack-7z-hash', 'serial scale run 2026-08-13'],
  'extract-elf': ['certify-scale-20260813/extract-elf', 'serial scale run 2026-08-13'],
  'gpt2-codegolf': ['certify-scale-20260813/gpt2-codegolf', 'serial scale run 2026-08-13'],
  'polyglot-c-py': ['certify-scale-20260813/polyglot-c-py', 'serial scale run 2026-08-13'],
  'schemelike-metacircular-eval': ['certify-scale-20260813/schemelike-metacircular-eval', 'serial scale run 2026-08-13'],
  'largest-eigenval': ['oracle-determinism-20260810b/largest-eigenval', 'oracle-determinism run 2026-08-10'],
}

function summaryRows(path) {
  if (!existsSync(path)) return []
  return readFileSync(path, 'latin1')
    .split('\n')
    .filter((line) => line.includes('|') && !line.startsWith('task|'))
    .map((line) => line.replace(/\0/g, '').split('|'))
}

const summaries = new Map()
for (const file of [
  join(home, 'bench-cache/certify-scale-20260813/summary.psv'),
  join(home, 'bench-cache/certify-slice4/summary.psv'),
  join(home, 'bench-cache/oracle-determinism-20260810b/summary.psv'),
  join(home, 'bench-cache/certify-slice4b/summary.psv'),
]) {
  for (const row of summaryRows(file)) summaries.set(row[0], row)
}
for (const task of [...assigned, 'custom-memory-heap-crash', 'headless-terminal', 'fix-git', 'modernize-scientific-stack']) {
  for (const file of [
    join(home, `bench-cache/certify-slice4/evidence-${task}/summary.psv`),
    join(home, `bench-cache/certify-slice4b/${task}/summary.psv`),
  ]) {
    for (const row of summaryRows(file)) summaries.set(row[0], row)
  }
}

function deriveVerdict(evidencePath) {
  // Exit 3 is the rule's own "the grader did not answer about the state" signal,
  // which is a measurement, not a tool failure. Only other statuses are errors.
  let out
  try {
    out = execFileSync(
      'node',
      ['--import', 'tsx', 'scripts/tb-oracle-determinism.ts', evidencePath],
      { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    )
  } catch (error) {
    if (error.status !== 3) throw error
    out = error.stdout
  }
  const match = /flip_bp=(\d+) replicates=(\d+) state=(\w+)/.exec(out)
  if (!match) throw new Error(`unparsable determinism output for ${evidencePath}`)
  return { flipRatePct: Number(match[1]) / 100, replicates: Number(match[2]), stable: match[3] === 'stable' }
}

const results = []
const unreached = []
for (const task of assigned) {
  const dirs = []
  if (reused[task]) dirs.push([join(home, 'bench-cache', reused[task][0]), reused[task][1]])
  dirs.push([join(home, 'bench-cache/certify-slice4b', task), 'slice-4 parallel run 2026-08-13, --determinism 4 --determinism-load 0'])
  const found = dirs.find(([dir]) => existsSync(join(dir, 'determinism.json')))
  const row = summaries.get(task)
  if (!found) {
    let reason = 'not reached before the 75-minute bound'
    const runLog = join(home, `bench-cache/certify-slice4b/${task}.run.log`)
    if (existsSync(runLog)) {
      const text = readFileSync(runLog, 'latin1').replace(/\0/g, '')
      const verdict = text.match(/^VERDICT=.*$/m)
      if (verdict) reason = `no phase C evidence; script reported ${verdict[0].slice(8)}`
      else reason = 'run started, cut off before phase C wrote evidence'
    }
    unreached.push({ taskName: task, image: lock.images[task].reference, pinnedDigest: lock.images[task].digest, reason })
    continue
  }
  const [dir, provenance] = found
  const evidence = JSON.parse(readFileSync(join(dir, 'determinism.json'), 'utf8'))
  const derived = deriveVerdict(join(dir, 'determinism.json'))
  const verdictJson = existsSync(join(dir, 'determinism-verdict.json'))
    ? JSON.parse(readFileSync(join(dir, 'determinism-verdict.json'), 'utf8'))
    : null
  const pinned = lock.images[task].digest
  const measuredDigest = String(evidence.image).split('@')[1] ?? null

  const unsolvedGroup = verdictJson?.byState?.find((s) => s.state === 'unsolved')
  const solvedGroup = verdictJson?.byState?.find((s) => s.state === 'solved')
  const flippedUnits = (verdictJson?.byState ?? []).flatMap((s) =>
    s.flipped.map((u) => ({ state: s.state, unit: u.unit, passes: u.passes, fails: u.fails, flipRatePct: Number((u.flipRate * 100).toFixed(2)) })),
  )

  let verdict
  if (!derived.stable) verdict = `REFUSED_NONDETERMINISTIC_ORACLE(flip=${derived.flipRatePct.toFixed(2)}%,n=${derived.replicates})`
  else if (row && row[13]) verdict = row[13].trim()
  else verdict = 'UNKNOWN_NO_SUMMARY_ROW'

  // Phase B grades the solved container once; phase C re-grades it with nothing
  // written between the runs. A solved state that scores 1 once and 0 on every
  // replicate separates nothing a campaign can measure, so the slice records the
  // loss instead of carrying the script's CERTIFIED forward.
  const separationHeld =
    solvedGroup && unsolvedGroup ? solvedGroup.passes > 0 && unsolvedGroup.passes === 0 : null
  let sliceVerdict = verdict
  if (verdict === 'CERTIFIED' && separationHeld === false) {
    sliceVerdict = 'REFUSED_SEPARATION_LOST_ON_REGRADE'
  }

  results.push({
    taskName: task,
    image: evidence.image,
    pinnedDigestMatches: measuredDigest === pinned,
    suiteDigest: evidence.suiteDigest ?? null,
    measuredAt: evidence.measuredAt ?? null,
    provenance,
    evidencePath: join(dir, 'determinism.json'),
    verdict: sliceVerdict,
    scriptVerdict: verdict,
    phaseAUnsolvedReward: row ? row[3] : null,
    phaseBSolvedReward: row ? row[7] : null,
    solveRc: row ? row[5] : null,
    testsBeforeAgentPhase: row ? row[9] : null,
    determinism: {
      stable: derived.stable,
      flipRatePct: derived.flipRatePct,
      replicates: derived.replicates,
      granularity: unsolvedGroup?.granularity ?? solvedGroup?.granularity ?? null,
      detail: verdictJson?.detail ?? null,
      flippedUnits,
    },
    phaseCSeparation: {
      unsolvedSuitePasses: unsolvedGroup ? `${unsolvedGroup.passes}/${unsolvedGroup.replicates}` : null,
      solvedSuitePasses: solvedGroup ? `${solvedGroup.passes}/${solvedGroup.replicates}` : null,
      unsolvedRewardsObserved: unsolvedGroup?.rewardsObserved ?? null,
      solvedRewardsObserved: solvedGroup?.rewardsObserved ?? null,
      separationHeld,
    },
  })
}

// A serial predecessor run selected its tasks from the assay task list rather than
// from tb-images.lock.json, so six of its measurements land outside this slice.
// They are recorded here so the measurement is not lost; the slice that owns each
// task under the lockfile rule decides what to do with it.
const outOfSlice = [
  ['custom-memory-heap-crash', 'certify-slice4/evidence-custom-memory-heap-crash/custom-memory-heap-crash'],
  ['headless-terminal', 'certify-slice4/evidence-headless-terminal/headless-terminal'],
  ['fix-git', 'certify-slice4/evidence-fix-git/fix-git'],
  ['modernize-scientific-stack', 'certify-slice4/evidence-modernize-scientific-stack/modernize-scientific-stack'],
]
const outOfSliceEvidence = []
for (const [task, rel] of outOfSlice) {
  const dir = join(home, 'bench-cache', rel)
  if (!existsSync(join(dir, 'determinism.json'))) continue
  const derived = deriveVerdict(join(dir, 'determinism.json'))
  const verdictJson = JSON.parse(readFileSync(join(dir, 'determinism-verdict.json'), 'utf8'))
  const unsolved = verdictJson.byState.find((s) => s.state === 'unsolved')
  const solved = verdictJson.byState.find((s) => s.state === 'solved')
  const row = summaries.get(task)
  outOfSliceEvidence.push({
    taskName: task,
    ownedBySliceUnderLockfileRule: candidates.indexOf(task) % 6,
    evidencePath: join(dir, 'determinism.json'),
    scriptVerdict: row ? row[13].trim() : null,
    determinism: { stable: derived.stable, flipRatePct: derived.flipRatePct, replicates: derived.replicates },
    phaseCSeparation: {
      unsolvedSuitePasses: `${unsolved.passes}/${unsolved.replicates}`,
      solvedSuitePasses: `${solved.passes}/${solved.replicates}`,
      separationHeld: solved.passes > 0 && unsolved.passes === 0,
    },
  })
}

const slice = {
  version: 1,
  slice: 4,
  slices: 6,
  selection: {
    rule: 'candidates = the 89 image names in tb-images.lock.json, minus make-doom-for-mips (0.0% pass across all 52104 corpus rows), sorted; take zero-based index % 6 === 4',
    candidateCount: candidates.length,
    assignedCount: assigned.length,
    assignedTasks: assigned,
  },
  tb2Commit: lock.tb2Commit,
  generatedAt: new Date().toISOString(),
  hostContext:
    'six slices certified in parallel on one 32-core host; 1-minute load average was 381 when this slice started, so phase C idle replicates ran on a loaded machine. This slice used --determinism-load 0 for its own runs, which adds no busy loops.',
  results,
  unreached,
  outOfSliceEvidence,
}

mkdirSync(join(repo, 'benchmarks/trace-repair/.slices'), { recursive: true })
writeFileSync(join(repo, 'benchmarks/trace-repair/.slices/slice-4.json'), `${JSON.stringify(slice, null, 2)}\n`)
process.stdout.write(`slice-4: ${results.length} measured, ${unreached.length} unreached\n`)
for (const r of results) process.stdout.write(`  ${r.taskName.padEnd(30)} ${r.verdict}\n`)
for (const u of unreached) process.stdout.write(`  ${u.taskName.padEnd(30)} UNREACHED: ${u.reason}\n`)
