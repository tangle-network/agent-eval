/**
 * A Harbor dataset as a `BenchmarkAdapter`.
 *
 * Harbor (https://harborframework.com) lays out each task as a directory with `task.toml`,
 * `instruction.md`, the agent's `environment/`, and the `tests/` its verifier runs, usually in a
 * verifier image of their own. This importer reads a local checkout of such a dataset, at the
 * revision the caller pins in `source`, into `BenchmarkDatasetItem`s.
 *
 * Scoring stays Harbor's. `evaluate` hands the task and the agent's artifact to the caller's
 * `grade` callback, which runs the task's own verifier (for example `harbor run -p <taskDir>`
 * with an agent that installs the collected artifacts) and reports its reward. This package does
 * not start containers. A verifier that did not run is an error, never a score of zero.
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { parse as parseToml } from 'smol-toml'

import type { RunSplitTag } from '../run-record'
import type {
  BenchmarkAdapter,
  BenchmarkDatasetItem,
  BenchmarkEvaluation,
  BenchmarkSource,
} from './types'
import { deterministicSplit } from './types'

/** One Harbor task, as its `task.toml` and `instruction.md` state it. */
export interface HarborTaskPayload {
  /** `[task].name`, such as `terminal-bench/interleaved-vigenere`; the directory name when absent. */
  name: string
  /** The task's directory name inside the dataset's `tasks/`. */
  dir: string
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
  | { succeeded: true; value: { reward: number; detail?: string } }
  | { succeeded: false; error: string }

export interface HarborBenchmarkOptions<TArtifact> {
  /** Stable benchmark id, such as `terminal-bench@4.0.0`. */
  id: string
  /** A checkout of the dataset: the directory that holds `tasks/`. */
  datasetDir: string
  /** The upstream name, URL, version, revision, rules and contamination status the checkout is. */
  source: BenchmarkSource & { revision: string }
  /** Task directory names to load, in this order; every task under `tasks/` when absent. */
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
export async function readHarborTask(taskDir: string): Promise<HarborTaskPayload> {
  const dir = resolve(taskDir)
  const config = parseToml(await readFile(join(dir, 'task.toml'), 'utf8')) as Record<
    string,
    unknown
  >
  const instruction = await readFile(join(dir, 'instruction.md'), 'utf8')
  const task = table(config.task)
  const agent = table(config.agent)
  const verifier = table(config.verifier)
  const environment = table(config.environment)
  const metadata = table(config.metadata)
  const artifacts = (Array.isArray(config.artifacts) ? config.artifacts : []).map(
    (entry, index) => {
      const source = typeof entry === 'string' ? entry : table(entry).source
      if (typeof source !== 'string' || source.length === 0) {
        throw new Error(`${dir}/task.toml: artifacts[${index}] names no source path`)
      }
      return source
    },
  )
  const environmentFiles = await readdir(join(dir, 'environment')).catch(() => [] as string[])
  const name = dir.split('/').pop() ?? dir
  return {
    name: textOrNull(task.name) ?? name,
    dir: name,
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
    artifacts,
    multiContainer: environmentFiles.some((file) => /compose\.ya?ml$/u.test(file)),
    category: textOrNull(metadata.category),
    expertTimeEstimateHours: numberOrNull(metadata.expert_time_estimate_hours),
  }
}

/** Import a Harbor dataset checkout as a `BenchmarkAdapter` whose scorer is the dataset's own verifier. */
export function createHarborBenchmarkAdapter<TArtifact = string>(
  options: HarborBenchmarkOptions<TArtifact>,
): HarborBenchmarkAdapter<TArtifact> {
  const split =
    options.assignSplit ?? ((itemId: string) => deterministicSplit(`${options.id}::${itemId}`))
  const tasksDir = join(resolve(options.datasetDir), 'tasks')

  async function loadAll(): Promise<HarborTaskItem[]> {
    const names =
      options.tasks ??
      (
        await Promise.all(
          (
            await readdir(tasksDir)
          ).map(async (entry) =>
            (await stat(join(tasksDir, entry, 'task.toml')).catch(() => null)) === null
              ? null
              : entry,
          ),
        )
      )
        .filter((entry): entry is string => entry !== null)
        .sort()
    return Promise.all(
      names.map(async (dir) => {
        const payload = await readHarborTask(join(tasksDir, dir))
        return {
          id: dir,
          payload,
          split: split(dir),
          family: options.source.name ?? 'harbor',
          taskKind: 'harbor-task',
          tags: payload.category === null ? [] : [payload.category],
          source: options.source,
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
      const { reward, detail } = outcome.value
      if (!(Number.isFinite(reward) && reward >= 0 && reward <= 1)) {
        throw new Error(
          `${options.id} ${item.id}: the verifier returned reward ${reward}, outside [0, 1]`,
        )
      }
      return {
        score: reward,
        passed: reward === 1,
        raw: { reward, ...(detail === undefined ? {} : { detail }) },
      }
    },
    assignSplit: split,
  }
}
