import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CorpusSpec } from '../../src/trajectory-replay/corpus'
import type { ReplayExecBackend, ReplayExecResult } from '../../src/trajectory-replay/exec'
import type { RecordedTrajectoryStep } from '../../src/trajectory-replay/steps'

export function fixtureStep(
  id: number,
  action: string,
  returncode: number | null,
  output = '',
): RecordedTrajectoryStep {
  return {
    step_id: id,
    action,
    observation:
      returncode === null
        ? null
        : `\n<returncode>${returncode}</returncode>\n<output>\n${output}\n</output>`,
  }
}

/** Decodes the base64-piped payload the replay runner sends to a session. */
export function wrappedPayload(command: string): string {
  const match = /printf %s ([A-Za-z0-9+/=]+) \| base64 -d \| sh$/.exec(command)
  if (!match) throw new Error(`not a wrapped exec command: ${command}`)
  return Buffer.from(match[1]!, 'base64').toString('utf8')
}

/** Backend that answers per decoded action and records every session's actions. */
export function scriptedBackend(
  script: (action: string) => ReplayExecResult,
): ReplayExecBackend & { executed: string[][] } {
  const executed: string[][] = []
  return {
    executed,
    async open() {
      const session: string[] = []
      executed.push(session)
      return {
        async exec(command: string): Promise<ReplayExecResult> {
          const action = wrappedPayload(command)
          session.push(action)
          return script(action)
        },
        async close() {},
      }
    },
  }
}

export interface FixtureTrajectory {
  readonly trajId: string
  readonly steps?: RecordedTrajectoryStep[]
  readonly goldIncorrectSteps?: number[]
  /** undefined = no swe_raw dir at all (a case with no recorded environment). */
  readonly raw?: {
    readonly baseImage?: string
    readonly runConfigCwd?: string
    readonly dockerCwd?: string
    readonly timeoutSeconds?: number
    readonly taskMessage?: string
  }
  readonly taskMd?: string
}

/** Writes a labels file + prepared dir mirroring the corpus layout. */
export function writeFixtureCorpus(
  root: string,
  name: string,
  trajectories: readonly FixtureTrajectory[],
): CorpusSpec {
  const preparedDir = join(root, `${name}-prepared`)
  const labels = trajectories.map((traj) => ({
    traj_id: traj.trajId,
    incorrect_stages:
      traj.goldIncorrectSteps && traj.goldIncorrectSteps.length > 0
        ? [{ stage_id: 1, incorrect_step_ids: traj.goldIncorrectSteps }]
        : [],
  }))
  const labelsPath = join(root, `${name}-labels.json`)
  writeFileSync(labelsPath, JSON.stringify(labels, null, 2))
  for (const traj of trajectories) {
    const normalized = join(preparedDir, 'normalized', traj.trajId)
    mkdirSync(normalized, { recursive: true })
    writeFileSync(join(normalized, 'steps.json'), JSON.stringify(traj.steps ?? []))
    if (traj.taskMd) writeFileSync(join(normalized, 'task.md'), traj.taskMd)
    if (traj.raw) {
      const rawDir = join(preparedDir, 'extracted', traj.trajId, 'swe_raw', 'agent')
      mkdirSync(rawDir, { recursive: true })
      const environment: Record<string, unknown> = {}
      if (traj.raw.runConfigCwd !== undefined) environment.cwd = traj.raw.runConfigCwd
      if (traj.raw.timeoutSeconds !== undefined) environment.timeout = traj.raw.timeoutSeconds
      writeFileSync(
        join(rawDir, `${traj.trajId}.traj.json`),
        JSON.stringify({
          info: {
            docker_config:
              traj.raw.baseImage !== undefined || traj.raw.dockerCwd !== undefined
                ? { base_image: traj.raw.baseImage, cwd: traj.raw.dockerCwd }
                : undefined,
            config: { environment },
          },
          messages: traj.raw.taskMessage
            ? [
                { role: 'system', content: 'You are mini-SWE.' },
                { role: 'user', content: traj.raw.taskMessage },
              ]
            : [],
        }),
      )
    } else {
      mkdirSync(join(preparedDir, 'extracted', traj.trajId), { recursive: true })
    }
  }
  return { name, labelsPath, preparedDir }
}
