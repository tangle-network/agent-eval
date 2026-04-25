import { describe, expect, it, vi } from 'vitest'

import {
  deployGateLayer,
  viteDeployRunner,
  type DeployRunner,
} from './deploy-gate-layer'
import { MultiLayerVerifier } from './multi-layer-verifier'

function makeRunner(out: { ok: boolean; artifactValid: boolean; output?: string }): DeployRunner {
  return {
    run: vi.fn(async () => ({
      ok: out.ok,
      artifactValid: out.artifactValid,
      output: out.output ?? '',
      durationMs: 12,
      artifactDir: 'dist',
    })),
  }
}

describe('deployGateLayer', () => {
  it('passes when build OK and artifact valid', async () => {
    const layer = deployGateLayer({
      runner: () => makeRunner({ ok: true, artifactValid: true }),
      family: 'frontend-static',
      dependsOn: [],
    })
    const v = new MultiLayerVerifier([layer])
    const r = await v.run({ env: {} })
    expect(r.layers[0]!.status).toBe('pass')
    expect(r.layers[0]!.score).toBe(1)
    expect(r.layers[0]!.diagnostics?.deployBuildOk).toBe(1)
  })

  it('fails when build exits non-zero', async () => {
    const layer = deployGateLayer({
      runner: () => makeRunner({ ok: false, artifactValid: false, output: 'tsc error TS2304' }),
      dependsOn: [],
    })
    const v = new MultiLayerVerifier([layer])
    const r = await v.run({ env: {} })
    expect(r.layers[0]!.status).toBe('fail')
    expect(r.layers[0]!.findings[0]!.severity).toBe('critical')
    expect(r.layers[0]!.findings[0]!.evidence).toContain('TS2304')
  })

  it('fails when build OK but artifact missing', async () => {
    const layer = deployGateLayer({
      runner: () => makeRunner({ ok: true, artifactValid: false }),
      dependsOn: [],
    })
    const v = new MultiLayerVerifier([layer])
    const r = await v.run({ env: {} })
    expect(r.layers[0]!.status).toBe('fail')
    expect(r.layers[0]!.findings[0]!.severity).toBe('major')
    expect(r.layers[0]!.findings[0]!.message).toContain('artifact')
  })

  it('passes with requireArtifact=false even when artifactValid is unknown', async () => {
    const layer = deployGateLayer({
      runner: () => makeRunner({ ok: true, artifactValid: false }),
      requireArtifact: false,
      dependsOn: [],
    })
    const v = new MultiLayerVerifier([layer])
    const r = await v.run({ env: {} })
    expect(r.layers[0]!.status).toBe('pass')
  })

  it('returns error when runner-init throws', async () => {
    const layer = deployGateLayer({
      runner: () => {
        throw new Error('no node binary')
      },
      dependsOn: [],
    })
    const v = new MultiLayerVerifier([layer])
    const r = await v.run({ env: {} })
    expect(r.layers[0]!.status).toBe('error')
    expect(r.layers[0]!.findings[0]!.message).toContain('no node binary')
  })
})

describe('viteDeployRunner', () => {
  it('returns ok=true and artifactValid=true on green build', async () => {
    const exec = vi.fn(async () => ({ stdout: 'built', stderr: '', exitCode: 0 }))
    const exists = vi.fn(async () => true)
    const runner = viteDeployRunner({ workdir: '/tmp/x', exec, exists })
    const r = await runner.run()
    expect(r.ok).toBe(true)
    expect(r.artifactValid).toBe(true)
    expect(r.artifactDir).toBe('dist')
    expect(exists).toHaveBeenCalledWith('dist/index.html')
  })

  it('returns ok=false when exec exitCode non-zero', async () => {
    const exec = vi.fn(async () => ({ stdout: '', stderr: 'TS2304', exitCode: 1 }))
    const exists = vi.fn(async () => false)
    const runner = viteDeployRunner({ workdir: '/tmp/x', exec, exists })
    const r = await runner.run()
    expect(r.ok).toBe(false)
    expect(r.artifactValid).toBe(false)
    expect(r.output).toContain('TS2304')
  })
})
