import { type ChildProcess, spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFindingsLedger, parseAnalystFinding } from '../src/analyst/index'
import {
  type DecisionInvocation,
  type DecisionQuestionPolicy,
  decisionPoint,
  decisionQuestionDigest,
} from '../src/systemone'

// The only fake is the provider process. Real HTTP, metering, schema and file ledger execute.
const provider = `
import { createServer } from 'node:http'
let calls = 0
const server = createServer(async (req, res) => {
  if (req.url === '/calls') return res.end(String(calls))
  calls++
  let body = ''
  for await (const chunk of req) body += chunk
  const request = JSON.parse(body)
  if (request.state.fail) { res.statusCode = 503; return res.end('unavailable') }
  const p = request.state.tie ? .5 : request.state.nearTie ? .49996 : .9
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify({
    model: request.state.whitespaceModel ? ' ' + request.model + ' ' : request.state.mismatch ? 'other-model' : request.model,
    answers: Object.fromEntries(Object.keys(request.questions).map(name => [name, {
      type: 'choice', choice: 'inspect', confidence: p,
      probabilities: { inspect: p, record: 1 - p },
    }])),
    usage: { input_tokens: 30, output_tokens: 2 },
  }))
})
server.listen(0, '127.0.0.1', () => console.log(server.address().port))
`

let child: ChildProcess
let baseUrl: string
let directory: string
const questions = {
  route: {
    type: 'choice',
    instructions: 'Which reversible triage route?',
    criteria: { inspect: 'Inspect the evidence', record: 'Record only' },
  },
} as const
const identity = { id: 'triage', version: '1', model: 'decision-provider' }
const calibrated: DecisionQuestionPolicy = {
  minimumProbability: 0.8,
  minimumMargin: 0.2,
  options: { inspect: { action: 'act', route: 'inspect' }, record: { action: 'record' } },
  calibration: {
    servedModel: identity.model,
    gold_n: 20,
    agreement: 0.95,
    kappa: 0.9,
    questionDigest: decisionQuestionDigest({
      ...identity,
      servedModel: identity.model,
      name: 'route',
      question: questions.route,
    }),
    evidenceRefs: [{ kind: 'artifact', uri: 'artifact://integration-only/independent-labels' }],
  },
}

function invocation(id: string, state: Record<string, boolean> = {}): DecisionInvocation {
  return {
    runId: 'run',
    invocationId: id,
    consumer: 'integration',
    layer: 'event',
    state,
    at: '2026-10-23T00:00:00Z',
    evidenceRefs: [{ kind: 'event', uri: `event://${id}` }],
    scope: {
      population: [id],
      n: 1,
      window: { from: '2026-10-23T00:00:00Z', to: '2026-10-23T00:00:00Z' },
    },
  }
}

function point(path: string, policy = calibrated, ancillary?: DecisionQuestionPolicy) {
  return decisionPoint({
    ...identity,
    layers: ['event', 'turn'],
    questions: (ancillary ? { ...questions, evidence: questions.route } : questions) as Record<
      string,
      typeof questions.route
    >,
    policy: ancillary ? { route: policy, evidence: ancillary } : { route: policy },
    ledger: openFindingsLedger({ path }),
    evaluator: {
      evaluate: async (request, context) => {
        const response = await fetch(baseUrl, {
          method: 'POST',
          body: JSON.stringify(request),
          signal: context.signal,
        })
        if (!response.ok) throw new Error(`Provider status ${response.status}`)
        return response.json()
      },
      pricing: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 },
    },
  })
}

function ok<T>(
  result: { succeeded: true; value: T } | { succeeded: false; error: { message: string } },
): T {
  if (!result.succeeded) throw new Error(result.error.message)
  return result.value
}

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'decision-point-'))
  child = spawn(process.execPath, ['--input-type=module', '-e', provider], {
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  const lines = createInterface({ input: child.stdout! })
  const port = await new Promise<string>((resolve, reject) => {
    lines.once('line', resolve)
    child.once('error', reject)
    child.once('exit', (code) => reject(new Error(`Provider exited ${code}`)))
  })
  baseUrl = `http://127.0.0.1:${port}`
  lines.close()
})
afterAll(async () => {
  child?.kill()
  if (directory) await rm(directory, { recursive: true, force: true })
})

describe('decisionPoint public SDK with HTTP provider and durable findings', () => {
  it('reserves before inference and replays across restart without spending twice', async () => {
    const path = join(directory, 'replay.jsonl')
    const run = point(path)
    const before = Number(await (await fetch(`${baseUrl}/calls`)).text())
    const values = await Promise.all([
      run.decide(invocation('one')),
      point(path).decide(invocation('one')),
    ])
    const first = values.map(ok).find((value) => value.record !== null)!
    expect(first.record?.action).toBe('act')
    expect(Number(await (await fetch(`${baseUrl}/calls`)).text()) - before).toBe(1)
    expect(parseAnalystFinding(first.finding).succeeded).toBe(true)
    const replay = ok(await point(path).decide(invocation('one')))
    expect(replay.replayed).toBe(true)
    expect(replay.record).toEqual(first.record)
    const stopped = new AbortController()
    stopped.abort()
    expect((await run.decide(invocation('one'), { signal: stopped.signal })).succeeded).toBe(false)
    expect((await run.decide(invocation('one', { changed: true }))).succeeded).toBe(false)
  })

  it('captures record-only choices without changing routing or requiring auxiliary truth labels', async () => {
    const capture: DecisionQuestionPolicy = {
      recordOnly: true,
      minimumProbability: 1,
      minimumMargin: 1,
      options: { inspect: { action: 'record' }, record: { action: 'record' } },
    }
    const before = Number(await (await fetch(`${baseUrl}/calls`)).text())
    for (const forbidden of [
      { ...capture, calibration: calibrated.calibration },
      {
        ...capture,
        options: {
          inspect: { action: 'act' as const, route: 'inspect' },
          record: { action: 'record' as const },
        },
      },
      {
        ...capture,
        options: {
          inspect: { action: 'escalate' as const },
          record: { action: 'record' as const },
        },
      },
    ])
      expect(() => point(join(directory, 'invalid-capture.jsonl'), calibrated, forbidden)).toThrow(
        /Record-only/,
      )
    expect(Number(await (await fetch(`${baseUrl}/calls`)).text())).toBe(before)
    const run = point(join(directory, 'capture.jsonl'), calibrated, capture)
    const result = ok(await run.decide(invocation('one')))
    expect(result.action).toBe('act')
    expect(result.record!.answers.evidence).toMatchObject({
      reason: 'record-only',
      recommendation: { action: 'record' },
    })
    ok(
      await run.observe({
        runId: 'run',
        invocationId: 'one',
        labels: { route: 'inspect' },
        at: '2026-10-23T01:00:00Z',
        evidenceRefs: [{ kind: 'artifact', uri: 'artifact://integration-only/labels' }],
      }),
    )
    const report = ok(await run.reliability())
    expect(report).toMatchObject({
      decisions: 1,
      labeled: 1,
      missingOutcomes: 0,
      recordOnlyQuestions: ['evidence'],
    })
    expect(Object.keys(report.questions)).toEqual(['route'])
    expect(ok(await run.decide(invocation('failed', { fail: true }))).record).toMatchObject({
      action: 'escalate',
      error: 'evaluation-failed',
    })
    const captureOnly = point(join(directory, 'capture-only.jsonl'), capture)
    expect(ok(await captureOnly.decide(invocation('only'))).action).toBe('record')
    expect(ok(await captureOnly.reliability())).toMatchObject({
      labeled: 0,
      missingOutcomes: 1,
      questions: {},
      recordOnlyQuestions: ['route'],
    })
  })

  it('joins observed outcomes once and reports reliability with missing labels', async () => {
    const run = point(join(directory, 'outcomes.jsonl'))
    ok(await run.decide(invocation('one')))
    const observation = {
      runId: 'run',
      invocationId: 'one',
      labels: { route: 'inspect' },
      at: '2026-10-23T01:00:00Z',
      evidenceRefs: [{ kind: 'artifact' as const, uri: 'artifact://human/one' }],
    }
    expect(ok(await run.observe(observation))).toEqual({ appended: 1, replayed: 0 })
    expect(ok(await run.observe(observation))).toEqual({ appended: 0, replayed: 1 })
    expect((await run.observe({ ...observation, labels: { route: 'record' } })).succeeded).toBe(
      false,
    )
    ok(await run.decide({ ...invocation('two'), layer: 'turn', consumer: 'second-consumer' }))
    const report = ok(await run.reliability())
    expect(report).toMatchObject({ decisions: 2, labeled: 1, missingOutcomes: 1 })
    expect(report.questions.route).toMatchObject({ n: 1, curve: null })
    ok(await run.observe({ ...observation, invocationId: 'two', labels: { route: 'record' } }))
    const curve = ok(await run.reliability()).questions.route!
    expect(curve.n).toBe(2)
    expect(curve.curve?.bins[0]).toMatchObject({ n: 2, evalMean: 0.9, outcomeMean: 0.5 })
  })

  it('records uncalibrated, ambiguous, served-model mismatch and unavailable answers as escalation', async () => {
    for (const [id, state, policy, reason] of [
      ['uncalibrated', {}, { ...calibrated, calibration: undefined }, 'uncalibrated'],
      [
        'changed-labels',
        {},
        { ...calibrated, calibration: { ...calibrated.calibration!, questionDigest: 'stale' } },
        'uncalibrated',
      ],
      ['tie', { tie: true }, calibrated, 'uncertain'],
      ['near-tie', { nearTie: true }, calibrated, 'uncertain'],
      ['mismatch', { mismatch: true }, calibrated, 'model-mismatch'],
    ] as const) {
      const result = ok(
        await point(join(directory, `${id}.jsonl`), policy).decide(invocation(id, state)),
      )
      expect(result.record?.error, JSON.stringify({ id, record: result.record })).toBe(null)
      expect(result.action).toBe('escalate')
      expect(result.record?.answers.route?.reason).toBe(reason)
      const replay = ok(
        await point(join(directory, `${id}.jsonl`), policy).decide(invocation(id, state)),
      )
      expect(replay.record).toEqual(result.record)
    }
    const failed = point(join(directory, 'failure.jsonl'))
    const result = ok(await failed.decide(invocation('failure', { fail: true })))
    expect(result.record).toMatchObject({
      action: 'escalate',
      servedModel: null,
      answers: {},
      error: 'evaluation-failed',
    })
    expect(ok(await failed.reliability())).toMatchObject({
      decisions: 1,
      labeled: 0,
      missingOutcomes: 1,
    })
    expect(
      (
        await failed.observe({
          runId: 'run',
          invocationId: 'failure',
          labels: { route: 'inspect' },
          at: '2026-10-23T01:00:00Z',
          evidenceRefs: [{ kind: 'artifact', uri: 'artifact://label' }],
        })
      ).succeeded,
    ).toBe(false)
  })
})

describe('decisionPoint validation and durable evidence boundaries', () => {
  it('refuses malformed calibration data before a paid provider call', async () => {
    const before = Number(await (await fetch(`${baseUrl}/calls`)).text())
    const valid = calibrated.calibration!
    for (const calibration of [
      null,
      { ...valid, evidenceRefs: { length: 1 } },
      { ...valid, evidenceRefs: [null] },
      { ...valid, evidenceRefs: [] },
      { ...valid, evidenceRefs: undefined },
      { ...valid, evidenceRefs: [{ kind: 'other', uri: 'artifact://label' }] },
      { ...valid, evidenceRefs: [{ kind: 'artifact', uri: '' }] },
      { ...valid, evidenceRefs: [{ kind: 'artifact', uri: 'artifact://label', extra: true }] },
      { ...valid, gold_n: 0 },
      { ...valid, kappa: Number.POSITIVE_INFINITY },
      { ...valid, agreement: Number.NaN },
      { ...valid, servedModel: ' model ' },
      { ...valid, questionDigest: '' },
    ]) {
      expect(() =>
        point(join(directory, 'invalid-calibration.jsonl'), {
          ...calibrated,
          calibration: calibration as NonNullable<DecisionQuestionPolicy['calibration']>,
        }),
      ).toThrow()
    }
    expect(Number(await (await fetch(`${baseUrl}/calls`)).text())).toBe(before)
  })

  it('returns typed invalid outcomes for uncloneable and noncanonical observations', async () => {
    const run = point(join(directory, 'observation-boundary.jsonl'))
    ok(await run.decide(invocation('observation-boundary')))
    const input = {
      runId: 'run',
      invocationId: 'observation-boundary',
      labels: { route: 'inspect' },
      at: '2026-10-23T01:00:00Z',
      evidenceRefs: [{ kind: 'artifact' as const, uri: 'artifact://human/label' }],
    }
    const before = ok(await run.reliability()).ledgerRoot
    const cycle: Record<string, unknown> = {}
    cycle.self = cycle
    for (const observation of [
      { ...input, labels: { route: () => 'inspect' } },
      { ...input, evidenceRefs: [{ kind: 'artifact', uri: () => 'artifact://label' }] },
      { ...input, labels: { route: 1n } },
      { ...input, labels: { route: Number.NaN } },
      { ...input, labels: cycle },
      { ...input, labels: null },
      { ...input, evidenceRefs: [null] },
    ]) {
      await expect(run.observe(observation as typeof input)).resolves.toMatchObject({
        succeeded: false,
        error: { kind: 'invalid' },
      })
    }
    expect(ok(await run.reliability()).ledgerRoot).toBe(before)
    expect(ok(await run.observe(input))).toEqual({ appended: 1, replayed: 0 })
  })

  it('persists a replayable failed decision for a noncanonical served-model identity', async () => {
    const path = join(directory, 'served-model-boundary.jsonl')
    const run = point(path)
    const input = invocation('served-model-boundary', { whitespaceModel: true })
    const before = Number(await (await fetch(`${baseUrl}/calls`)).text())
    const first = ok(await run.decide(input))
    expect(first.record).toMatchObject({
      servedModel: null,
      error: 'evaluation-failed',
      action: 'escalate',
      answers: {},
    })
    const replay = ok(await point(path).decide(input))
    expect(replay.replayed).toBe(true)
    expect(replay.record).toEqual(first.record)
    expect(ok(await point(path).reliability())).toMatchObject({
      attempts: 1,
      decisions: 1,
      failed: 1,
      unresolved: 0,
    })
    expect(Number(await (await fetch(`${baseUrl}/calls`)).text()) - before).toBe(1)
  })

  it('withholds inference/action when the ledger cannot persist an intent', async () => {
    const run = point(join(directory, 'missing', 'ledger.jsonl'))
    // Opening under a regular file is a real filesystem refusal.
    const impossible = point(join(directory, 'replay.jsonl', 'ledger.jsonl'))
    const before = Number(await (await fetch(`${baseUrl}/calls`)).text())
    expect((await impossible.decide(invocation('unwritable'))).succeeded).toBe(false)
    expect(Number(await (await fetch(`${baseUrl}/calls`)).text())).toBe(before)
    expect(run.id).toBe('triage')
  })

  it('joins multiple question labels independently and preserves unknown denominators', async () => {
    const twoQuestions = { first: questions.route, second: questions.route }
    const definition = {
      ...identity,
      layers: ['event' as const],
      questions: twoQuestions,
      ledger: openFindingsLedger({ path: join(directory, 'multi-question.jsonl') }),
      evaluator: {
        evaluate: async (request: unknown) =>
          (await fetch(baseUrl, { method: 'POST', body: JSON.stringify(request) })).json(),
        pricing: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 },
      },
      policy: Object.fromEntries(
        Object.entries(twoQuestions).map(([name, question]) => [
          name,
          {
            ...calibrated,
            calibration: {
              ...calibrated.calibration!,
              questionDigest: decisionQuestionDigest({
                ...identity,
                servedModel: identity.model,
                name,
                question,
              }),
            },
          },
        ]),
      ) as { first: DecisionQuestionPolicy; second: DecisionQuestionPolicy },
    }
    const run = decisionPoint(definition)
    ok(await run.decide(invocation('two-questions')))
    const observation = {
      runId: 'run',
      invocationId: 'two-questions',
      at: '2026-10-23T02:00:00Z',
      evidenceRefs: [{ kind: 'artifact' as const, uri: 'artifact://labels' }],
    }
    ok(await run.observe({ ...observation, labels: { first: 'inspect' } }))
    const partial = ok(await run.reliability())
    expect(partial).toMatchObject({ labeled: 0, missingOutcomes: 1 })
    expect(partial.questions.second).toMatchObject({
      n: 0,
      predictions: 1,
      missingLabels: 1,
      curve: null,
    })
    ok(await run.observe({ ...observation, labels: { second: 'record' } }))
    expect(ok(await run.reliability())).toMatchObject({ labeled: 1, missingOutcomes: 0 })
    const extraRoute = { action: 'record' as const, extra: true }
    expect(() =>
      decisionPoint({
        ...definition,
        policy: {
          ...definition.policy,
          first: { ...calibrated, options: { inspect: extraRoute, record: { action: 'record' } } },
        },
      }),
    ).toThrow('Invalid decision route')
  })
})
