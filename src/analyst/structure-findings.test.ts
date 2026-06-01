import { describe, expect, it } from 'vitest'
import { structureFindings } from './structure-findings'

// Stub an OpenAI-compatible chat completion. Mocks ONLY the network boundary.
function stubFetch(content: string): typeof fetch {
  return (async () =>
    new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch
}

const REPORT =
  'The agent re-sent its full history every step (input tokens 671→8776) and never verified state. ' +
  'It looped on world.execute with no fallback. These inefficiencies materially raised cost and risk ' +
  'across the seven-step run, and the lack of self-verification let an incorrect intermediate stand.'

describe('structureFindings — free-form report → structured findings (any model)', () => {
  it('extracts findings from a FENCED JSON response (the wrapper that breaks naive parsing)', async () => {
    const fenced =
      '```json\n[{"severity":"high","claim":"no context compression — input grew 671→8776",' +
      '"evidence_uri":"span://t1/s5","confidence":0.95},' +
      '{"severity":"medium","claim":"no self-verification","evidence_uri":"report://summary","confidence":0.9}]\n```'
    const res = await structureFindings({
      report: REPORT,
      analystId: 'failure-mode',
      area: 'failure-mode',
      model: 'any',
      baseUrl: 'https://x/v1',
      apiKey: 'k',
      fetchImpl: stubFetch(fenced),
    })
    expect(res.outcome).toBe('ok')
    expect(res.findings).toHaveLength(2)
    expect(res.findings[0]!.area).toBe('failure-mode')
    expect(res.findings[0]!.evidence_refs[0]!.kind).toBe('span')
    expect(res.findings[0]!.claim).toContain('671→8776')
  })

  it('a substantive report that yields nothing after the reask → extraction_failed (no silent empty)', async () => {
    const res = await structureFindings({
      report: REPORT,
      analystId: 'failure-mode',
      area: 'failure-mode',
      model: 'any',
      baseUrl: 'https://x/v1',
      apiKey: 'k',
      maxReasks: 1,
      fetchImpl: stubFetch('I could not find anything.'), // never valid JSON
    })
    expect(res.outcome).toBe('extraction_failed')
    expect(res.findings).toHaveLength(0)
  })

  it('a SHORT report with no findings is a legitimate empty (ok), not a failure', async () => {
    const res = await structureFindings({
      report: 'No issues observed.',
      analystId: 'failure-mode',
      area: 'failure-mode',
      model: 'any',
      baseUrl: 'https://x/v1',
      apiKey: 'k',
      fetchImpl: stubFetch('[]'),
    })
    expect(res.outcome).toBe('ok')
    expect(res.findings).toHaveLength(0)
  })
})
