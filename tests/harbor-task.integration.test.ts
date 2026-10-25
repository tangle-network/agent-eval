import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, describe, expect, it } from 'vitest'

import { createHarborBenchmarkAdapter } from '../src/benchmarks/index'
import type { CodeSurface } from '../src/campaign/index'
import { completionVerdict } from '../src/index'
import { fixtureRolloutLine } from '../src/rollout/fixtures'
import {
  HARBOR_TASK_CHECKS,
  type HarborTaskVerification,
  type WriteHarborTaskOptions,
  writeHarborTask,
} from '../src/rollout/index'

const execute = promisify(execFile)
const roots: string[] = []
afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
})

async function command(cwd: string, program: string, args: string[]): Promise<string> {
  const result = await execute(program, args, { cwd, timeout: 10_000, maxBuffer: 1024 * 1024 })
  return result.stdout.trim()
}

/** Real local Git and verifier subprocesses; this is a synthetic proof fixture, not a corpus episode. */
async function repositoryFixture(): Promise<{
  root: string
  repo: string
  options: WriteHarborTaskOptions
  verify: WriteHarborTaskOptions['verify']
  seen: HarborTaskVerification[]
}> {
  const root = await mkdtemp(join(tmpdir(), 'eval-harbor-task-'))
  roots.push(root)
  const repo = join(root, 'repository')
  await mkdir(repo)
  const git = (...args: string[]) => command(repo, 'git', args)
  const commit = (message: string) => git('commit', '-m', message)
  await git('init', '-b', 'main')
  await writeFile(
    join(repo, 'production.mjs'),
    'export function sum(a, b) {\n  const value = a + b\n  return value\n}\n',
  )
  await writeFile(join(repo, 'support.mjs'), 'export const support = true\n')
  await git('add', '.')
  await commit('base')
  const baseCommit = await git('rev-parse', 'HEAD')
  const baseTree = await git('rev-parse', 'HEAD^{tree}')
  const bundlePath = join(root, 'base.bundle')
  await git('bundle', 'create', bundlePath, 'HEAD')
  await git('checkout', '-b', 'candidate')
  await writeFile(join(repo, 'production.mjs'), 'export const sum = (a, b) => a + b\n')
  await git('add', '.')
  await commit('reduce production lines')
  const candidateCommit = await git('rev-parse', 'HEAD')
  const candidateTree = await git('rev-parse', 'HEAD^{tree}')
  const patch = (
    await execute('git', ['diff', '--binary', baseCommit, candidateCommit], {
      cwd: repo,
      timeout: 10_000,
    })
  ).stdout
  await git('checkout', 'main')
  await git('merge', '--no-ff', 'candidate', '-m', 'merge candidate')
  const mergeCommit = await git('rev-parse', 'HEAD')
  const surface: CodeSurface = {
    kind: 'code',
    worktreeRef: repo,
    baseRef: 'main',
    baseCommit,
    baseTree,
    candidateCommit,
    candidateTree,
    patch: {
      format: 'git-diff-binary',
      sha256: `sha256:${createHash('sha256').update(patch).digest('hex')}`,
      byteLength: Buffer.byteLength(patch),
    },
  }
  const commands = {
    acceptance: `#!/bin/sh\nset -eu\nnode --input-type=module -e 'import {sum} from "./production.mjs"; if(sum(2,3)!==5) process.exit(1)'\n`,
    productionDelta:
      '#!/bin/sh\nset -eu\nnode --input-type=module -e ' +
      `'import {readFileSync} from "node:fs"; import {execFileSync} from "node:child_process";` +
      ` const lines=s=>s.trim().split(/\\n/).filter(s=>s.trim()).length;` +
      ` const base=execFileSync("git",["show","${baseCommit}:production.mjs"],{encoding:"utf8"});` +
      ' if(!(lines(readFileSync("production.mjs","utf8"))<lines(base))) process.exit(1)' +
      "'\n",
    danglingReferences:
      '#!/bin/sh\nset -eu\nnode --input-type=module -e ' +
      '\'await import("./production.mjs"); await import("./support.mjs")\'\n',
  }
  const seen: HarborTaskVerification[] = []
  const verify: WriteHarborTaskOptions['verify'] = async (request) => {
    seen.push(request)
    // Check actual file bytes, not caller labels. The bundle predates the answer commit.
    for (const file of request.files) {
      expect(
        `sha256:${createHash('sha256')
          .update(await readFile(file.stagedPath))
          .digest('hex')}`,
      ).toBe(file.sha256)
    }
    const bundled = request.files.find((file) => file.path === 'environment/base.bundle')!
    const inspected = join(root, `inspection-${seen.length}`)
    await command(root, 'git', ['clone', '--no-checkout', bundled.stagedPath, inspected])
    expect(await command(inspected, 'git', ['rev-parse', `${baseCommit}^{tree}`])).toBe(baseTree)
    expect(await command(inspected, 'git', ['rev-list', '--all'])).toBe(baseCommit)
    await expect(
      command(inspected, 'git', ['cat-file', '-e', `${candidateCommit}^{commit}`]),
    ).rejects.toThrow()
    expect(request.source.baseCommit).toBe(baseCommit)
    expect(request.source.candidateCommit).toBe(candidateCommit)
    expect(request.source.patch.sha256).toBe(
      `sha256:${createHash('sha256').update(patch).digest('hex')}`,
    )
    expect(request.source.patch.byteLength).toBe(Buffer.byteLength(patch))
    expect(request.mergeCommit).toBe(mergeCommit)
    expect(await git('rev-parse', `${mergeCommit}^1`)).toBe(baseCommit)
    expect(await git('rev-parse', `${mergeCommit}^2`)).toBe(candidateCommit)
    expect(await git('rev-parse', `${mergeCommit}^{tree}`)).toBe(candidateTree)
    expect(await git('rev-list', `${mergeCommit}..HEAD`)).toBe('')
    for (const key of ['acceptance.sh', 'production-delta.sh', 'dangling-references.sh']) {
      await command(repo, 'sh', [
        request.files.find((file) => file.path === `tests/${key}`)!.stagedPath,
      ])
    }
    return completionVerdict({
      taskId: request.taskId,
      requirements: HARBOR_TASK_CHECKS.map((reqId) => ({
        reqId,
        title: reqId,
        structurallyPresent: true,
        correct: true,
        satisfied: true,
        evidence: [`fixture:${request.taskId}:${reqId}:actual-git-and-process-receipts`],
      })),
    })
  }
  const dataset = join(root, 'dataset')
  await mkdir(dataset)
  await mkdir(join(dataset, 'tasks'))
  const original = fixtureRolloutLine()
  const instruction =
    'Preserve sum behavior while reducing production lines. Do not leave unresolved imports.'
  const episode = fixtureRolloutLine({
    task: { ...original.task, suite: 'local-integration', instance_id: candidateCommit },
    run_id: root,
    messages: [{ role: 'user', content: instruction }],
    tool_defs: [],
    policy: {
      harness: 'scripted-fixture',
      harness_version: null,
      model: null,
      provider: null,
      profile_commit: null,
      sampling: null,
    },
    cost: {
      usd: null,
      tokens_in: null,
      tokens_out: null,
      tokens_reasoning: null,
      cache_read: null,
      cache_write: null,
      wall_s: null,
    },
    artifacts: { patch_path: null, run_dir: root, transcript_ref: null },
    outcome: {
      ...original.outcome,
      reward_source: 'synthetic-public-process-integration',
      verdict: { syntheticFixture: true },
      metrics: {},
      realness_screened: true,
    },
  })
  return {
    root,
    repo,
    seen,
    verify,
    options: {
      directory: join(dataset, 'tasks', 'reduce-lines'),
      episode,
      surface,
      mergeCommit,
      name: 'local/reduce-lines',
      instruction,
      image: `example.invalid/caller-environment@sha256:${'a'.repeat(64)}`,
      baseBundle: await readFile(bundlePath),
      commands,
      agentTimeoutSec: 120,
      verifierTimeoutSec: 30,
      verify,
    },
  }
}

describe('verified episode → Harbor task public filesystem/process boundary', () => {
  it('loads the generated directory, runs its actual verifier and refuses stale/unknown admission', async () => {
    const fixture = await repositoryFixture()
    const taskDir = await writeHarborTask(fixture.options)
    expect(fixture.seen).toHaveLength(1)
    expect(fixture.seen[0]!.rolloutId).toBe(fixture.options.episode.rollout_id)
    expect(Object.isFrozen(fixture.seen[0]!.source.patch)).toBe(true)
    const dockerfile = await readFile(join(taskDir, 'environment/Dockerfile'), 'utf8')
    expect(dockerfile).toContain(fixture.options.surface.baseCommit)
    expect(dockerfile).not.toContain(fixture.options.surface.candidateCommit)
    expect(dockerfile).not.toContain(fixture.options.mergeCommit)
    expect(dockerfile).toContain('COPY --chmod=0444 base.bundle /tmp/base.bundle\n')
    expect(dockerfile).not.toContain('rm /tmp/base.bundle')
    // Real nonroot filesystem/Git boundary without changing identities or requiring Docker.
    // This exercises the generated RUN; Docker ownership/sticky-dir semantics remain a
    // separate native image-build proof, not a claim from this same-UID fixture.
    expect(process.geteuid?.()).toBeGreaterThan(0)
    const sourceBundle = join(taskDir, 'environment/base.bundle')
    expect((await stat(sourceBundle)).mode & 0o777).toBe(0o600)
    const imageBundle = join(fixture.root, 'image-base.bundle')
    const imageRepo = join(fixture.root, 'image-workspace-repo')
    await copyFile(sourceBundle, imageBundle)
    await chmod(imageBundle, 0o444)
    const run = /^RUN ([\s\S]*?)\nWORKDIR /m.exec(dockerfile)
    expect(run).not.toBeNull()
    await command(fixture.root, 'sh', [
      '-c',
      run![1]!.replaceAll('/tmp/base.bundle', '"$1"').replaceAll('/workspace/repo', '"$2"'),
      'harbor-build-run',
      imageBundle,
      imageRepo,
    ])
    expect(await command(imageRepo, 'git', ['rev-parse', 'HEAD'])).toBe(
      fixture.options.surface.baseCommit,
    )
    expect(await command(imageRepo, 'git', ['rev-parse', 'HEAD^{tree}'])).toBe(
      fixture.options.surface.baseTree,
    )
    await expect(
      command(imageRepo, 'git', [
        'cat-file',
        '-e',
        `${fixture.options.surface.candidateCommit}^{commit}`,
      ]),
    ).rejects.toThrow()
    expect((await stat(imageBundle)).mode & 0o777).toBe(0o444)
    expect(await readFile(imageBundle)).toEqual(await readFile(sourceBundle))
    await expect(
      command(fixture.root, process.execPath, [
        '-e',
        'require("node:fs").openSync(process.argv[1], "w")',
        imageBundle,
      ]),
    ).rejects.toThrow('EACCES')
    expect(await readFile(imageBundle)).toEqual(await readFile(sourceBundle))
    const rewards = join(fixture.root, 'reward-output')
    const adapter = createHarborBenchmarkAdapter<string>({
      id: 'local-harbor',
      datasetDir: join(fixture.root, 'dataset'),
      source: { name: 'synthetic-integration', revision: fixture.options.mergeCommit },
      grade: async (item) => {
        await command(fixture.repo, 'sh', [
          join(item.payload.taskDir, 'tests/test.sh'),
          fixture.repo,
          join(item.payload.taskDir, 'tests'),
          rewards,
        ])
        return {
          succeeded: true,
          value: { reward: Number(await readFile(join(rewards, 'reward.txt'), 'utf8')) },
        }
      },
    })
    const items = await adapter.loadAll()
    expect(items).toHaveLength(1)
    expect(items[0]!.payload.name).toBe('local/reduce-lines')
    expect(items[0]!.payload.agentTimeoutSec).toBe(120)
    expect((await adapter.evaluate(items[0]!, 'candidate')).passed).toBe(true)
    // Same acceptance behavior, but zero production decrease: reward must remain zero.
    await command(fixture.repo, 'git', [
      'checkout',
      fixture.options.surface.baseCommit,
      '--',
      'production.mjs',
    ])
    await expect(
      command(fixture.repo, 'sh', [
        join(taskDir, 'tests/test.sh'),
        fixture.repo,
        join(taskDir, 'tests'),
        rewards,
      ]),
    ).rejects.toThrow()
    expect((await readFile(join(rewards, 'reward.txt'), 'utf8')).trim()).toBe('0')
    await command(fixture.repo, 'git', [
      'checkout',
      fixture.options.surface.candidateCommit,
      '--',
      'production.mjs',
    ])
    await writeFile(join(fixture.repo, 'production.mjs'), 'export const sum = (a, b) => a - b\n')
    await expect(
      command(fixture.repo, 'sh', [
        join(taskDir, 'tests/test.sh'),
        fixture.repo,
        join(taskDir, 'tests'),
        rewards,
      ]),
    ).rejects.toThrow()
    expect((await readFile(join(rewards, 'reward.txt'), 'utf8')).trim()).toBe('0')
    await command(fixture.repo, 'git', [
      'checkout',
      fixture.options.surface.candidateCommit,
      '--',
      'production.mjs',
    ])
    await writeFile(join(fixture.repo, 'support.mjs'), 'import "./missing.mjs"\n')
    await expect(
      command(fixture.repo, 'sh', [
        join(taskDir, 'tests/test.sh'),
        fixture.repo,
        join(taskDir, 'tests'),
        rewards,
      ]),
    ).rejects.toThrow()
    expect((await readFile(join(rewards, 'reward.txt'), 'utf8')).trim()).toBe('0')
    await command(fixture.repo, 'git', [
      'checkout',
      fixture.options.surface.candidateCommit,
      '--',
      'support.mjs',
    ])
    await expect(writeHarborTask(fixture.options)).rejects.toThrow()
    const unknown = join(fixture.root, 'dataset/tasks/unknown')
    await expect(
      writeHarborTask({
        ...fixture.options,
        directory: unknown,
        verify: async (request) => {
          const verdict = await fixture.verify(request)
          return completionVerdict({
            taskId: request.taskId,
            requirements: verdict.requirements.map((row) =>
              row.reqId === 'merge-followup'
                ? {
                    ...row,
                    correct: null,
                    satisfied: false,
                    unmeasured: true,
                    unmeasuredReason: 'followup window is still open',
                  }
                : row,
            ),
          })
        },
      }),
    ).rejects.toThrow('merge-followup')
    await expect(readFile(join(unknown, 'task.toml'))).rejects.toThrow()
    const malformed = join(fixture.root, 'dataset/tasks/malformed')
    await expect(
      writeHarborTask({
        ...fixture.options,
        directory: malformed,
        verify: async (request) => {
          const verdict = await fixture.verify(request)
          // A JavaScript caller can cross the typed boundary with truthy nonboolean flags.
          return JSON.parse(
            JSON.stringify({
              ...verdict,
              requirements: verdict.requirements.map((row) =>
                row.reqId === 'acceptance'
                  ? { ...row, satisfied: 'false', structurallyPresent: 'false' }
                  : row,
              ),
            }),
          )
        },
      }),
    ).rejects.toThrow('acceptance')
    await expect(readFile(join(malformed, 'task.toml'))).rejects.toThrow()
    const changed = join(fixture.root, 'dataset/tasks/changed')
    await expect(
      writeHarborTask({
        ...fixture.options,
        directory: changed,
        verify: async (request) => {
          const verdict = await fixture.verify(request)
          await writeFile(
            request.files.find((file) => file.path === 'instruction.md')!.stagedPath,
            'different task',
          )
          return verdict
        },
      }),
    ).rejects.toThrow('changed during verification')
    await expect(readFile(join(changed, 'task.toml'))).rejects.toThrow()
  }, 60_000)
})
