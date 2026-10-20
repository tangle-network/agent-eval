/**
 * Simulated search: the real kernel, ledger, policies and claim over a scripted
 * objective, a scripted proposer and a scripted executor.
 *
 * Every artifact has a hidden true quality. A child's quality is its parent's
 * plus a seeded step (zero under `--null`), a cell scores the quality plus
 * seeded task and noise terms, and a cell costs a seeded fraction of the lane's
 * per-cell price, some above the kernel's reservation. Scores, costs and faults
 * depend only on the seed and the cell or run id, so a resumed search
 * reproduces the uninterrupted one. The executor keeps each finished attempt,
 * which is what `adopt` reads back after a restart, and logs every attempt it
 * starts and finishes.
 *
 *   node --import tsx scripts/search-sim.ts run --dir DIR [options]
 *   node --import tsx scripts/search-sim.ts kill-resume --dir DIR --kills 6 [options]
 *   node --import tsx scripts/search-sim.ts claims --searches 200 [options]
 *   node --import tsx scripts/search-sim.ts compare --seeds 200 --arms A,B [options]
 *   node --import tsx scripts/search-sim.ts plateau --seeds 40 --ceiling 0.62 [options]
 *   node --import tsx scripts/search-sim.ts adaptive --seeds 40 --skills 3 --pool-gap 0.05 [options]
 *   node --import tsx scripts/search-sim.ts lens-null --seeds 40 --null [options]
 *
 * `run` runs or resumes the search in DIR to its close; with `--in-memory` it
 * runs without a per-append fsync and writes the ledger and blobs to DIR at
 * the end, for scale ledgers. `kill-resume` runs the
 * search in DIR/killed as a child process, SIGKILLs it at seeded random ledger
 * sequences, resumes it each time, then runs the same search uninterrupted in
 * DIR/reference and compares the two. `claims` runs N searches with seeds
 * seed..seed+N-1 on in-memory ledgers and tallies their claims: a `ship` whose
 * selected node is no better than the root in truth is a false claim, and the
 * rate is reported with its Wilson and Clopper-Pearson 95% intervals.
 * `compare` runs the search once per seed under each arm of `--arms` (a
 * comma-separated list of `policy+allocation`, default
 * `incumbent+uniform,incumbent+asha`) on in-memory ledgers and reports, per
 * arm, the cells each allocated, the node each kept, how often it kept the
 * planted node and how often a node at least half the planted gain above the
 * root (each with its Wilson 95% interval), and the units each measured
 * edge pairs on against its parent; every later arm is paired with the first
 * seed by seed, with an exact sign test on the seeds where exactly one of the
 * two kept the planted node. `plateau`
 * runs each seed under `incumbent` and under `draftOnPlateau(incumbent)` and
 * reports, paired by seed, the kept and best true quality, the drafts, and
 * the `landscape` lens (plateau score, basins) on each closed ledger.
 * `adaptive` fits `skillManifold` on one `uniform` calibration search
 * (`--calibration-seed`, 1000, on the same task bank), keeps
 * its loadings with `skillCalibration`, then runs each seed under `asha` and
 * under `asha` extended by `nextUnitExtension`, paired by seed. `lens-null`
 * runs flat searches (`--null`) and reports the landscape lens's basin count,
 * surface and plateau on each, which calibrates the lens against a known
 * flat truth.
 *
 * Calibration can decline small or noisy matrices; exit 1 then includes the
 * measured insufficiency reason. Preserve that outcome when comparing revisions.
 * A nonempty test split requires --min-effect before the search starts.
 * For a bounded adaptive held-out check:
 *   node --import tsx scripts/search-sim.ts adaptive --seeds 2 --skills 3 --pool-gap 0.05 \
 *     --selection 12 --test 12 --min-effect 0.05 --expansions 6 --delay-ms 0
 *
 * Options: --seed N (1), --train N (2), --selection N (6), --test N (0),
 * --reps N (1), --population N (3), --expansions N (6), --capacity N (4),
 * --max-usd X (none), --claim-usd X (0), --cell-usd X (0.05), --cost-cap
 * hard|estimate (estimate), --fault-rate X (0), --delay-ms N (5), --patience N,
 * --min-improvement X (`incumbent`'s lead margin),
 * --deadline ISO, --min-effect X (the claim's minimum effect), --null (every
 * step is 0, so no node differs from the root), --plant-gain X (the root's
 * first child is X better), --plant-divergence (the root's second child gains
 * 0.3 on train and loses 0.2 on selection and test), --judge-revision N|none (1),
 * --binary (a cell passes with probability quality + shift + task and scores 1
 * or 0), --minimize (the objective is minimized and a cell reports 1 minus its
 * score, so a better artifact scores lower), --cost-scale X (1: a cell costs X
 * times what the lane's prior assumes, so an estimate lane overspends until
 * its own cost distribution sets the hold), --allocation
 * uniform|asha|asha-adaptive (uniform), --policy
 * incumbent|crowded-frontier|draft-on-plateau|aide|beam (incumbent),
 * --beam-width N (3), --max-cells N (none: the search allocates at most N
 * cells), --pool-gap X (none), --pool-plant N (seeded), --deep-gain X (none),
 * --deep-depth N (3), --deep-ramp, --defect-rate X (0).
 *
 * Geometry options: `--skills K` gives artifacts K latent skills (axis 0
 * general, every task loads it; each task also loads one specialist axis),
 * and a cell scores 0.5 plus the skills on its task's demand; `--skill-spread
 * X` (0.12) spreads pool candidates on each specialist axis over [-X, 0);
 * `--bank-seed N` (the seed) fixes the task bank across searches;
 * `--ceiling X` caps the root's lineage at X while a draft's lineage can climb
 * 0.25 higher; `--policy incumbent|draft-on-plateau`; `--allocation
 * asha-adaptive --calibration FILE` extends asha with a saved calibration.
 * Under these options every artifact carries profile lines that each child
 * edits, so the landscape lens measures line edits between surfaces.
 *
 * `--pool-gap X` swaps the hill climb's steps for a planted pool: every child
 * is the root's quality plus a seeded step in [-0.1, 0), whatever its parent,
 * except child `c<N>` (the Nth registered, a seeded place in the pool unless
 * `--pool-plant` names it), which is the root plus X. The pool depends only on
 * the seed and the number of proposals, so `uniform` and `asha` measure the
 * same candidates and the planted child is the one right answer.
 *
 * `--deep-gain X` plants a gain at depth `--deep-depth` of one lineage: every
 * edit off the planted path costs its node a seeded [0, 0.1) of its parent's
 * quality, and the path (one seeded child of the first proposal from each
 * path node, starting at the root) is neutral until its node at that depth,
 * which is the root plus X. With `--deep-ramp` each path node gains X / depth
 * over its parent instead of 0, so the gain is a gradient a hill climb can
 * follow. The planted node is the best node the search can register. The
 * landscape is the root's tree, so a `draft` there is one more child of the
 * root; elsewhere a draft is a fresh artifact (`d<N>`).
 *
 * `--defect-rate X` makes a seeded share X of proposed children defective
 * (planted-path nodes never are): each of a defective node's cells ends
 * `failed` with score 0, a defect of the agent, not an environment fault. A
 * `debug` child of a defective node fixes the defect and keeps its parent's
 * quality.
 *
 * Every run audits its ledger: each `advanced` and `pruned` decision, with its
 * rule, rank reason and estimate, must be one the allocator makes again from
 * the ledger just before it, and each proposal's parents, operator and
 * selection evidence must be the expansion the policy makes again from the
 * ledger just before the proposal started.
 *
 * Output is one JSON document on stdout. Exit 1 when a check fails.
 */

import { pathToFileURL } from 'node:url'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { type SkillCalibration } from '../src/search/lenses/skill-manifold'
import { type SimOptions, SIM_POLICIES, isSimPolicy } from './search-sim/types'
import { diskStore, memoryStore } from './search-sim/store'
import { runSimulation } from './search-sim/run'
import { claims } from './search-sim/claims'
import { compare, parseArms } from './search-sim/compare'
import { plateau, lensNull, adaptive } from './search-sim/geometry'
import { killResume } from './search-sim/recovery'

export type { SimArtifact, SimOptions, SimPolicy } from './search-sim/types'
export type { SimStore } from './search-sim/store'
export { diskStore, memoryStore } from './search-sim/store'
export { runSimulation } from './search-sim/run'

async function main(): Promise<void> {
  const [mode, ...argv] = process.argv.slice(2)
  const { values } = parseArgs({
    args: argv,
    options: {
      dir: { type: 'string' },
      seed: { type: 'string', default: '1' },
      train: { type: 'string', default: '2' },
      selection: { type: 'string', default: '6' },
      test: { type: 'string', default: '0' },
      reps: { type: 'string', default: '1' },
      population: { type: 'string', default: '3' },
      expansions: { type: 'string', default: '6' },
      capacity: { type: 'string', default: '4' },
      'max-usd': { type: 'string' },
      'claim-usd': { type: 'string', default: '0' },
      'cell-usd': { type: 'string', default: '0.05' },
      'cost-cap': { type: 'string', default: 'estimate' },
      'fault-rate': { type: 'string', default: '0' },
      'delay-ms': { type: 'string', default: '5' },
      patience: { type: 'string' },
      'min-improvement': { type: 'string' },
      deadline: { type: 'string' },
      'min-effect': { type: 'string' },
      null: { type: 'boolean', default: false },
      'plant-gain': { type: 'string' },
      'plant-divergence': { type: 'boolean', default: false },
      'judge-revision': { type: 'string', default: '1' },
      binary: { type: 'boolean', default: false },
      minimize: { type: 'boolean', default: false },
      'cost-scale': { type: 'string', default: '1' },
      kills: { type: 'string', default: '6' },
      searches: { type: 'string', default: '200' },
      allocation: { type: 'string', default: 'uniform' },
      policy: { type: 'string', default: 'incumbent' },
      'beam-width': { type: 'string', default: '3' },
      'max-cells': { type: 'string' },
      'deep-gain': { type: 'string' },
      'deep-depth': { type: 'string', default: '3' },
      'deep-ramp': { type: 'boolean', default: false },
      'defect-rate': { type: 'string', default: '0' },
      arms: { type: 'string', default: 'incumbent+uniform,incumbent+asha' },
      'pool-gap': { type: 'string' },
      'pool-plant': { type: 'string' },
      seeds: { type: 'string', default: '100' },
      skills: { type: 'string', default: '0' },
      'bank-seed': { type: 'string' },
      'skill-spread': { type: 'string', default: '0.12' },
      ceiling: { type: 'string' },
      calibration: { type: 'string' },
      'calibration-seed': { type: 'string', default: '1000' },
      'in-memory': { type: 'boolean', default: false },
    },
  })
  if (
    values.allocation !== 'uniform' &&
    values.allocation !== 'asha' &&
    values.allocation !== 'asha-adaptive'
  ) {
    throw new Error(`--allocation must be uniform, asha or asha-adaptive, got ${values.allocation}`)
  }
  if (!isSimPolicy(values.policy)) {
    throw new Error(`--policy must be ${SIM_POLICIES.join(', ')}, got ${values.policy}`)
  }
  const options: SimOptions = {
    seed: Number(values.seed),
    train: Number(values.train),
    selection: Number(values.selection),
    test: Number(values.test),
    reps: Number(values.reps),
    population: Number(values.population),
    expansions: Number(values.expansions),
    capacity: Number(values.capacity),
    maxUsd: values['max-usd'] === undefined ? null : Number(values['max-usd']),
    claimUsd: Number(values['claim-usd']),
    cellUsd: Number(values['cell-usd']),
    costCap: values['cost-cap'] === 'hard' ? 'hard' : 'estimate',
    faultRate: Number(values['fault-rate']),
    delayMs: Number(values['delay-ms']),
    patience: values.patience === undefined ? undefined : Number(values.patience),
    minImprovement:
      values['min-improvement'] === undefined ? undefined : Number(values['min-improvement']),
    deadline: values.deadline ?? null,
    minEffect: values['min-effect'] === undefined ? undefined : Number(values['min-effect']),
    nullSteps: values.null,
    plantGain: values['plant-gain'] === undefined ? null : Number(values['plant-gain']),
    plantDivergence: values['plant-divergence'],
    judgeRevision: values['judge-revision'] === 'none' ? null : Number(values['judge-revision']),
    binary: values.binary,
    minimize: values.minimize,
    costScale: Number(values['cost-scale']),
    allocation: values.allocation,
    policy: values.policy,
    beamWidth: Number(values['beam-width']),
    maxCells: values['max-cells'] === undefined ? null : Number(values['max-cells']),
    deepGain: values['deep-gain'] === undefined ? null : Number(values['deep-gain']),
    deepDepth: Number(values['deep-depth']),
    deepRamp: values['deep-ramp'],
    defectRate: Number(values['defect-rate']),
    poolGap: values['pool-gap'] === undefined ? null : Number(values['pool-gap']),
    poolPlant: values['pool-plant'] === undefined ? null : Number(values['pool-plant']),
    skills: Number(values.skills),
    skillSpread: Number(values['skill-spread']),
    bankSeed: Number(values['bank-seed'] ?? values.seed),
    ceiling: values.ceiling === undefined ? null : Number(values.ceiling),
    calibration:
      values.calibration === undefined
        ? null
        : (JSON.parse(readFileSync(values.calibration, 'utf8')) as SkillCalibration),
  }
  if (mode === 'claims') {
    console.log(JSON.stringify(await claims(options, Number(values.searches)), null, 2))
    return
  }
  if (mode === 'lens-null') {
    console.log(JSON.stringify(await lensNull(options, Number(values.seeds)), null, 2))
    return
  }
  if (mode === 'plateau') {
    const report = await plateau(options, Number(values.seeds))
    console.log(JSON.stringify(report, null, 2))
    if (!report.ok) process.exitCode = 1
    return
  }
  if (mode === 'adaptive') {
    const report = await adaptive(
      options,
      Number(values.seeds),
      Number(values['calibration-seed']),
    )
    console.log(JSON.stringify(report, null, 2))
    if (!report.ok) process.exitCode = 1
    return
  }
  if (mode === 'compare') {
    const report = await compare(options, Number(values.seeds), parseArms(values.arms))
    console.log(JSON.stringify(report, null, 2))
    if (!report.ok) process.exitCode = 1
    return
  }
  if (!values.dir) throw new Error('--dir is required')
  const passthrough = argv.filter((_, index) => {
    const flag = argv[index] === '--dir' || argv[index - 1] === '--dir'
    const kills = argv[index] === '--kills' || argv[index - 1] === '--kills'
    return !flag && !kills
  })
  if (mode === 'run') {
    const dir = resolve(values.dir)
    if (values['in-memory']) {
      // The ledger and its blobs live in memory while the search runs (no
      // fsync per append), then land in DIR as `run` would have written them.
      // A killed run leaves nothing to resume.
      const store = memoryStore()
      const { summary } = await runSimulation(dir, options, store)
      for (const [path, content] of store.files()) {
        mkdirSync(dirname(path), { recursive: true })
        writeFileSync(path, content)
      }
      console.log(JSON.stringify(summary))
      return
    }
    const { summary } = await runSimulation(dir, options, diskStore(dir))
    console.log(JSON.stringify(summary))
    return
  }
  if (mode === 'kill-resume') {
    const report = await killResume(resolve(values.dir), options, passthrough, Number(values.kills))
    console.log(JSON.stringify(report, null, 2))
    if (!report.ok) process.exitCode = 1
    return
  }
  throw new Error(
    `unknown mode ${String(mode)}; use run, kill-resume, claims, compare, plateau, adaptive or lens-null`,
  )
}

// Run only as a command; another script imports `runSimulation` to run
// simulated searches of its own, for example as the cells of an outer search.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main()
