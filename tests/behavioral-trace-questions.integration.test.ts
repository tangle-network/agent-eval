import { type ChildProcess, spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type {
  AnalystFinding,
  AnalystUsageReceipt,
  BehavioralTraceGold,
  BehavioralTraceQuestionsOptions,
  BehavioralTraceWindow,
} from '../src/analyst/index'
import * as api from '../src/analyst/index'
import { otlpTextToTraceAnalysisStore } from '../src/traces'

// Only the external provider is fake. The SDK, HTTP, OTLP store, accounting and journal are real.
const provider = `
import { createServer } from 'node:http'
let calls = []
const server = createServer(async (req, res) => {
  // Journal fsyncs may outlive an idle socket; every fixture exchange owns its connection.
  res.setHeader('connection', 'close')
  if (req.url === '/calls') return res.end(JSON.stringify(calls))
  let body = ''; for await (const chunk of req) body += chunk
  const request = JSON.parse(body); calls.push(request)
  if (request.state.source === 'provider-error') { res.statusCode = 503; return res.end('unavailable') }
  if (request.state.source === 'provider-wait') await new Promise(resolve => setTimeout(resolve, 300))
  const choice = request.state.source === 'observed-no' ? 'no' : 'yes'
  const tie = request.state.source === 'provider-tie'
  const probabilities = tie ? { yes: .5, no: .5, unsure: 0 }
    : choice === 'yes' ? { yes: .95, no: .03, unsure: .02 } : { yes: .03, no: .95, unsure: .02 }
  res.setHeader('content-type','application/json')
  res.end(JSON.stringify({
    model: request.state.source === 'provider-other-model' ? 'other-model' : request.model,
    answers: Object.fromEntries(Object.keys(request.questions).map(name => [name, {type:'choice', choice, confidence: probabilities[choice], probabilities}])),
    ...(request.state.source === 'provider-unknown-usage' ? {} : {usage:{input_tokens:30,output_tokens:8}}),
  }))
})
server.listen(0, '127.0.0.1', () => console.log(server.address().port))
`
let child: ChildProcess
let baseUrl: string
let directory: string
let store: ReturnType<typeof otlpTextToTraceAnalysisStore>
const evaluatorIdentity = {
  id: 'integration-http-provider',
  version: '1',
  config: { priceSource: 'integration-fixed', maxInputTokens: 100, maxOutputTokens: 100 },
}
const windowPolicy = { id: 'integration-only-whole-window', version: '1' }
const context = (id: string) => ({ runId: id, correlationId: 'analysis-1' })
function window(
  id: string,
  layer: BehavioralTraceWindow['layer'] = 'event',
  state = 'observed-yes',
): BehavioralTraceWindow {
  return {
    id,
    traceId: 't000000000001',
    subject: 'AuditCoord',
    layer,
    from: '2026-04-24T18:12:13Z',
    to: '2026-04-24T18:12:30Z',
    state,
    capture: { complete: true, limitations: [] },
    evidenceRefs: [{ kind: 'span', uri: 'trace://t000000000001/span/s001' }],
    toolCalls: {
      complete: true,
      attempts: [
        { id: 'a', name: 'inspect', args: { path: 'output' } },
        { id: 'b', name: 'inspect', args: { path: 'output' } },
      ],
    },
  }
}
function options(id: string, windows: BehavioralTraceWindow[]): BehavioralTraceQuestionsOptions {
  return {
    analysisId: id,
    model: 'behavioral-provider',
    evaluatorIdentity,
    windowPolicy,
    windows,
    ledger: api.openFindingsLedger({ path: join(directory, `${id}.jsonl`) }),
    evaluator: {
      evaluate: async (request, ctx) => {
        const response = await fetch(baseUrl, {
          method: 'POST',
          body: JSON.stringify(request),
          signal: ctx.signal,
        })
        if (!response.ok) throw new Error(`Provider ${response.status}`)
        return response.json()
      },
      pricing: { inputUsdPerMillion: 1, outputUsdPerMillion: 1 },
      maximumCharge: {
        customTokenPricing: { inputUsdPerMillion: 1, outputUsdPerMillion: 1 },
        inputTokens: 100,
        outputTokens: 100,
      },
    },
  }
}
async function analyze(
  id: string,
  config: BehavioralTraceQuestionsOptions,
  overrides: Partial<api.AnalystContext> = {},
) {
  return (
    await api
      .behavioralAnalyst({ traceQuestions: config })
      .analyze(store, { ...context(id), ...overrides })
  ).filter((f) => f.area === 'behavioral-trace-question')
}
function row(f: AnalystFinding): Record<string, any> {
  return f.metadata!.behavioral_trace_question as Record<string, any>
}
async function calls(): Promise<Array<{ questions: Record<string, unknown>; state: unknown }>> {
  return (await fetch(`${baseUrl}/calls`)).json()
}
function read<T>(
  outcome: { succeeded: true; value: T } | { succeeded: false; error: { message: string } },
): T {
  if (!outcome.succeeded) throw new Error(outcome.error.message)
  return outcome.value
}
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'behavioral-trace-'))
  store = otlpTextToTraceAnalysisStore(
    await readFile(new URL('./fixtures/trace-analyst/tiny-trace.jsonl', import.meta.url), 'utf8'),
  )
  child = spawn(process.execPath, ['--input-type=module', '-e', provider], {
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  const lines = createInterface({ input: child.stdout! })
  const port = await new Promise<string>((resolve, reject) => {
    lines.once('line', resolve)
    child.once('error', reject)
  })
  baseUrl = `http://127.0.0.1:${port}`
  lines.close()
})
afterAll(async () => {
  child?.kill()
  if (directory) await rm(directory, { recursive: true, force: true })
})

describe('behavioralAnalyst public SDK question battery', () => {
  it('writes nine scoped observations at each layer and replays without another physical call', async () => {
    const before = (await calls()).length
    expect(api.behavioralAnalyst().cost.kind).toBe('deterministic')
    await api.behavioralAnalyst().analyze(store, context('default'))
    expect((await calls()).length).toBe(before)
    const config = options('scopes', [
      window('event'),
      window('turn', 'turn'),
      window('agent', 'agent'),
    ])
    const usage: AnalystUsageReceipt[] = []
    const findings = await analyze('scopes', config, { recordUsage: (r) => usage.push(r) })
    expect(findings).toHaveLength(27)
    for (const layer of ['event', 'turn', 'agent'])
      expect(findings.filter((f) => f.layer === layer)).toHaveLength(9)
    expect(findings.every((f) => f.schema_version === '1.1.0' && f.scope!.n === 1)).toBe(true)
    expect(
      findings.every((f) => row(f).calibration === 'uncalibrated' && !row(f).eligibleAlarm),
    ).toBe(true)
    expect(findings.filter((f) => f.method!.kind === 'computed')).toHaveLength(3)
    expect(usage).toHaveLength(3)
    expect(
      usage.every((r) => r.calls === 1 && r.tokens?.input === 30 && r.cost.kind === 'estimated'),
    ).toBe(true)
    const requests = (await calls()).slice(before)
    expect(requests).toHaveLength(3)
    expect(
      requests.every(
        (r) =>
          Object.keys(r.questions).length === 8 &&
          !Object.hasOwn(r.questions, 'identical-tool-repeat'),
      ),
    ).toBe(true)
    expect(JSON.stringify(requests)).not.toContain('gold_n')
    expect(JSON.stringify(requests)).not.toContain('calibrations')
    const ledger = read(await config.ledger.read())
    expect(ledger.findings).toHaveLength(33)
    expect(findings.every((f) => api.parseAnalystFinding(f).succeeded)).toBe(true)
    const replayUsage: AnalystUsageReceipt[] = []
    expect(
      await analyze(
        'scopes',
        { ...config, ledger: api.openFindingsLedger({ path: config.ledger.path }) },
        { correlationId: 'fresh-registry-correlation', recordUsage: (r) => replayUsage.push(r) },
      ),
    ).toEqual(findings)
    expect((await calls()).length).toBe(before + 3)
    expect(read(await config.ledger.read()).findings).toHaveLength(33)
    expect(replayUsage).toEqual([
      { calls: 0, tokens: { input: 0, output: 0 }, cost: { kind: 'observed', usd: 0 } },
    ])
  })

  it('lets only a terminal owner finalize observations during concurrent registry analyses', async () => {
    const config = options('concurrent', [window('concurrent', 'event', 'provider-wait')])
    const before = (await calls()).length
    const results = await Promise.allSettled([
      analyze('concurrent', config, { correlationId: 'registry-a' }),
      analyze('concurrent', config, { correlationId: 'registry-b' }),
    ])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1)
    expect(read(await config.ledger.read()).findings).toHaveLength(11)
    expect(await analyze('concurrent', config, { correlationId: 'registry-restart' })).toHaveLength(
      9,
    )
    expect((await calls()).length).toBe(before + 1)
  })

  it('calibrates each question independently and limits positives to matching coordinator alarms', async () => {
    const yes = window('yes')
    const no = window('no', 'event', 'observed-no')
    no.toolCalls!.attempts.pop()
    const config = options('calibration', [yes, no, window('turn', 'turn')])
    const observations = await analyze('calibration', config)
    const gold: BehavioralTraceGold[] = ['unverified-completion', 'identical-tool-repeat'].flatMap(
      (id) => [
        {
          questionId: id as BehavioralTraceGold['questionId'],
          windowId: 'yes',
          label: 'yes',
          source: 'human',
        },
        {
          questionId: id as BehavioralTraceGold['questionId'],
          windowId: 'no',
          label: 'no',
          source: 'human',
        },
      ],
    )
    // Synthetic integration labels test wiring only; these are never scientific calibration evidence.
    const report = api.calibrateBehavioralTraceQuestions({
      layer: 'event',
      windowPolicy,
      evaluatorIdentity,
      model: config.model,
      servedModel: config.model,
      gold,
      findings: observations,
      evidenceRefs: [{ kind: 'artifact', uri: 'artifact://integration-only-independent-labels' }],
    })
    expect(report).toHaveLength(9)
    expect(report.filter((r) => r.eligible)).toHaveLength(2)
    expect(report.filter((r) => r.eligible).every((r) => r.gold_n === 2 && r.kappa === 1)).toBe(
      true,
    )
    expect(report.filter((r) => r.gold_n === 0).every((r) => r.kappa === null && !r.eligible)).toBe(
      true,
    )
    config.calibrations = {
      event: Object.fromEntries(
        report.filter((r) => r.calibration).map((r) => [r.questionId, r.calibration!]),
      ),
    }
    config.analysisId = 'calibrated'
    const calibrated = await analyze('calibration', config, { correlationId: 'calibrated' })
    const alarms = calibrated.filter((f) => row(f).eligibleAlarm)
    expect(alarms).toHaveLength(2)
    expect(alarms.every((f) => f.layer === 'event' && row(f).route === 'coordinator-alarm')).toBe(
      true,
    )
    expect(alarms.find((f) => f.method!.kind === 'computed')!.method!.calibration).toBeUndefined()
    const changedPolicy = await analyze(
      'calibration',
      { ...config, analysisId: 'new-policy', windowPolicy: { ...windowPolicy, version: '2' } },
      { correlationId: 'new-policy' },
    )
    expect(changedPolicy.every((f) => !row(f).eligibleAlarm)).toBe(true)
    const mismatch = await analyze(
      'calibration',
      {
        ...config,
        analysisId: 'other-model',
        windows: [window('mismatch', 'event', 'provider-other-model')],
      },
      { correlationId: 'other-model' },
    )
    expect(
      mismatch
        .filter((f) => f.method!.kind === 'judged')
        .every((f) => !row(f).eligibleAlarm && row(f).servedModel === 'other-model'),
    ).toBe(true)
    const tie = await analyze(
      'calibration',
      { ...config, analysisId: 'tie', windows: [window('tie', 'event', 'provider-tie')] },
      { correlationId: 'tie' },
    )
    expect(tie.filter((f) => f.method!.kind === 'judged').every((f) => !row(f).eligibleAlarm)).toBe(
      true,
    )
    expect(calibrated.every((f) => !('pass' in row(f)) && !('acceptance' in row(f)))).toBe(true)
  })

  it('keeps missing labels, unsure and absent predictions distinct in public calibration', async () => {
    const config = options('missing', [window('observed')])
    const findings = await analyze('missing', config)
    const report = api.calibrateBehavioralTraceQuestions({
      layer: 'event',
      windowPolicy,
      evaluatorIdentity,
      model: config.model,
      servedModel: config.model,
      findings,
      evidenceRefs: [{ kind: 'artifact', uri: 'artifact://integration-only-labels' }],
      gold: [
        {
          questionId: 'unverified-completion',
          windowId: 'observed',
          label: 'yes',
          source: 'human',
        },
        { questionId: 'unverified-completion', windowId: 'absent', label: 'no', source: 'agentrx' },
        {
          questionId: 'unverified-completion',
          windowId: 'unlabeled',
          label: null,
          source: 'human',
        },
        {
          questionId: 'unverified-completion',
          windowId: 'ambiguous',
          label: 'unsure',
          source: 'human',
        },
      ],
    })
    const result = report.find((r) => r.questionId === 'unverified-completion')!
    expect(result).toMatchObject({
      gold_n: 2,
      missingLabels: 1,
      unsureLabels: 1,
      missingPredictions: 1,
      eligible: false,
      calibration: null,
      sourceCounts: { human: 1, agentrx: 1 },
    })
    expect(result.confusion.no.missing).toBe(1)
    expect(result.agreement).toBe(0.5)
    const empty = api.calibrateBehavioralTraceQuestions({
      layer: 'event',
      windowPolicy,
      evaluatorIdentity,
      model: config.model,
      servedModel: config.model,
      findings: [],
      gold: [],
      evidenceRefs: [],
    })
    expect(empty.every((r) => r.kappa === null && r.agreement === null && !r.eligible)).toBe(true)
  })

  it('deduplicates physical attempts and refuses conflicting or unbounded source data before spending', async () => {
    const replay = window('replayed')
    replay.toolCalls!.attempts[1]!.id = 'a'
    const partial = window('partial')
    delete partial.toolCalls
    partial.capture = { complete: false, limitations: ['missing native tools'] }
    const config = options('computed', [replay, partial])
    const findings = await analyze('computed', config)
    expect(findings.filter((f) => f.method!.kind === 'computed').map((f) => row(f).answer)).toEqual(
      ['no', 'unsure'],
    )
    const before = (await calls()).length
    const conflict = structuredClone(replay)
    conflict.toolCalls!.attempts[1]!.args = { path: 'different' }
    expect(() =>
      api.behavioralAnalyst({ traceQuestions: { ...config, windows: [conflict] } }),
    ).toThrow(/Conflicting physical/)
    expect(() => api.behavioralAnalyst({ traceQuestions: { ...config, maxWindows: 1 } })).toThrow(
      /Too many/,
    )
    expect(() =>
      api.behavioralAnalyst({ traceQuestions: { ...config, maxWindowBytes: 1 } }),
    ).toThrow(/maxWindowBytes/)
    expect(() =>
      api.behavioralAnalyst({
        traceQuestions: {
          ...config,
          calibrations: { event: { 'unverified-completion': { gold_n: 2 } as any } },
        },
      }),
    ).toThrow()
    await expect(
      analyze('computed', { ...config, windows: [{ ...replay, traceId: 'outside' }] }),
    ).rejects.toThrow(/outside/)
    expect((await calls()).length).toBe(before)
  })

  it('captures ledger and evaluator references and binds their declared identity', async () => {
    const config = options('captured', [window('captured')])
    const original = config.ledger
    const analyst = api.behavioralAnalyst({ traceQuestions: config })
    const replacement = api.openFindingsLedger({ path: join(directory, 'replacement.jsonl') })
    config.ledger = replacement
    config.evaluator.evaluate = async () => {
      throw new Error('Mutated callback must not execute')
    }
    const findings = await analyst.analyze(store, context('captured'))
    expect(findings.filter((f) => f.area === 'behavioral-trace-question')).toHaveLength(9)
    expect(read(await original.read()).findings).toHaveLength(11)
    expect(read(await replacement.read()).findings).toHaveLength(0)
    const changed = api.behavioralAnalyst({
      traceQuestions: { ...config, evaluatorIdentity: { ...evaluatorIdentity, version: '2' } },
    })
    expect(changed.executionConfig).not.toEqual(analyst.executionConfig)
    expect(
      api.behavioralTraceQuestionDigest({
        questionId: 'unverified-completion',
        layer: 'event',
        windowPolicy,
        evaluatorIdentity,
        model: config.model,
        servedModel: config.model,
      }),
    ).not.toBe(
      api.behavioralTraceQuestionDigest({
        questionId: 'unverified-completion',
        layer: 'event',
        windowPolicy,
        evaluatorIdentity: { ...evaluatorIdentity, version: '2' },
        model: config.model,
        servedModel: config.model,
      }),
    )
  })

  it('records failed judgments as unavailable and preserves unknown usage', async () => {
    const failed = options('failed', [window('failed', 'event', 'provider-error')])
    const findings = await analyze('failed', failed)
    expect(
      findings
        .filter((f) => f.method!.kind === 'judged')
        .every(
          (f) =>
            row(f).answer === null && row(f).error === 'evaluation-failed' && !row(f).eligibleAlarm,
        ),
    ).toBe(true)
    const receipts: AnalystUsageReceipt[] = []
    const unknown = await analyze(
      'unknown',
      options('unknown', [window('unknown', 'event', 'provider-unknown-usage')]),
      { recordUsage: (r) => receipts.push(r) },
    )
    expect(unknown).toHaveLength(9)
    expect(receipts).toHaveLength(1)
    expect(receipts[0]).toMatchObject({
      calls: 1,
      tokens: null,
      cost: { kind: 'uncaptured', usd: null },
    })
  })

  it('honors cancellation, deadlines and a zero budget before provider dispatch', async () => {
    const before = (await calls()).length
    const config = options('stopped', [window('stopped')])
    await expect(analyze('stopped', config, { signal: AbortSignal.abort() })).rejects.toThrow()
    await expect(analyze('stopped', config, { deadlineMs: Date.now() - 1 })).rejects.toThrow(
      /deadline/,
    )
    const result = await analyze('stopped', config, { budgetUsd: 0 })
    expect(
      result
        .filter((f) => f.method!.kind === 'judged')
        .every((f) => row(f).answer === null && !row(f).eligibleAlarm),
    ).toBe(true)
    expect((await calls()).length).toBe(before)
  })
})
