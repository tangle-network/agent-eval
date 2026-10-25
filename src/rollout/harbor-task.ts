import { createHash } from 'node:crypto'
import {
  link,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

import { assertCodeSurfaceIdentity } from '../campaign/surface-identity'
import type { CodeSurface } from '../campaign/types'
import { type CompletionVerdict, completionVerdict } from '../completion-verifier'
import { canonicalString } from '../ledger-core/canonical'
import { deepFreezeCanonicalJson } from '../ledger-core/deep-freeze'
import { assertMinted, type MintedRolloutLine } from './schema'

/** Existing completion checks required to admit a verified episode as a runnable task. */
export const HARBOR_TASK_CHECKS = [
  'base-bundle',
  'acceptance',
  'production-delta',
  'dangling-references',
  'merge-followup',
] as const

export interface HarborTaskFile {
  /** Relative path in the published task. */
  readonly path: string
  /** Actual staged path; task.toml is not published until verification succeeds. */
  readonly stagedPath: string
  readonly sha256: string
  readonly byteLength: number
}

export interface HarborTaskVerification {
  /** Digest binding this episode, immutable source identity, merge and every task file. */
  readonly taskId: string
  readonly rolloutId: string
  readonly episodeSha256: string
  readonly task: MintedRolloutLine['task']
  readonly source: Omit<CodeSurface, 'worktreeRef' | 'summary' | 'baseRef'>
  readonly mergeCommit: string
  readonly files: readonly HarborTaskFile[]
}

export interface WriteHarborTaskOptions {
  /** Fresh task directory, normally <dataset>/tasks/<task>. Existing paths are refused. */
  readonly directory: string
  readonly episode: MintedRolloutLine
  readonly surface: CodeSurface
  readonly mergeCommit: string
  /** Harbor's org/name task name. */
  readonly name: string
  readonly instruction: string
  /** Caller image with Git/dependencies and a configured user able to clone into /workspace. */
  readonly image: string
  /** Git bundle containing the base and its ancestors only, never the answer/head/merge. */
  readonly baseBundle: Uint8Array
  readonly commands: {
    readonly acceptance: string
    readonly productionDelta: string
    readonly danglingReferences: string
  }
  readonly agentTimeoutSec: number
  readonly verifierTimeoutSec: number
  /**
   * Trusted caller execution boundary. Inspect the actual staged bundle and file hashes.
   * base-bundle proves exact base/tree, base-only closure and no answer material; the
   * three verifier checks prove the supplied commands actually passed on this candidate
   * (strict production-line decrease, zero dangling refs); merge-followup proves this
   * candidate merged with base=merge^1 and a closed, explicitly checked no-fix-forward
   * followup window. Every check must cite receipts bound to taskId, not a title/keyword.
   * Unknown, absent, open followup and provider eligibility are not affirmative evidence.
   */
  readonly verify: (
    request: HarborTaskVerification,
    signal?: AbortSignal,
  ) => Promise<CompletionVerdict>
  readonly signal?: AbortSignal
}

const digest = (bytes: Uint8Array | string): string =>
  `sha256:${createHash('sha256').update(bytes).digest('hex')}`

function admitted(verdict: CompletionVerdict, taskId: string): void {
  if (verdict.taskId !== taskId) throw new Error('Harbor task verification identity mismatch')
  if (!Array.isArray(verdict.requirements))
    throw new Error('Harbor task requires completion checks')
  for (const row of verdict.requirements) {
    if (
      !row ||
      typeof row.reqId !== 'string' ||
      !row.reqId.trim() ||
      row.correct !== true ||
      row.structurallyPresent !== true ||
      row.satisfied !== true ||
      row.unmeasured !== undefined ||
      !Array.isArray(row.evidence) ||
      !row.evidence.some((value) => typeof value === 'string' && value.trim().length > 0)
    ) {
      throw new Error(`Harbor task requires measured passing ${row?.reqId ?? 'invalid'} evidence`)
    }
  }
  for (const id of HARBOR_TASK_CHECKS) {
    if (verdict.requirements.filter((row) => row.reqId === id).length !== 1) {
      throw new Error(`Harbor task requires exactly one ${id} check`)
    }
  }
  const derived = completionVerdict({ taskId, requirements: verdict.requirements })
  if (
    derived.fullyComplete !== true ||
    verdict.fullyComplete !== true ||
    verdict.valid !== true ||
    verdict.score !== 1 ||
    verdict.completionRate !== 1 ||
    verdict.unmeasuredCount !== 0
  ) {
    throw new Error('Harbor task verification is incomplete')
  }
}

/**
 * Write a Harbor directory from an admitted canonical episode, without executing it.
 * Failed admission leaves diagnostic files but no task.toml, so the directory is not
 * loadable as a task. The caller owns execution, receipt truth and artifact retention.
 */
export async function writeHarborTask(options: WriteHarborTaskOptions): Promise<string> {
  // Capture inputs before the first await; the callback cannot retarget caller-owned data.
  const episode = assertMinted(JSON.parse(canonicalString(options.episode)), 'Harbor task episode')
  const surface = JSON.parse(canonicalString(options.surface)) as CodeSurface
  assertCodeSurfaceIdentity(surface)
  const { kind, baseCommit, baseTree, candidateCommit, candidateTree, patch } = surface
  const source = { kind, baseCommit, baseTree, candidateCommit, candidateTree, patch }
  const {
    directory: inputDirectory,
    name,
    instruction,
    image,
    mergeCommit,
    agentTimeoutSec,
    verifierTimeoutSec,
    verify,
    signal,
  } = options
  const commands = { ...options.commands }
  const bundle = Uint8Array.from(options.baseBundle)
  if (
    episode.outcome.reward !== 1 ||
    !episode.outcome.is_completed ||
    episode.outcome.is_truncated ||
    episode.outcome.error !== null ||
    episode.outcome.realness_screened !== true ||
    episode.outcome.realness_gated === true
  ) {
    throw new Error('Harbor task requires a completed, screened, passing episode')
  }
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(mergeCommit)) {
    throw new Error('Harbor task requires a full merge commit identity')
  }
  if (
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]*\/[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name) ||
    !instruction.trim() ||
    !bundle.length
  )
    throw new Error('Invalid Harbor task input')
  if (!/^[a-zA-Z0-9][a-zA-Z0-9./:_-]*@sha256:[a-f0-9]{64}$/.test(image)) {
    throw new Error('Harbor task image must be pinned by sha256 digest')
  }
  for (const timeout of [agentTimeoutSec, verifierTimeoutSec]) {
    if (!Number.isSafeInteger(timeout) || timeout <= 0) throw new Error('Invalid Harbor timeout')
  }
  if (Object.values(commands).some((command) => typeof command !== 'string' || !command.trim())) {
    throw new Error('All three Harbor verifier commands are required')
  }
  const config =
    `schema_version = "1.3"\n[task]\nname = "${name}"\n` +
    `[agent]\ntimeout_sec = ${agentTimeoutSec}\n[verifier]\ntimeout_sec = ${verifierTimeoutSec}\n`
  const files: Record<string, string | Uint8Array> = {
    'task.toml': config,
    'instruction.md': instruction,
    'environment/base.bundle': bundle,
    'environment/Dockerfile':
      `FROM ${image}\nCOPY --chmod=0444 base.bundle /tmp/base.bundle\n` +
      `RUN git clone --no-checkout /tmp/base.bundle /workspace/repo \\\n && git -C /workspace/repo checkout --detach ${baseCommit} \\\n && test "$(git -C /workspace/repo rev-parse HEAD)" = "${baseCommit}"\nWORKDIR /workspace/repo\n`,
    'tests/acceptance.sh': commands.acceptance,
    'tests/production-delta.sh': commands.productionDelta,
    'tests/dangling-references.sh': commands.danglingReferences,
    'tests/test.sh':
      '#!/bin/sh\nset -eu\nproject=${1:-/workspace/repo}\n' +
      'tests=${2:-/tests}\nrewards=${3:-/logs/verifier}\nmkdir -p "$rewards"\n' +
      'printf "0\\n" > "$rewards/reward.txt"\ncd "$project"\n' +
      `git cat-file -e ${baseCommit}^{commit}\ngit merge-base --is-ancestor ${baseCommit} HEAD\n` +
      'sh "$tests/acceptance.sh"\nsh "$tests/production-delta.sh"\nsh "$tests/dangling-references.sh"\n' +
      'printf "1\\n" > "$rewards/reward.txt"\n',
  }
  const directory = resolve(inputDirectory)
  signal?.throwIfAborted()
  if ((await realpath(dirname(directory))) !== dirname(directory)) {
    throw new Error('Harbor task parent must not traverse symlinks')
  }
  await mkdir(directory, { mode: 0o700 })
  await mkdir(join(directory, 'environment'))
  await mkdir(join(directory, 'tests'))
  const staged: HarborTaskFile[] = []
  for (const [path, bytes] of Object.entries(files)) {
    const stagedPath = join(directory, path === 'task.toml' ? '.task.toml.pending' : path)
    await writeFile(stagedPath, bytes, { flag: 'wx', mode: path.endsWith('.sh') ? 0o700 : 0o600 })
    staged.push(
      Object.freeze({
        path,
        stagedPath,
        sha256: digest(bytes),
        byteLength: typeof bytes === 'string' ? Buffer.byteLength(bytes) : bytes.byteLength,
      }),
    )
  }
  const identity = {
    rolloutId: episode.rollout_id,
    episodeSha256: digest(canonicalString(episode)),
    task: episode.task,
    source,
    mergeCommit,
    files: staged.map(({ path, sha256, byteLength }) => ({ path, sha256, byteLength })),
  }
  const taskId = digest(canonicalString(identity))
  const request = deepFreezeCanonicalJson({ ...identity, taskId, files: staged })
  signal?.throwIfAborted()
  const verdict = JSON.parse(canonicalString(await verify(request, signal))) as CompletionVerdict
  signal?.throwIfAborted()
  admitted(verdict, taskId)
  // No callback may add answer material to the build context or redirect a parent directory.
  for (const folder of ['', 'environment', 'tests']) {
    const path = join(directory, folder)
    if (!(await lstat(path)).isDirectory() || (await realpath(path)) !== path) {
      throw new Error('Harbor task directory changed during verification')
    }
    const expected =
      folder === ''
        ? ['.task.toml.pending', 'environment', 'instruction.md', 'tests']
        : Object.keys(files)
            .filter((file) => file.startsWith(`${folder}/`))
            .map((file) => file.slice(folder.length + 1))
    if (canonicalString((await readdir(path)).sort()) !== canonicalString(expected.sort())) {
      throw new Error('Harbor task contains unexpected files')
    }
  }
  for (const file of staged) {
    const info = await lstat(file.stagedPath)
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      digest(await readFile(file.stagedPath)) !== file.sha256
    ) {
      throw new Error(`Harbor task file changed during verification: ${file.path}`)
    }
  }
  await writeFile(
    join(directory, 'tests/verification.json'),
    canonicalString({ identity, taskId, verdict }),
    { flag: 'wx', mode: 0o600 },
  )
  signal?.throwIfAborted()
  await link(join(directory, '.task.toml.pending'), join(directory, 'task.toml'))
  await unlink(join(directory, '.task.toml.pending'))
  return directory
}
