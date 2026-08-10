import { describe, expect, it } from 'vitest'
import { ValidationError } from '../errors'
import {
  createDockerContinuationEnvironment,
  dockerRunArgs,
  nodeProcessRunner,
  type ProcessRequest,
  type ProcessResult,
} from './docker-environment'

interface RecordingRunner {
  run: (request: ProcessRequest) => Promise<ProcessResult>
  requests: ProcessRequest[]
}

function recordingRunner(results: ProcessResult[]): RecordingRunner {
  const requests: ProcessRequest[] = []
  let index = 0
  return {
    requests,
    run: async (request) => {
      requests.push(request)
      const result = results[index] ?? { output: '', exitCode: 0, timedOut: false }
      index += 1
      return result
    },
  }
}

describe('dockerRunArgs', () => {
  it('creates the container without a network', () => {
    const argv = dockerRunArgs({ image: 'alexgshaw/fix-git:20251031', name: 'tb-1', cwd: '/app' })
    expect(argv).toEqual([
      'docker',
      'run',
      '-d',
      '--name',
      'tb-1',
      '--network',
      'none',
      '-w',
      '/app',
      '--rm',
      'alexgshaw/fix-git:20251031',
      'sleep',
      '2h',
    ])
  })

  it('offers no way to ask for a network', () => {
    const argv = dockerRunArgs({ image: 'img', name: 'n', cwd: '/', containerLifetime: '30m' })
    expect(argv.filter((arg) => arg === '--network')).toHaveLength(1)
    expect(argv[argv.indexOf('--network') + 1]).toBe('none')
  })
})

describe('createDockerContinuationEnvironment', () => {
  it('reports the network mode the daemon holds, not the one requested', async () => {
    const runner = recordingRunner([
      { output: 'bridge\ttask:pinned\n', exitCode: 0, timedOut: false },
      { output: '/usr/bin/timeout\n', exitCode: 0, timedOut: false },
    ])
    const environment = createDockerContinuationEnvironment({
      containerRef: 'abc123',
      cwd: '/app',
      runProcess: runner.run,
    })
    expect(await environment.describe()).toEqual({ networkMode: 'bridge', image: 'task:pinned' })
    expect(runner.requests[0]?.argv).toEqual([
      'docker',
      'inspect',
      '--format',
      '{{.HostConfig.NetworkMode}}\t{{.Config.Image}}',
      'abc123',
    ])
  })

  it('fails loud when inspect fails rather than assuming a mode', async () => {
    const runner = recordingRunner([{ output: 'No such object', exitCode: 1, timedOut: false }])
    const environment = createDockerContinuationEnvironment({
      containerRef: 'gone',
      cwd: '/app',
      runProcess: runner.run,
    })
    await expect(environment.describe()).rejects.toThrow(ValidationError)
  })

  it('refuses a container that cannot bound a command from the inside', async () => {
    const runner = recordingRunner([
      { output: 'none\ttask:pinned\n', exitCode: 0, timedOut: false },
      { output: '', exitCode: 1, timedOut: false },
    ])
    const environment = createDockerContinuationEnvironment({
      containerRef: 'abc123',
      cwd: '/app',
      runProcess: runner.run,
    })
    await expect(environment.describe()).rejects.toThrow(/provides no `timeout`/)
    expect(runner.requests[1]?.argv).toEqual([
      'docker',
      'exec',
      'abc123',
      'bash',
      '-lc',
      'command -v timeout',
    ])
  })

  it('bounds the command inside the container and keeps the host kill as a backstop', async () => {
    const runner = recordingRunner([{ output: 'hello\n', exitCode: 0, timedOut: false }])
    const environment = createDockerContinuationEnvironment({
      containerRef: 'abc123',
      cwd: '/app',
      env: { PAGER: 'cat' },
      runProcess: runner.run,
    })
    const result = await environment.exec('echo hello', { timeoutSeconds: 30 })
    expect(result).toEqual({ output: 'hello\n', returncode: 0, timedOut: false })
    expect(runner.requests[0]).toEqual({
      argv: [
        'docker',
        'exec',
        '-w',
        '/app',
        '-e',
        'PAGER=cat',
        'abc123',
        'timeout',
        '--kill-after=5s',
        '30s',
        'bash',
        '-lc',
        'echo hello',
      ],
      timeoutSeconds: 45,
    })
  })

  it('reads the in-container timeout exit as a timeout', async () => {
    const runner = recordingRunner([{ output: 'partial', exitCode: 124, timedOut: false }])
    const environment = createDockerContinuationEnvironment({
      containerRef: 'abc123',
      cwd: '/app',
      runProcess: runner.run,
    })
    expect(await environment.exec('sleep 600', { timeoutSeconds: 30 })).toEqual({
      output: 'partial',
      returncode: 124,
      timedOut: true,
    })
  })

  it('passes a host-side kill through as timed out', async () => {
    const runner = recordingRunner([{ output: 'partial', exitCode: -9, timedOut: true }])
    const environment = createDockerContinuationEnvironment({
      containerRef: 'abc123',
      cwd: '/app',
      runProcess: runner.run,
    })
    expect(await environment.exec('sleep 600', { timeoutSeconds: 30 })).toEqual({
      output: 'partial',
      returncode: -9,
      timedOut: true,
    })
  })

  it('leaves the container alone unless it owns the lifecycle', async () => {
    const runner = recordingRunner([])
    const kept = createDockerContinuationEnvironment({
      containerRef: 'abc123',
      cwd: '/app',
      runProcess: runner.run,
    })
    await kept.dispose()
    expect(runner.requests).toHaveLength(0)

    const owned = createDockerContinuationEnvironment({
      containerRef: 'abc123',
      cwd: '/app',
      runProcess: runner.run,
      removeOnDispose: true,
    })
    await owned.dispose()
    expect(runner.requests[0]?.argv).toEqual(['docker', 'rm', '-f', 'abc123'])
  })

  it('rejects an empty container reference', () => {
    expect(() =>
      createDockerContinuationEnvironment({
        containerRef: '  ',
        cwd: '/app',
        runProcess: recordingRunner([]).run,
      }),
    ).toThrow(ValidationError)
  })
})

describe('nodeProcessRunner', () => {
  it('merges stdout and stderr in the order the scaffold reads them', async () => {
    const result = await nodeProcessRunner({
      argv: ['bash', '-lc', 'echo out; echo err >&2'],
    })
    expect(result.exitCode).toBe(0)
    expect(result.timedOut).toBe(false)
    expect(result.output).toContain('out')
    expect(result.output).toContain('err')
  })

  it('reports the command exit code', async () => {
    expect((await nodeProcessRunner({ argv: ['bash', '-lc', 'exit 7'] })).exitCode).toBe(7)
  })

  it('kills the process group on timeout and reports a negative signal code', async () => {
    const result = await nodeProcessRunner({
      argv: ['bash', '-lc', 'sleep 30'],
      timeoutSeconds: 1,
    })
    expect(result.timedOut).toBe(true)
    expect(result.exitCode).toBe(-9)
  })
})
