/**
 * Replay-ready image derivation.
 *
 * A recorded trajectory names the image it ran in, but the image is not always
 * runnable as-is: sandbox platforms pin customer commands to a non-root
 * identity, so a root-owned working tree must be chowned before the replay can
 * write to it. `ImagePreparer` is that step, injectable so a consumer whose
 * images are already replay-ready supplies its own no-op or none at all.
 */

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export type ImagePreparation =
  | {
      readonly succeeded: true
      readonly value: { derivedImage: string; pulled: boolean; built: boolean }
    }
  | { readonly succeeded: false; readonly error: string }

export interface ImagePreparer {
  ensure(image: string, cwd: string): Promise<ImagePreparation>
}

export interface DockerImagePreparerOptions {
  readonly pullTimeoutMs?: number
  readonly buildTimeoutMs?: number
}

export function derivedImageTag(image: string, cwd: string): string {
  const digest = createHash('sha256').update(`${image}\n${cwd}`).digest('hex').slice(0, 12)
  return `ctb-replay:${digest}-uid1000`
}

/**
 * Pulls the base image when absent and builds `FROM <base>; RUN chown -R
 * 1000:1000 <cwd>` tagged by content hash, so repeated batches reuse both
 * the pull and the build. cwd `/` skips the chown (never chown -R /) and
 * replays on the base image directly.
 */
export function dockerImagePreparer(options: DockerImagePreparerOptions = {}): ImagePreparer {
  const pullTimeoutMs = options.pullTimeoutMs ?? 1_200_000
  const buildTimeoutMs = options.buildTimeoutMs ?? 900_000
  const imageExists = async (tag: string): Promise<boolean> => {
    try {
      await execFileAsync('docker', ['image', 'inspect', tag], { maxBuffer: 8 * 1024 * 1024 })
      return true
    } catch {
      return false
    }
  }
  const errorTail = (err: unknown): string => {
    const raw =
      err &&
      typeof err === 'object' &&
      'stderr' in err &&
      typeof err.stderr === 'string' &&
      err.stderr.length > 0
        ? err.stderr
        : err instanceof Error
          ? err.message
          : String(err)
    return raw.trim().split('\n').slice(-3).join(' | ').slice(0, 400)
  }
  return {
    async ensure(image: string, cwd: string): Promise<ImagePreparation> {
      if (cwd === '/') {
        if (await imageExists(image)) {
          return { succeeded: true, value: { derivedImage: image, pulled: false, built: false } }
        }
        try {
          await execFileAsync('docker', ['pull', image], {
            timeout: pullTimeoutMs,
            maxBuffer: 32 * 1024 * 1024,
          })
        } catch (err) {
          return { succeeded: false, error: `pull ${image}: ${errorTail(err)}` }
        }
        return { succeeded: true, value: { derivedImage: image, pulled: true, built: false } }
      }
      const derived = derivedImageTag(image, cwd)
      if (await imageExists(derived)) {
        return { succeeded: true, value: { derivedImage: derived, pulled: false, built: false } }
      }
      let pulled = false
      if (!(await imageExists(image))) {
        try {
          await execFileAsync('docker', ['pull', image], {
            timeout: pullTimeoutMs,
            maxBuffer: 32 * 1024 * 1024,
          })
          pulled = true
        } catch (err) {
          return { succeeded: false, error: `pull ${image}: ${errorTail(err)}` }
        }
      }
      const contextDir = mkdtempSync(join(tmpdir(), 'ctb-replay-image-'))
      const quotedCwd = `'${cwd.replaceAll("'", `'\\''`)}'`
      writeFileSync(
        join(contextDir, 'Dockerfile'),
        `FROM ${image}\nRUN chown -R 1000:1000 ${quotedCwd}\n`,
      )
      try {
        await execFileAsync('docker', ['build', '-t', derived, contextDir], {
          timeout: buildTimeoutMs,
          maxBuffer: 32 * 1024 * 1024,
        })
      } catch (err) {
        return { succeeded: false, error: `build ${derived} from ${image}: ${errorTail(err)}` }
      }
      return { succeeded: true, value: { derivedImage: derived, pulled, built: true } }
    },
  }
}
