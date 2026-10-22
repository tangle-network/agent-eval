

import { describe, expect, it } from 'vitest'
import {
  type EvidenceRegistryRecord,
  renderEvidenceIndex,
} from './evidence-record'

const valid: EvidenceRegistryRecord = {
  id: 'sample-claim',
  date: '2026-08-15',
  claim: 'The sample instrument separates the arms.',
  domain: 'sample',
  instrument: 'paired A/B over scripted rows',
  command: 'pnpm tsx scripts/sample.ts',
  arms: ['control', 'treatment'],
  n: { value: 151, unit: 'rows', detail: '22 clusters' },
  result: '+0.0596, 95% CI [-0.0061, +0.1210]',
  evidenceState: 'MEASURED-ONCE',
  artifacts: ['~/bench-cache/sample/'],
  costUsd: 9.64,
  confounds: ['CI crosses zero'],
  sourceRepo: 'agent-eval',
}





describe('renderEvidenceIndex', () => {
  it('is deterministic and carries every load-bearing field', () => {
    const first = renderEvidenceIndex([valid])
    expect(renderEvidenceIndex([valid])).toBe(first)
    for (const needle of [
      valid.claim,
      valid.result,
      valid.instrument,
      '151 rows (22 clusters)',
      '$9.64',
      'CI crosses zero',
      'MEASURED-ONCE',
    ]) {
      expect(first).toContain(needle)
    }
  })

  it('labels the named gaps instead of dropping them', () => {
    const rendered = renderEvidenceIndex([{ ...valid, command: null, costUsd: null }])
    expect(rendered).toContain('not preserved')
    expect(rendered).toContain('not captured')
  })
})


