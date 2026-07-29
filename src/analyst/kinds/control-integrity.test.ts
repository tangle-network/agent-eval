import { describe, expect, it } from 'vitest'
import { fixtureSources } from '../../supervisor-run/fixtures'
import type { SupervisorRunTree } from '../../supervisor-run/types'
import { AnalystRegistry } from '../registry'
import { CONTROL_INTEGRITY_ANALYST, emitControlIntegrityFindings } from './control-integrity'

const AT = '2026-07-29T18:00:00.000Z'

describe('control-integrity analyst adapter', () => {
  it('maps typed integrity issues into stable zero-cost analyst findings', async () => {
    const input: SupervisorRunTree = {
      rootId: null,
      nodes: [],
      gaps: [{ code: 'journal-unavailable', message: 'journal unavailable' }],
    }
    const registry = new AnalystRegistry()
    registry.register(CONTROL_INTEGRITY_ANALYST)

    const result = await registry.run(
      'run-1',
      { custom: { 'control-integrity': input } },
      { tags: { producedAt: AT } },
    )
    const repeated = emitControlIntegrityFindings(input, '2099-01-01T00:00:00.000Z')

    expect(result.per_analyst).toEqual([
      expect.objectContaining({
        analyst_id: 'control-integrity',
        status: 'ok',
        usage: expect.objectContaining({ cost: { kind: 'observed', usd: 0 } }),
      }),
    ])
    expect(result.findings.map((finding) => finding.finding_id)).toEqual(
      repeated.map((finding) => finding.finding_id),
    )
    expect(result.findings.every((finding) => finding.metadata?.integrity_code)).toBe(true)
  })

  it('passes source input through without dropping source-only checks', () => {
    const findings = emitControlIntegrityFindings(
      fixtureSources({ workers: null, workersMissingReason: 'not retained' }),
      AT,
    )

    expect(findings.some((finding) => finding.metadata?.integrity_input === 'sources')).toBe(true)
    expect(findings.map((finding) => finding.metadata?.integrity_code)).toContain(
      'worker-controls-unavailable',
    )
    expect(findings.map((finding) => finding.metadata?.integrity_code)).not.toContain(
      'source-checks-unavailable',
    )
  })

  it('keeps identical local node ids distinct across runs', () => {
    const input = (runId: string): SupervisorRunTree => ({
      rootId: 'root',
      nodes: [
        {
          ...({} as SupervisorRunTree['nodes'][number]),
          rollout_id: 'root',
          run_id: runId,
        },
      ],
      gaps: [],
    })

    const first = emitControlIntegrityFindings(input('run-a'), AT)
    const second = emitControlIntegrityFindings(input('run-b'), AT)

    expect(first).not.toHaveLength(0)
    expect(second).not.toHaveLength(0)
    expect(first[0]?.finding_id).not.toBe(second[0]?.finding_id)
    expect(first[0]?.subject).toContain('run-a/')
    expect(second[0]?.subject).toContain('run-b/')
  })
})
