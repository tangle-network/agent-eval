import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FindingsStore } from './findings-store'
import type { AnalystFinding } from './types'
import { makeFinding, makeProposalFinding } from './types'

function finding(extra: Partial<AnalystFinding> = {}): AnalystFinding {
  return makeFinding({
    analyst_id: 'intent-divergence',
    produced_at: '2026-07-31T00:00:00.000Z',
    severity: 'high',
    area: 'intent-divergence',
    claim: 'turn 4 rewrote prod config against a stated staging-only constraint',
    subject: 'system-prompt:deploy',
    evidence_refs: [
      { kind: 'span', uri: 'trace://t1/span/s4' },
      { kind: 'span', uri: 'trace://t1/span/s7' },
    ],
    confidence: 0.9,
    ...extra,
  })
}

describe('AnalystFinding — wasted_turns', () => {
  it('carries a measured cost onto the public finding', () => {
    expect(finding({ wasted_turns: 3 }).wasted_turns).toBe(3)
  })

  it('leaves an unmeasured finding without the key rather than defaulting it', () => {
    const unpriced = finding()

    expect('wasted_turns' in unpriced).toBe(false)
    expect(unpriced.wasted_turns).toBeUndefined()
  })

  // Two runs that price the same divergence differently found the same finding.
  // If cost entered the id, every re-measure would read as disappeared+appeared.
  it('does not change finding_id', () => {
    const baseline = finding().finding_id

    expect(finding({ wasted_turns: 1 }).finding_id).toBe(baseline)
    expect(finding({ wasted_turns: 20 }).finding_id).toBe(baseline)
  })

  // Control for the assertion above: the id is not simply constant.
  it('still separates findings that differ in an identity field', () => {
    expect(finding({ claim: 'a different divergence' }).finding_id).not.toBe(finding().finding_id)
    expect(finding({ subject: 'skill:deploy' }).finding_id).not.toBe(finding().finding_id)
  })

  it('survives a JSON round-trip in both states', () => {
    const priced = finding({ wasted_turns: 7 })
    const unpriced = finding()

    expect(JSON.parse(JSON.stringify(priced))).toEqual(priced)
    expect(JSON.parse(JSON.stringify(unpriced))).toEqual(unpriced)
    expect('wasted_turns' in JSON.parse(JSON.stringify(unpriced))).toBe(false)
  })

  it('is carried by proposal findings too', () => {
    const proposal = makeProposalFinding({
      analyst_id: 'failure-mode',
      produced_at: '2026-07-31T00:00:00.000Z',
      severity: 'critical',
      area: 'failure-mode',
      claim: 'an auth loop burned every turn until the human intervened',
      evidence_refs: [{ kind: 'span', uri: 'trace://t2/span/s1' }],
      confidence: 0.9,
      wasted_turns: 9,
      proposal_origin: 'production',
    })

    expect(proposal.wasted_turns).toBe(9)
  })
})

describe('FindingsStore — wasted_turns crosses the JSONL boundary', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'analyst-findings-cost-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('persists a priced finding and an unpriced one from the same run', async () => {
    const store = new FindingsStore(join(dir, 'findings.jsonl'))
    const priced = finding({ wasted_turns: 4 })
    const unpriced = finding({ claim: 'a second, unmeasured divergence' })
    await store.append('run-1', [priced, unpriced])

    const loaded = store.loadRun('run-1')

    expect(loaded).toHaveLength(2)
    expect(loaded[0]).toEqual({ ...priced, run_id: 'run-1' })
    expect(loaded[1]).toEqual({ ...unpriced, run_id: 'run-1' })
    expect('wasted_turns' in loaded[1]!).toBe(false)
  })
})
