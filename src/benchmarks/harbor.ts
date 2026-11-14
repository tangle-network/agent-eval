/**
 * A Harbor dataset as a `BenchmarkAdapter`.
 *
 * Harbor (https://harborframework.com) lays out each task as a directory with `task.toml`,
 * `instruction.md`, the agent's `environment/`, and the `tests/` its verifier runs, usually in a
 * verifier image of their own. This importer reads a local checkout of such a dataset, at the
 * revision the caller pins in `source`, into `BenchmarkDatasetItem`s.
 *
 * Scoring stays Harbor's. `evaluate` hands the task and the agent's artifact to the caller's
 * `grade` callback, which runs the task's own verifier and reports its reward. `gradeHarborPatch`
 * is that callback for a code patch: it spawns the Harbor CLI, which starts the containers; this
 * package starts none itself. A verifier that did not run is an error, never a score of zero.
 */

import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { cp, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { promisify, stripVTControlCharacters } from 'node:util'

import { parse as parseToml, stringify as stringifyToml } from 'smol-toml'

import type { RunSplitTag } from '../run-record'
import { preparedImage } from './harbor-environment'
import type {
  BenchmarkAdapter,
  BenchmarkDatasetItem,
  BenchmarkEvaluation,
  BenchmarkSource,
} from './types'
import { deterministicSplit } from './types'

const execute = promisify(execFile)

/** One Harbor task, as its `task.toml` and `instruction.md` state it. */
export interface HarborTaskPayload {
  /** `[task].name`, such as `terminal-bench/interleaved-vigenere`; the directory name when absent. */
  name: string
  /** The task's directory name inside the dataset's `tasks/`. */
  dir: string
  /** Stable path relative to `tasks/`, including domain directories in nested datasets. */
  relativePath?: string
  /** Absolute path of the task directory, for the grader. */
  taskDir: string
  /** `instruction.md`, verbatim. */
  instruction: string
  /** `[agent].timeout_sec`; null when the task sets none. */
  agentTimeoutSec: number | null
  /** `[verifier].timeout_sec`; null when the task sets none. */
  verifierTimeoutSec: number | null
  /** `[verifier].environment_mode`: `separate` runs the tests in their own image. */
  verifierMode: string | null
  /** `[environment]` requests; null where the task states none. */
  resources: {
    cpus: number | null
    memoryMb: number | null
    storageMb: number | null
    gpus: number
  }
  /** Paths the verifier reads from the agent's environment (`artifacts`, sources only). */
  artifacts: string[]
  /** Native artifact declarations, including target/service and unknown upstream fields. */
  artifactMappings?: Array<Record<string, unknown> & { source: string }>
  /** The complete parsed task configuration. The execution owner preserves its semantics. */
  config?: Record<string, unknown>
  /** Byte identity of the imported task.toml, independent of its declared upstream revision. */
  configDigest?: string
  /** Native metadata, including domain/field/subfield/tags in science datasets. */
  metadata?: Record<string, unknown>
  /** The environment starts more than one container (a docker-compose file). */
  multiContainer: boolean
  /** `[metadata].category`. */
  category: string | null
  /** `[metadata].expert_time_estimate_hours`. */
  expertTimeEstimateHours: number | null
}

export type HarborTaskItem = BenchmarkDatasetItem<HarborTaskPayload>

/** What the verifier returned for one task, or why it did not return. */
export type HarborGradeOutcome =
  | { succeeded: true; value: { reward: number; detail?: string; raw?: Record<string, unknown> } }
  | { succeeded: false; error: string }

export interface HarborBenchmarkOptions<TArtifact> {
  /** Stable benchmark id, such as `terminal-bench@4.0.0`. */
  id: string
  /** A checkout of the dataset: the directory that holds `tasks/`. */
  datasetDir: string
  /** The upstream name, URL, version, revision, rules and contamination status the checkout is. */
  source: BenchmarkSource & { revision: string }
  /** Relative task paths to load, in this order; recursively discover `tasks/` when absent. */
  tasks?: readonly string[]
  /** Run the task's own verifier on the agent's artifact. */
  grade: (item: HarborTaskItem, artifact: TArtifact) => Promise<HarborGradeOutcome>
  /** Split assignment; `deterministicSplit` over the benchmark id and task directory by default. */
  assignSplit?: (itemId: string) => RunSplitTag
}

/** Harbor adapter plus a loader that ignores splits, since a public benchmark reports every task. */
export interface HarborBenchmarkAdapter<TArtifact>
  extends BenchmarkAdapter<HarborTaskItem, HarborTaskPayload, TArtifact> {
  loadAll(): Promise<HarborTaskItem[]>
}

const table = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
const numberOrNull = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null
const textOrNull = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null

/** Read one Harbor task directory. Throws when `task.toml` or `instruction.md` is missing or malformed. */
async function readHarborTask(taskDir: string, relativePath: string): Promise<HarborTaskPayload> {
  const dir = resolve(taskDir)
  const configText = await readFile(join(dir, 'task.toml'), 'utf8')
  const config = parseToml(configText) as Record<string, unknown>
  const instruction = await readFile(join(dir, 'instruction.md'), 'utf8')
  const task = table(config.task)
  const agent = table(config.agent)
  const verifier = table(config.verifier)
  const environment = table(config.environment)
  const metadata = table(config.metadata)
  const artifactMappings = (Array.isArray(config.artifacts) ? config.artifacts : []).map(
    (entry, index) => {
      const source = typeof entry === 'string' ? entry : table(entry).source
      if (typeof source !== 'string' || source.length === 0) {
        throw new Error(`${dir}/task.toml: artifacts[${index}] names no source path`)
      }
      return { ...table(entry), source }
    },
  )
  const environmentFiles = await readdir(join(dir, 'environment')).catch(() => [] as string[])
  const name = dir.split('/').pop() ?? dir
  return {
    name: textOrNull(task.name) ?? name,
    dir: name,
    relativePath,
    taskDir: dir,
    instruction,
    agentTimeoutSec: numberOrNull(agent.timeout_sec),
    verifierTimeoutSec: numberOrNull(verifier.timeout_sec),
    verifierMode: textOrNull(verifier.environment_mode),
    resources: {
      cpus: numberOrNull(environment.cpus),
      memoryMb: numberOrNull(environment.memory_mb),
      storageMb: numberOrNull(environment.storage_mb),
      gpus: numberOrNull(environment.gpus) ?? 0,
    },
    artifacts: artifactMappings.map((entry) => entry.source),
    artifactMappings,
    config,
    configDigest: `sha256:${createHash('sha256').update(configText).digest('hex')}`,
    metadata,
    multiContainer: environmentFiles.some((file) => /compose\.ya?ml$/u.test(file)),
    category: textOrNull(metadata.category),
    expertTimeEstimateHours: numberOrNull(metadata.expert_time_estimate_hours),
  }
}

/** Do not descend into a task's own assets or follow directory symlinks during discovery. */
async function discoverHarborTasks(tasksDir: string, prefix = ''): Promise<string[]> {
  const entries = await readdir(join(tasksDir, prefix), { withFileTypes: true })
  if (entries.some((entry) => entry.name === 'task.toml' && entry.isFile())) {
    if (!prefix) throw new Error(`${tasksDir}: task.toml must be inside a task directory`)
    return [prefix]
  }
  const nested = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) =>
        discoverHarborTasks(tasksDir, prefix ? `${prefix}/${entry.name}` : entry.name),
      ),
  )
  return nested.flat().sort()
}

async function resolveHarborTask(tasksDir: string, name: string): Promise<string> {
  if (
    !name ||
    isAbsolute(name) ||
    name.includes('\\') ||
    name.split('/').some((part) => !part || part === '.' || part === '..')
  )
    throw new Error(`Harbor task path must be a normalized relative path: ${JSON.stringify(name)}`)
  const [root, task] = await Promise.all([realpath(tasksDir), realpath(join(tasksDir, name))])
  const local = relative(root, task)
  if (local === '..' || local.startsWith(`..${sep}`) || isAbsolute(local)) {
    throw new Error(`Harbor task path escapes the dataset: ${name}`)
  }
  return task
}

/** Import a Harbor dataset checkout as a `BenchmarkAdapter` whose scorer is the dataset's own verifier. */
export function createHarborBenchmarkAdapter<TArtifact = string>(
  options: HarborBenchmarkOptions<TArtifact>,
): HarborBenchmarkAdapter<TArtifact> {
  const split =
    options.assignSplit ?? ((itemId: string) => deterministicSplit(`${options.id}::${itemId}`))
  const tasksDir = join(resolve(options.datasetDir), 'tasks')

  async function loadAll(): Promise<HarborTaskItem[]> {
    const names = options.tasks ?? (await discoverHarborTasks(tasksDir))
    if (new Set(names).size !== names.length)
      throw new Error('Harbor task selection contains duplicate paths')
    if (names.length === 0) throw new Error(`${tasksDir}: no Harbor tasks found`)
    return Promise.all(
      names.map(async (dir) => {
        const payload = await readHarborTask(await resolveHarborTask(tasksDir, dir), dir)
        const metadata = payload.metadata ?? {}
        const tags = [
          payload.category,
          metadata.domain,
          metadata.field,
          metadata.subfield,
          ...(Array.isArray(metadata.tags) ? metadata.tags : []),
        ].filter((tag): tag is string => typeof tag === 'string' && tag.length > 0)
        return {
          id: dir,
          payload,
          split: split(dir),
          family: options.source.name ?? 'harbor',
          taskKind: 'harbor-task',
          tags: [...new Set(tags)],
          source: options.source,
          metadata,
        }
      }),
    )
  }

  return {
    id: options.id,
    family: options.source.name ?? 'harbor',
    taskKind: 'harbor-task',
    description:
      `${options.source.name ?? 'Harbor dataset'} ${options.source.version ?? ''} at ${options.source.revision}, scored by its own verifier`.replace(
        /\s+/gu,
        ' ',
      ),
    source: options.source,
    defaultMetric: 'reward',
    loadAll,
    async loadDataset(tag: RunSplitTag) {
      return (await loadAll()).filter((item) => item.split === tag)
    },
    async evaluate(item: HarborTaskItem, artifact: TArtifact): Promise<BenchmarkEvaluation> {
      const outcome = await options.grade(item, artifact)
      if (!outcome.succeeded)
        throw new Error(
          `${options.id} ${item.id}: the verifier did not score this artifact: ${outcome.error}`,
        )
      const { reward, detail, raw } = outcome.value
      if (!(Number.isFinite(reward) && reward >= 0 && reward <= 1)) {
        throw new Error(
          `${options.id} ${item.id}: the verifier returned reward ${reward}, outside [0, 1]`,
        )
      }
      return {
        score: reward,
        passed: reward === 1,
        raw: { ...raw, reward, ...(detail === undefined ? {} : { detail }) },
        ...(detail === undefined ? {} : { notes: detail }),
      }
    },
    assignSplit: split,
  }
}

/**
 * Defaults: `retries` 2 (extra runs after one with no reward), `maxDetailChars` 2000 (bounds
 * `JSON.stringify(detail).length`), `keepImage` true: `--no-delete` keeps the image after a run,
 * yet a later run builds it again unless `task.toml` names a prebuilt `docker_image`, as it does
 * for a case `prepareCaseEnvironment` prepared. `host` (an ssh target, by default the host the case
 * was prepared on) runs Harbor there.
 */
export interface HarborPatchGradeOptions {
  harborBin?: string
  jobsDir?: string
  retries?: number
  maxDetailChars?: number
  timeoutMs?: number
  env?: Record<string, string>
  keepImage?: boolean
  host?: string
}

const SOLVE_SH =
  '#!/bin/bash\nset -euo pipefail\npatch="$(dirname "$0")/patch.diff"\n' +
  'if [ -s "$patch" ]; then git apply --binary "$patch"; fi\n'

/** The last characters of `text` without ANSI codes, so that its JSON string fits in `max`. */
function detailTail(text: string, max: number): string {
  let tail = stripVTControlCharacters(text).slice(-max)
  while (tail && JSON.stringify(tail).length > max) tail = tail.slice(1)
  return tail
}

/**
 * Harbor on ssh host `host`: the task is mirrored under `~/agent-eval-harbor` at its local path,
 * and the job's directory comes back to the local jobs dir and leaves the host.
 */
async function remoteHarbor(host: string, args: string[], run: object) {
  const [task, jobsDir, job] = [args[2], args[6], args.at(-1)] as [string, string, string]
  const q = (text: string) => `'${text.replaceAll("'", "'\\''")}'`
  const at = (path: string) => `~/${q(`agent-eval-harbor${path}`)}`
  const remote = args.map((arg) => (arg === task || arg === jobsDir ? at(arg) : q(arg)))
  await execute('ssh', [host, `mkdir -p ${at(task)} ${at(jobsDir)}`])
  await execute('rsync', ['-a', '--delete', `${task}/`, `${host}:agent-eval-harbor${task}/`])
  const harbor = `cd /tmp && env -u DOCKER_HOST PATH="$HOME/.local/bin:$PATH" harbor`
  try {
    await execute('ssh', [host, `${harbor} ${remote.join(' ')}`], run)
  } finally {
    await mkdir(jobsDir, { recursive: true })
    const back = [`${host}:agent-eval-harbor${jobsDir}/${job}/`, `${jobsDir}/${job}/`]
    await execute('rsync', ['-a', ...back]).catch(() => undefined)
    const clean = `rm -rf ${at(dirname(task))} ${at(`${jobsDir}/${job}`)}`
    await execute('ssh', [host, clean]).catch(() => undefined)
  }
}

/**
 * A `grade` callback that scores `{ patch }` with the task's own verifier: Harbor's oracle agent
 * runs a `solution/solve.sh` that applies the patch (`git apply --binary`) in the environment's
 * working directory, on a copy of the task. An empty patch changes nothing. A run with no reward
 * is retried, then reported as `succeeded: false`, never as a reward of 0; so is a patch that does
 * not apply, without a retry.
 */
export function gradeHarborPatch(
  options: HarborPatchGradeOptions = {},
): (item: HarborTaskItem, artifact: { patch: string }) => Promise<HarborGradeOutcome> {
  const { harborBin = 'harbor', retries = 2, maxDetailChars = 2000, keepImage = true } = options
  const { timeoutMs: timeout, env: extra } = options
  const run = { env: { ...process.env, ...extra }, timeout, maxBuffer: 1 << 26 }
  return async (item, artifact) => {
    const work = await mkdtemp(join(tmpdir(), 'harbor-grade-'))
    try {
      const task = join(work, item.payload.dir)
      await cp(item.payload.taskDir, task, { recursive: true })
      await rm(join(task, 'solution'), { recursive: true, force: true })
      await mkdir(join(task, 'solution'))
      await writeFile(join(task, 'solution/patch.diff'), artifact.patch)
      await writeFile(join(task, 'solution/solve.sh'), SOLVE_SH, { mode: 0o755 })
      const prepared = preparedImage(item)
      if (prepared) {
        const config = parseToml(await readFile(join(task, 'task.toml'), 'utf8'))
        config.environment = { ...table(config.environment), docker_image: await prepared.image }
        await writeFile(join(task, 'task.toml'), stringifyToml(config))
      }
      const host = options.host ?? prepared?.host
      const jobsDir = resolve(options.jobsDir ?? join(work, 'jobs'))
      const errors: string[] = []
      const keep = keepImage ? '--no-delete' : '--delete'
      const args = ['run', '-p', task, '-a', 'oracle', '-o', jobsDir, '-q', keep, '--job-name']
      for (let attempt = 1; attempt <= retries + 1; attempt += 1) {
        const job = `${item.payload.dir}-${randomUUID()}`
        const harbor = host
          ? remoteHarbor(host, [...args, job], run)
          : execute(harborBin, [...args, job], run)
        const failure = await harbor.then(
          () => null,
          (error: Error) => detailTail(error.message, 500),
        )
        const trial = (await readdir(join(jobsDir, job), { withFileTypes: true }).catch(() => []))
          .filter((entry) => entry.isDirectory())
          .map((entry) => join(jobsDir, job, entry.name, '/'))[0]
        const read = (path: string) => readFile(`${trial}${path}`, 'utf8').catch(() => '')
        const result = table(
          trial === undefined ? {} : JSON.parse((await read('result.json')) || '{}'),
        )
        const reward = numberOrNull(table(table(result.verifier_result).rewards).reward)
        // A patch the oracle could not apply scores nothing: Harbor still verified the base tree.
        const solve = (await read('agent/exit-code.txt')).trim()
        const oracle = await read('agent/oracle.txt')
        const error = `solve.sh exited ${solve || 0}: ${detailTail(oracle, 500)}`
        if (solve || /^error:/mu.test(oracle)) return { succeeded: false, error }
        if (reward !== null) {
          const detail = detailTail(await read('verifier/test-stdout.txt'), maxDetailChars)
          return { succeeded: true, value: { reward, detail } }
        }
        const exception = textOrNull(table(result.exception_info).exception_message)
        errors.push(`attempt ${attempt}: ${failure ?? exception ?? 'harbor recorded no reward'}`)
      }
      return { succeeded: false, error: errors.join('; ') }
    } finally {
      await rm(work, { recursive: true, force: true })
    }
  }
}
