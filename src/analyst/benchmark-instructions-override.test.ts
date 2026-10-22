import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished } from 'vitest'
import {
  readAnalystInstructionsOverride,
} from './benchmark-instructions-override'



import { sha256Digest } from './benchmark-verification-artifacts'








describe('readAnalystInstructionsOverride', () => {
  it('reads override text and its digest from a file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'analyst-instructions-override-'))
    onTestFinished(() => rm(dir, { recursive: true, force: true }))
    const path = join(dir, 'candidate.txt')
    await writeFile(path, 'File-backed instructions.\n')
    expect(readAnalystInstructionsOverride(path)).toEqual({
      text: 'File-backed instructions.\n',
      sha256: sha256Digest('File-backed instructions.\n'),
    })
  })

  it('fails loudly on an unreadable file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'analyst-instructions-override-'))
    onTestFinished(() => rm(dir, { recursive: true, force: true }))
    const missing = join(dir, 'missing.txt')
    expect(() => readAnalystInstructionsOverride(missing)).toThrow(missing)
  })

  it('fails loudly on an empty file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'analyst-instructions-override-'))
    onTestFinished(() => rm(dir, { recursive: true, force: true }))
    const path = join(dir, 'empty.txt')
    await writeFile(path, '   \n')
    expect(() => readAnalystInstructionsOverride(path)).toThrow(/is empty/)
  })
})




