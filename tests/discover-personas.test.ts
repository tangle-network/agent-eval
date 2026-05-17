import { promises as fs, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { discoverPersonas } from '../src/discover-personas'

let dir: string

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'discover-personas-'))
  writeFileSync(join(dir, '01-baseline.yaml'), 'id: baseline')
  writeFileSync(join(dir, '02-edge-case.yaml'), 'id: edge')
  writeFileSync(join(dir, '21-equity-comp.yaml'), 'id: equity')
  writeFileSync(join(dir, 'README.md'), '# README — should be skipped')
  writeFileSync(join(dir, '99-skipped.txt'), 'wrong extension')
  // subdir
  mkdirSync(join(dir, 'sub'))
  writeFileSync(join(dir, 'sub', '50-nested.yaml'), 'id: nested')
})

afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe('discoverPersonas — eliminates hardcoded TRAINING_PERSONA_FILES', () => {
  it('discovers all NN-slug.yaml files at the top level by default', async () => {
    const found = await discoverPersonas(dir)
    expect(found.map((f) => f.id)).toEqual(['01-baseline', '02-edge-case', '21-equity-comp'])
  })

  it('skips files that do not match the default pattern (README, .txt)', async () => {
    const found = await discoverPersonas(dir)
    expect(found.find((f) => f.filename === 'README.md')).toBeUndefined()
    expect(found.find((f) => f.filename === '99-skipped.txt')).toBeUndefined()
  })

  it('returns sorted-by-filename for reproducibility', async () => {
    const found = await discoverPersonas(dir)
    const sorted = [...found].sort((a, b) => a.filename.localeCompare(b.filename))
    expect(found).toEqual(sorted)
  })

  it('does NOT recurse by default', async () => {
    const found = await discoverPersonas(dir)
    expect(found.find((f) => f.id === '50-nested')).toBeUndefined()
  })

  it('recurses when recursive=true', async () => {
    const found = await discoverPersonas(dir, { recursive: true })
    expect(found.find((f) => f.id === '50-nested')).toBeDefined()
  })

  it('honors exclude list (by filename or id)', async () => {
    const found = await discoverPersonas(dir, { exclude: ['02-edge-case.yaml'] })
    expect(found.map((f) => f.id)).toEqual(['01-baseline', '21-equity-comp'])
    const byId = await discoverPersonas(dir, { exclude: ['21-equity-comp'] })
    expect(byId.map((f) => f.id)).toEqual(['01-baseline', '02-edge-case'])
  })

  it('honors include list (substring match)', async () => {
    const found = await discoverPersonas(dir, { include: ['baseline', 'equity'] })
    expect(found.map((f) => f.id)).toEqual(['01-baseline', '21-equity-comp'])
  })

  it('returns empty array for non-existent directory (no throw)', async () => {
    const found = await discoverPersonas(join(dir, 'does-not-exist'))
    expect(found).toEqual([])
  })

  it('returns absolute paths', async () => {
    const found = await discoverPersonas(dir)
    for (const f of found) {
      expect(f.path.startsWith(dir)).toBe(true)
    }
  })
})
