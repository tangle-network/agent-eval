import { describe, expect, it, vi } from 'vitest'

import { wranglerDeployRunner } from './deploy-gate-layer'

describe('wranglerDeployRunner', () => {
  it('skips with no-config evidence when wrangler.toml absent', async () => {
    const exec = vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 }))
    const exists = vi.fn(async () => false)
    const r = await wranglerDeployRunner({ workdir: '/tmp/x', exec, exists }).run()
    expect(r.ok).toBe(false)
    expect(r.output).toMatch(/no wrangler/)
    expect(exec).not.toHaveBeenCalled()
  })

  it('returns ok when build + dry-run both exit 0', async () => {
    const exec = vi
      .fn()
      .mockResolvedValueOnce({ stdout: 'built', stderr: '', exitCode: 0 })
      .mockResolvedValueOnce({ stdout: 'dry-run OK', stderr: '', exitCode: 0 })
    const exists = vi.fn(async (rel: string) => rel === 'wrangler.toml')
    const r = await wranglerDeployRunner({ workdir: '/tmp/x', exec, exists }).run()
    expect(r.ok).toBe(true)
    expect(r.artifactValid).toBe(true)
    expect(exec).toHaveBeenCalledTimes(2)
  })

  it('returns fail when build exits non-zero (dry-run skipped)', async () => {
    const exec = vi.fn().mockResolvedValueOnce({ stdout: '', stderr: 'TS2304', exitCode: 1 })
    const exists = vi.fn(async () => true)
    const r = await wranglerDeployRunner({ workdir: '/tmp/x', exec, exists }).run()
    expect(r.ok).toBe(false)
    expect(r.output).toMatch(/build failed/)
    expect(r.output).toMatch(/TS2304/)
    expect(exec).toHaveBeenCalledTimes(1)
  })

  it('returns fail when dry-run exits non-zero (build OK)', async () => {
    const exec = vi
      .fn()
      .mockResolvedValueOnce({ stdout: 'built', stderr: '', exitCode: 0 })
      .mockResolvedValueOnce({ stdout: '', stderr: 'binding KV not found', exitCode: 1 })
    const exists = vi.fn(async () => true)
    const r = await wranglerDeployRunner({ workdir: '/tmp/x', exec, exists }).run()
    expect(r.ok).toBe(false)
    expect(r.output).toMatch(/wrangler dry-run failed/)
    expect(r.output).toMatch(/KV not found/)
  })

  it('accepts wrangler.jsonc as an alternative config', async () => {
    const exec = vi
      .fn()
      .mockResolvedValueOnce({ stdout: 'built', stderr: '', exitCode: 0 })
      .mockResolvedValueOnce({ stdout: 'dry-run OK', stderr: '', exitCode: 0 })
    const exists = vi.fn(async (rel: string) => rel === 'wrangler.jsonc')
    const r = await wranglerDeployRunner({ workdir: '/tmp/x', exec, exists }).run()
    expect(r.ok).toBe(true)
  })
})
