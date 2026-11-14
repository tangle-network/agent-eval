import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { readFile, realpath, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { redact, redactText } from '../trace/redact'
import type { HarborGradeOutcome, HarborTaskItem } from './harbor'

const execute = promisify(execFile)
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
const digest = (text: string) => `sha256:${createHash('sha256').update(text).digest('hex')}`

export interface HarborTrialArtifact {
  trialDir: string
  /** Optional expected original-trial identities; mismatch refuses before launching a verifier. */
  sourceTrialId?: string
  sourceTaskChecksum?: string
  sourceResultDigest?: string
}

export interface HarborTrialGradeOptions {
  /** Existing durable output parent outside the source trial. All new evidence is retained here. */
  trialsDir: string
  harborBin?: string
  /** Explicit native reward key; never take an arbitrary metric from a multi-metric result. */
  rewardKey: string
  environment?: string
  timeoutMs?: number
  env?: Record<string, string>
}

/**
 * Re-run Harbor's separate verifier on a genuine retained trial. Harbor owns artifact-manifest,
 * coverage and separate-verifier checks. Original and current task identities remain distinct:
 * regrading old outputs with a new verifier does not establish a new agent solve.
 *
 * Protocol source: harbor-framework/harbor@ec6aeab7fe0eb51df52b4e72c524daf5ea9cc5f4,
 * src/harbor/cli/trials.py, trial/regrade.py and models/trial/result.py. No fallback oracle run.
 */
export function gradeHarborTrial(
  options: HarborTrialGradeOptions,
): (item: HarborTaskItem, artifact: HarborTrialArtifact) => Promise<HarborGradeOutcome> {
  if (!options.trialsDir.trim() || !options.rewardKey.trim()) {
    throw new Error('gradeHarborTrial requires a retained trialsDir and rewardKey')
  }
  const redaction = { knownSecrets: Object.values(options.env ?? {}) }
  return async (item, artifact) => {
    try {
      const source = await realpath(artifact.trialDir)
      const sourceText = await readFile(join(source, 'result.json'), 'utf8')
      const sourceResult = object(JSON.parse(sourceText))
      if (
        sourceResult.task_name !== item.payload.name ||
        (artifact.sourceTrialId !== undefined && artifact.sourceTrialId !== sourceResult.id) ||
        (artifact.sourceTaskChecksum !== undefined &&
          artifact.sourceTaskChecksum !== sourceResult.task_checksum) ||
        (artifact.sourceResultDigest !== undefined &&
          artifact.sourceResultDigest !== digest(sourceText))
      ) {
        return { succeeded: false, error: 'retained Harbor source trial identity mismatch' }
      }
      const parent = await realpath(options.trialsDir)
      const local = relative(source, parent)
      if (local === '' || (!local.startsWith(`..${sep}`) && local !== '..' && !isAbsolute(local))) {
        return { succeeded: false, error: 'Harbor regrade output must be outside the source trial' }
      }
      const sourceConfig = await readFile(join(source, 'config.json'), 'utf8').catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return null
          throw error
        },
      )
      const steps = Array.isArray(sourceResult.step_results) ? sourceResult.step_results : []
      const manifestPaths = steps.length
        ? steps.map((step) => {
            const name = object(step).step_name
            if (
              typeof name !== 'string' ||
              !name ||
              name.includes('/') ||
              name.includes('\\') ||
              name === '.' ||
              name === '..'
            ) {
              throw new Error('Harbor source has an invalid step name')
            }
            return `steps/${name}/artifacts/manifest.json`
          })
        : ['artifacts/manifest.json']
      const manifests = await Promise.all(
        manifestPaths.map(async (path) => {
          const text = await readFile(join(source, path), 'utf8')
          return { path, digest: digest(text), manifest: JSON.parse(text) as unknown }
        }),
      )
      const taskConfig = await readFile(join(item.payload.taskDir, 'task.toml'), 'utf8')
      if (
        item.payload.configDigest !== undefined &&
        item.payload.configDigest !== digest(taskConfig)
      ) {
        return {
          succeeded: false,
          error: 'Harbor verifier task configuration changed since import',
        }
      }
      const original = {
        result: sourceResult,
        resultDigest: digest(sourceText),
        config: sourceConfig === null ? null : (JSON.parse(sourceConfig) as unknown),
        configDigest: sourceConfig === null ? null : digest(sourceConfig),
        manifests,
      }
      const verifierTask = {
        id: item.id,
        source: item.source ?? null,
        taskDir: item.payload.taskDir,
        taskConfigDigest: digest(taskConfig),
        config: item.payload.config ?? null,
      }
      const name = `regrade-${randomUUID()}`
      const output = join(parent, name)
      const args = [
        'trial',
        'regrade',
        source,
        '-p',
        item.payload.taskDir,
        '-e',
        options.environment ?? 'docker',
        '--trial-name',
        name,
        '--trials-dir',
        parent,
      ]
      const attemptPath = join(parent, `${name}.agent-eval-attempt.json`)
      const attempt = {
        command: [options.harborBin ?? 'harbor', ...args],
        sourceTrialDir: source,
        trialDir: output,
        original,
        verifierTask,
        rewardKey: options.rewardKey,
      }
      const retain = async (extra: Record<string, unknown>) => {
        const { value, report } = redact({ ...attempt, ...extra }, redaction)
        await writeFile(
          attemptPath,
          `${JSON.stringify({ ...value, redaction: report }, null, 2)}\n`,
        )
      }
      await retain({ status: 'started' })
      let failure: string | undefined
      try {
        await execute(options.harborBin ?? 'harbor', args, {
          env: { ...process.env, ...options.env },
          timeout: options.timeoutMs,
          maxBuffer: 1 << 26,
        })
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error)
      }
      let result: Record<string, unknown>
      try {
        result = object(JSON.parse(await readFile(join(output, 'result.json'), 'utf8')))
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        const reason = `${failure ? `${failure}; ` : ''}no readable regrade result: ${detail}`
        await retain({ status: 'unmeasured', commandError: failure ?? null, error: reason })
        return { succeeded: false, error: redactText(reason, redaction) }
      }
      const nativeSource = object(object(result.config).source_trial)
      const bound =
        nativeSource.action === 'regrade' &&
        nativeSource.trial_id === sourceResult.id &&
        typeof nativeSource.path === 'string' &&
        resolve(nativeSource.path) === source
      const { value: raw } = redact(
        {
          sourceTrialDir: source,
          trialDir: output,
          original,
          verifierTask,
          result,
          attemptPath,
          commandError: failure ?? null,
        },
        redaction,
      )
      // reward_valid includes Harbor's exception policies, including per-step failures.
      if (
        failure ||
        !bound ||
        result.task_name !== item.payload.name ||
        result.reward_valid !== true
      ) {
        const reason = failure ?? 'Harbor regrade has no valid reward or source-trial binding'
        await retain({ status: 'unmeasured', result, error: reason })
        return {
          succeeded: false,
          error: `${redactText(reason, redaction)}; evidence retained at ${attemptPath}`,
        }
      }
      const rewards = object(object(result.verifier_result).rewards)
      const reward = rewards[options.rewardKey]
      if (typeof reward !== 'number' || !Number.isFinite(reward) || reward < 0 || reward > 1) {
        const reason = `Harbor reward ${options.rewardKey} is missing or outside [0, 1]`
        await retain({ status: 'unmeasured', result, error: reason })
        return { succeeded: false, error: `${reason}; evidence retained at ${attemptPath}` }
      }
      await retain({ status: 'measured', result, reward })
      return {
        succeeded: true,
        value: { reward, raw, detail: `Harbor regrade retained at ${output}` },
      }
    } catch (error) {
      return {
        succeeded: false,
        error: redactText(error instanceof Error ? error.message : String(error), redaction),
      }
    }
  }
}
