import { describe, expect, it } from 'vitest'
import {
  assertExternalOptimizerPackageSource,
  observedExternalOptimizerPackageSource,
} from '../../src/campaign/external-optimizer-source'

describe('external optimizer source provenance', () => {
  it('accepts exact observed package coordinates', () => {
    const source = {
      package: 'gepa',
      version: '0.1.4',
      sourceUrl: 'https://github.com/gepa-ai/gepa.git',
      revision: 'f919db0',
    }

    assertExternalOptimizerPackageSource(source, 'gepa', 'method', 'GEPA')

    expect(observedExternalOptimizerPackageSource(source)).toEqual({
      kind: 'package',
      evidence: 'observed',
      package: 'gepa',
      version: '0.1.4',
      sourceUrl: 'https://github.com/gepa-ai/gepa.git',
      revision: 'f919db0',
    })
  })

  it.each([
    { version: ' 0.1.4' },
    { version: '0.1.4 ' },
    { version: '0.1.4', sourceUrl: ' https://github.com/gepa-ai/gepa.git' },
    { version: '0.1.4', revision: 'f919db0 ' },
  ])('rejects non-canonical coordinates: %o', (details) => {
    expect(() =>
      assertExternalOptimizerPackageSource(
        { package: 'gepa', ...details },
        'gepa',
        'method',
        'GEPA',
      ),
    ).toThrow(/invalid upstream/)
  })
})
