import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  calibrateJudgePanel,
  gateJudgeCalibration,
  type JudgeCalibrationGoldItem,
} from '../src/meta-eval'

// The only fake is the provider: a local OpenAI-compatible server. The real
// HTTP client, JSON parsing, retry policy and calibration run.
type Dim = 'accuracy' | 'tone'

const GRADES: Record<string, Record<Dim, number | null>> = {
  'item-1': { accuracy: 0.9, tone: 0.2 },
  'item-2': { accuracy: 0.1, tone: 0.8 },
  'item-3': { accuracy: 0.5, tone: null },
  'item-4': { accuracy: 0.7, tone: 0.4 },
}

const items: JudgeCalibrationGoldItem<Dim>[] = [
  ...Object.entries(GRADES).map(([id, grade]) => ({
    id,
    scenarioLabel: `persona-${id}`,
    scenario: `input for ${id}`,
    candidateOutput: `${id} ${'x'.repeat(50)}`,
    humanGrade: grade,
  })),
  { id: 'item-5', scenario: 'ungraded', candidateOutput: 'item-5', humanGrade: null },
]

const requests: Array<{ model: string; system: string; user: string }> = []
let invalidOnce = true
let server: Server
let baseUrl: string

beforeAll(async () => {
  server = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    const request = JSON.parse(body) as {
      model: string
      messages: Array<{ role: string; content: string }>
    }
    const system = request.messages[0]?.content ?? ''
    const user = request.messages[1]?.content ?? ''
    requests.push({ model: request.model, system, user })
    const id = /^Scenario: persona-(item-\d)|^Scenario: (item-\d)/m.exec(user)
    const itemId = id?.[1] ?? id?.[2] ?? ''
    let content: string
    if (request.model === 'acme/faithful') {
      // Echo the human grade: a perfectly calibrated judge.
      const g = GRADES[itemId] ?? { accuracy: 0.3, tone: 0.3 }
      content = JSON.stringify({ accuracy: g.accuracy, tone: g.tone ?? 0.3, rationale: 'ok' })
    } else if (invalidOnce) {
      // A non-transient fault the panel still retries.
      invalidOnce = false
      content = 'not json at all'
    } else {
      content = JSON.stringify({ accuracy: 1, tone: 1, rationale: 'always top marks' })
    }
    res.setHeader('content-type', 'application/json')
    res.setHeader('connection', 'close')
    res.end(
      JSON.stringify({
        model: request.model,
        choices: [{ message: { content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }),
    )
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
})

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))

describe('calibrateJudgePanel over a real HTTP provider', () => {
  it('scores every item with every judge, calibrates graded cells only, and gates them', async () => {
    const lines: string[] = []
    const result = await calibrateJudgePanel<Dim>({
      rubric: {
        accuracy: { weight: 0.6, guide: 'Facts are right.' },
        tone: { weight: 0.4, guide: 'Register fits.' },
      },
      items,
      judges: ['acme/faithful', 'zeta/flatterer'],
      llm: { baseUrl, apiKey: 'fixture-only', maximumAttempts: 1 },
      prompt: {
        system: 'You are a strict reviewer.',
        candidateHeading: 'Candidate output (final brief) to score:',
        maxCandidateChars: 20,
        closingLines: ['Score not-applicable dimensions 0.5.'],
      },
      log: (line) => lines.push(line),
    })

    // 5 items × 2 judges, plus one retry after the invalid JSON reply.
    expect(requests).toHaveLength(11)
    const first = requests[0]!
    expect(first.system).toBe('You are a strict reviewer.')
    expect(first.user).toContain('Scenario: persona-item-1')
    expect(first.user).toContain('- accuracy (weight 0.6): Facts are right.')
    expect(first.user).toContain('Candidate output (final brief) to score:')
    expect(first.user).toContain(`---\n${`item-1 ${'x'.repeat(50)}`.slice(0, 20)}\n---`)
    expect(first.user).toContain('{"accuracy":number,"tone":number,"rationale":string}')
    expect(first.user.endsWith('Score not-applicable dimensions 0.5.')).toBe(true)
    expect(requests.some((r) => r.user.includes('Scenario: item-5'))).toBe(true)

    expect(result.failures).toEqual([])
    expect(result.ungradedItems).toEqual({ accuracy: ['item-5'], tone: ['item-3', 'item-5'] })
    // Ungraded cells are judged and kept in rawScores, never calibrated.
    expect(result.rawScores['acme/faithful']!.tone).toHaveLength(5)
    const faithful = result.perJudge['acme/faithful']!
    expect(faithful.accuracy.calibration.n).toBe(4)
    expect(faithful.tone.calibration.n).toBe(3)
    expect(faithful.accuracy.calibration.mae).toBe(0)
    expect(faithful.accuracy.calibration.pearson).toBeCloseTo(1, 10)
    expect(faithful.tone.golden.map((g) => g.itemId)).toEqual(['item-1', 'item-2', 'item-4'])
    expect(result.outputs['zeta/flatterer']!['item-1']).toMatchObject({ accuracy: 1, tone: 1 })
    expect(lines.some((l) => l.includes('cover=100%'))).toBe(true)

    const gate = gateJudgeCalibration(result.perJudge, {
      pearsonFloor: 0.7,
      pearsonWarn: 0.6,
      maeCeiling: 0.25,
      minSamples: 3,
    })
    expect(gate.pass).toBe(false)
    expect(gate.cells.filter((c) => c.judge === 'acme/faithful').map((c) => c.verdict)).toEqual([
      'pass',
      'pass',
    ])
    expect(gate.cells.filter((c) => c.verdict === 'fail').map((c) => c.judge)).toEqual([
      'zeta/flatterer',
      'zeta/flatterer',
    ])
  }, 30_000)
})
