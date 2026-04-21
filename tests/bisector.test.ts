import { describe, expect, it } from 'vitest'
import { bisect, commitBisect, promptBisect } from '../src/bisector'

describe('bisect (generic)', () => {
  it('converges to adjacent bad/good pair on a numeric range', async () => {
    // 0..99 — "bad" after index 42
    const runEval = async (n: number) => ({ score: n < 42 ? 1 : 0, pass: n < 42 })
    const result = await bisect<number>({
      good: 0,
      bad: 99,
      halfway: (g, b) => (b - g <= 1 ? null : Math.floor((g + b) / 2)),
      runEval,
    })
    expect(result.converged).toBe(true)
    expect(result.culprit).toBe(42)
    expect(result.path.length).toBeLessThan(15)
  })

  it('flags inputInconsistent when good fails — regression: silently trusting caller premise hides bugs', async () => {
    const result = await bisect<number>({
      good: 5,
      bad: 10,
      halfway: () => null,
      runEval: async () => ({ score: 0, pass: false }),
    })
    expect(result.inputInconsistent).toBe(true)
    expect(result.converged).toBe(false)
  })

  it('flags inputInconsistent when bad passes', async () => {
    const result = await bisect<number>({
      good: 5,
      bad: 10,
      halfway: () => null,
      runEval: async () => ({ score: 1, pass: true }),
    })
    expect(result.inputInconsistent).toBe(true)
  })
})

describe('commitBisect', () => {
  it('finds the offending SHA in an ordered commit list', async () => {
    const commits = ['sha0', 'sha1', 'sha2', 'sha3', 'sha4', 'sha5', 'sha6', 'sha7']
    const breakIdx = 5
    const runEval = async (sha: string) => {
      const i = commits.indexOf(sha)
      return { score: i < breakIdx ? 1 : 0, pass: i < breakIdx }
    }
    const result = await commitBisect({ commits, good: 'sha0', bad: 'sha7', runEval })
    expect(result.culprit).toBe('sha5')
    expect(result.converged).toBe(true)
  })

  it('rejects good ≥ bad', async () => {
    await expect(
      commitBisect({ commits: ['a', 'b', 'c'], good: 'c', bad: 'a', runEval: async () => ({ score: 1, pass: true }) }),
    ).rejects.toThrow(/precede/)
  })
})

describe('promptBisect', () => {
  it('localizes the offending paragraph', async () => {
    const good = 'Paragraph A.\n\nParagraph B.\n\nParagraph C.\n\nParagraph D.'
    const bad = 'Paragraph A.\n\nParagraph B.\n\nPARAGRAPH C BROKEN.\n\nParagraph D.'
    const runEval = async (prompt: string) => {
      const pass = !prompt.includes('BROKEN')
      return { score: pass ? 1 : 0, pass }
    }
    const result = await promptBisect({ good, bad, runEval })
    expect(result.converged).toBe(true)
    expect(result.offendingParagraphIndex).toBe(2)
    expect(result.culprit).toContain('BROKEN')
  })

  it('rejects paragraph-count mismatch — regression: silent mis-alignment gave spurious results', async () => {
    await expect(
      promptBisect({
        good: 'A.\n\nB.',
        bad: 'A.\n\nB.\n\nC.',
        runEval: async () => ({ score: 0, pass: false }),
      }),
    ).rejects.toThrow(/paragraph count/)
  })

  it('rejects single-paragraph inputs', async () => {
    await expect(
      promptBisect({ good: 'one', bad: 'two', runEval: async () => ({ score: 0, pass: false }) }),
    ).rejects.toThrow(/at least 2/)
  })
})
