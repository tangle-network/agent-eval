import { describe, expect, it } from 'vitest'
import { isProposedCandidate, type ProposeContext, type ProposedCandidate } from '../types'
import { memoryCurationDriver } from './memory'

function asCandidate(v: unknown): ProposedCandidate {
  if (!isProposedCandidate(v as never)) throw new Error('expected a ProposedCandidate')
  return v as ProposedCandidate
}

const ctx = (currentSurface: string, findings: unknown[]): ProposeContext =>
  ({
    currentSurface,
    history: [],
    findings,
    populationSize: 1,
    generation: 1,
    signal: new AbortController().signal,
  }) as unknown as ProposeContext

describe('memoryCurationDriver — curates trace findings into a surface memory block', () => {
  it('returns no candidate when nothing has been learned yet (gen 0, no findings, no prior memory)', async () => {
    const d = memoryCurationDriver()
    expect(await d.propose(ctx('BASE PROMPT', []))).toHaveLength(0)
  })

  it('appends a curated memory block built from findings (strings + structured)', async () => {
    const d = memoryCurationDriver()
    const out = await d.propose(
      ctx('BASE PROMPT.', [
        'Always fetch the resource before mutating it',
        { recommended_action: 'Call complete_task only after verifying the answer' },
        { claim: 'something unrelated', text: 'Avoid redundant API calls with identical args' },
      ]),
    )
    const c = asCandidate(out[0])
    expect(c.label).toBe('memory-curation')
    expect(c.surface as string).toContain('## Learned from prior runs')
    expect(c.surface as string).toContain('- Always fetch the resource before mutating it')
    expect(c.surface as string).toContain('- Call complete_task only after verifying the answer')
    // structured finding prefers recommended_action/claim/text in that order
    expect(c.surface as string).toContain('- something unrelated')
    // base prompt preserved above the block
    expect((c.surface as string).startsWith('BASE PROMPT.')).toBe(true)
  })

  it('is idempotent + accumulative: re-curating replaces the block and ranks recurring lessons first', async () => {
    const d = memoryCurationDriver()
    // gen 1: one lesson
    const g1 = asCandidate((await d.propose(ctx('BASE.', ['Fetch before mutate'])))[0])
    const s1 = g1.surface as string
    // exactly one block (not stacked)
    expect(s1.match(/BEGIN curated-memory/g)).toHaveLength(1)

    // gen 2: parent already has the block; a NEW finding + a REPEAT of the old one
    const g2 = asCandidate(
      (await d.propose(ctx(s1, ['Fetch before mutate', 'Stop after the answer is verified'])))[0],
    )
    const s2 = g2.surface as string
    // still exactly one block (replaced, not duplicated)
    expect(s2.match(/BEGIN curated-memory/g)).toHaveLength(1)
    // both lessons present; the recurring one ranks first (count 2 vs 1)
    expect(s2).toContain('- Fetch before mutate')
    expect(s2).toContain('- Stop after the answer is verified')
    const idxRecurring = s2.indexOf('- Fetch before mutate')
    const idxNew = s2.indexOf('- Stop after the answer is verified')
    expect(idxRecurring).toBeLessThan(idxNew)
  })

  it('dedups near-identical lessons (case/whitespace/trailing punctuation)', async () => {
    const d = memoryCurationDriver()
    const c = asCandidate(
      (await d.propose(ctx('BASE.', ['Fetch before mutate.', 'fetch  before   mutate'])))[0],
    )
    const block = (c.surface as string).split('BEGIN curated-memory')[1]!
    expect(block.match(/- .*fetch before mutate/gi)).toHaveLength(1)
  })

  it('caps the block at maxEntries (retrieval, not a dump)', async () => {
    const d = memoryCurationDriver({ maxEntries: 2 })
    const c = asCandidate(
      (await d.propose(ctx('BASE.', ['lesson a', 'lesson b', 'lesson c', 'lesson d'])))[0],
    )
    const bullets = (c.surface as string).split('\n').filter((l) => l.startsWith('- '))
    expect(bullets).toHaveLength(2)
  })

  it('fails loud on a code-tier surface (memory curation is prompt-tier)', async () => {
    const d = memoryCurationDriver()
    await expect(
      d.propose({
        currentSurface: { kind: 'code', worktreeRef: 'wt/x' },
        history: [],
        findings: ['x'],
        populationSize: 1,
        generation: 1,
        signal: new AbortController().signal,
      } as unknown as ProposeContext),
    ).rejects.toThrow(/prompt-tier/)
  })
})
