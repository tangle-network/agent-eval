import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { LineageRecorder } from '../src/index'
import type { PromptVariant } from '../src/index'

interface PersonaPayload {
  persona: string
}

function makeVariant(
  id: string,
  parentId: string | null,
  generation: number,
  persona: string,
): PromptVariant<PersonaPayload> {
  return { id, parentId, generation, payload: { persona } }
}

describe('LineageRecorder', () => {
  it('persists variant.payload through upsertVariant (regression)', async () => {
    // Pre-fix bug: upsertVariant only stored {id, parentId, generation, kind,
    // rationale} and silently dropped variant.payload. That made evolved
    // personas non-reproducible after a run completed — the optimizer kept
    // the in-memory variant but the on-disk lineage was payload-less.
    const dir = mkdtempSync(join(tmpdir(), 'lineage-payload-'))
    try {
      const path = join(dir, 'lineage.jsonl')
      const lineage = new LineageRecorder<PersonaPayload>(path)
      await lineage.upsertVariant(makeVariant('v0', null, 0, 'baseline persona text'))
      await lineage.upsertVariant(makeVariant('v0.g1.r0', 'v0', 1, 'evolved persona text'))

      const nodes = lineage.snapshot()
      const seed = nodes.find((n) => n.id === 'v0')
      const child = nodes.find((n) => n.id === 'v0.g1.r0')
      expect((seed?.payload as PersonaPayload | undefined)?.persona).toBe('baseline persona text')
      expect((child?.payload as PersonaPayload | undefined)?.persona).toBe('evolved persona text')

      // Round-trip through disk: a fresh recorder reads the same payloads.
      const lineage2 = new LineageRecorder<PersonaPayload>(path)
      const reloaded = lineage2.snapshot().find((n) => n.id === 'v0.g1.r0')
      expect((reloaded?.payload as PersonaPayload | undefined)?.persona).toBe('evolved persona text')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('honors omitPayload for cases where the payload is too large', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lineage-omit-'))
    try {
      const path = join(dir, 'lineage.jsonl')
      const lineage = new LineageRecorder<PersonaPayload>(path)
      await lineage.upsertVariant(
        makeVariant('v0', null, 0, 'a'.repeat(10_000)),
        { omitPayload: true },
      )
      const onDisk = readFileSync(path, 'utf-8')
      expect(onDisk).not.toContain('aaaa')
      const nodes = lineage.snapshot()
      expect(nodes.find((n) => n.id === 'v0')?.payload).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
