import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// An exact first-party version in the published manifest installs a second copy
// of that package for every consumer already holding a later release: Eval
// 0.210.0 through 0.211.2 pinned harness-sessions 0.1.0 while 0.1.1 was out, and
// Runtime's packed cohort refuses such an archive.
const manifest = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as Record<string, Record<string, string> | undefined>

const EXACT = /^=?v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/

describe('published first-party dependencies', () => {
  for (const section of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    for (const [name, spec] of Object.entries(manifest[section] ?? {})) {
      if (!name.startsWith('@tangle-network/')) continue
      it(`${section}.${name} is a range`, () => {
        expect(spec, `${name} ${spec}`).not.toMatch(EXACT)
      })
    }
  }
})
