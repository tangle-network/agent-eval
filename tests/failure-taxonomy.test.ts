import { describe, expect, it } from 'vitest'
import {
  classifyFailure,
  classifyFailureReason,
  DEFAULT_FAILURE_REASON_RULES,
  FAILURE_BLAME,
  FAILURE_CLASSES,
  type FailureBlame,
  type FailureClass,
  failureBlame,
  INFRA_FAILURE_BLAMES,
} from '../src/failure-taxonomy'
import { InMemoryTraceStore, TraceEmitter } from '../src/trace'

async function ctxFor(store: InMemoryTraceStore, runId: string) {
  const run = (await store.getRun(runId))!
  const spans = await store.spans({ runId })
  const events = await store.events({ runId })
  return { run, spans, events }
}

describe('classifyFailure', () => {
  it('returns success when run completed with pass=true', async () => {
    const store = new InMemoryTraceStore()
    const e = new TraceEmitter(store)
    await e.startRun({ scenarioId: 's' })
    await e.endRun({ pass: true, score: 1 })
    const ctx = await ctxFor(store, e.runId)
    expect(classifyFailure(ctx).failureClass).toBe('success')
  })

  it('detects budget breach — regression: budget kills would hide as "unknown"', async () => {
    const store = new InMemoryTraceStore()
    const e = new TraceEmitter(store)
    await e.startRun({ scenarioId: 's' })
    await e.recordBudget({
      dimension: 'tokens',
      limit: 10,
      consumed: 11,
      remaining: -1,
      breached: true,
    })
    await e.endRun({ pass: false })
    const ctx = await ctxFor(store, e.runId)
    const c = classifyFailure(ctx)
    expect(c.failureClass).toBe('budget_exceeded')
    expect(c.triggerEventId).toBeDefined()
  })

  it('detects sandbox exit code non-zero', async () => {
    const store = new InMemoryTraceStore()
    const e = new TraceEmitter(store)
    await e.startRun({ scenarioId: 's' })
    const h = await e.sandbox({ name: 'test', command: 'npm test' })
    await h.end({ exitCode: 1, status: 'error' } as Partial<import('../src/trace').SandboxSpan>)
    await e.endRun({ pass: false })
    const ctx = await ctxFor(store, e.runId)
    expect(classifyFailure(ctx).failureClass).toBe('sandbox_failure')
  })

  it('classifies timeout when aborted with matching note', async () => {
    const store = new InMemoryTraceStore()
    const e = new TraceEmitter(store)
    await e.startRun({ scenarioId: 's' })
    await e.abortRun('wall-clock deadline exceeded (timeout)')
    const ctx = await ctxFor(store, e.runId)
    expect(classifyFailure(ctx).failureClass).toBe('timeout')
  })

  it('detects repeated tool errors as tool_recovery_failure', async () => {
    const store = new InMemoryTraceStore()
    const e = new TraceEmitter(store)
    await e.startRun({ scenarioId: 's' })
    for (let i = 0; i < 3; i++) {
      const h = await e.tool({ name: 'search', toolName: 'search', args: { q: `q${i}` } })
      await h.fail('HTTP 500')
    }
    await e.endRun({ pass: false })
    const ctx = await ctxFor(store, e.runId)
    expect(classifyFailure(ctx).failureClass).toBe('tool_recovery_failure')
  })

  it('explicit outcome.failureClass wins over rules', async () => {
    const store = new InMemoryTraceStore()
    const e = new TraceEmitter(store)
    await e.startRun({ scenarioId: 's' })
    await e.endRun({ pass: false, failureClass: 'policy_violation' })
    const ctx = await ctxFor(store, e.runId)
    expect(classifyFailure(ctx).failureClass).toBe('policy_violation')
  })

  it('classifies missing integration connections before generic credential gaps', async () => {
    const store = new InMemoryTraceStore()
    const e = new TraceEmitter(store)
    await e.startRun({ scenarioId: 'calendar-app' })
    await e.emit({
      kind: 'custom',
      payload: {
        kind: 'integration_manifest_resolved',
        manifestId: 'calendar-app',
        missing: [
          {
            status: 'missing_connection',
            requirement: { id: 'calendar-read', connectorId: 'google-calendar' },
            missingScopes: ['https://www.googleapis.com/auth/calendar.readonly'],
          },
        ],
      },
    })
    await e.endRun({ pass: false })
    const ctx = await ctxFor(store, e.runId)
    expect(classifyFailure(ctx)).toMatchObject({
      failureClass: 'missing_integration_connection',
      reason: 'required integration connection was missing',
    })
  })

  it('classifies integration scope, approval, and policy failures distinctly', async () => {
    const scopeStore = new InMemoryTraceStore()
    const scopeEmitter = new TraceEmitter(scopeStore)
    await scopeEmitter.startRun({ scenarioId: 'gmail-summary' })
    await scopeEmitter.emit({
      kind: 'custom',
      payload: {
        kind: 'integration_invoke_failed',
        action: 'gmail.messages.search',
        code: 'scope_denied',
      },
    })
    await scopeEmitter.endRun({ pass: false })
    expect(classifyFailure(await ctxFor(scopeStore, scopeEmitter.runId)).failureClass).toBe(
      'missing_integration_scope',
    )

    const approvalStore = new InMemoryTraceStore()
    const approvalEmitter = new TraceEmitter(approvalStore)
    await approvalEmitter.startRun({ scenarioId: 'calendar-write' })
    await approvalEmitter.emit({
      kind: 'custom',
      payload: {
        kind: 'integration_invoke',
        action: 'google-calendar.events.create',
        status: 'approval_required',
      },
    })
    await approvalEmitter.endRun({ pass: false })
    expect(classifyFailure(await ctxFor(approvalStore, approvalEmitter.runId)).failureClass).toBe(
      'integration_approval_required',
    )

    const deniedStore = new InMemoryTraceStore()
    const deniedEmitter = new TraceEmitter(deniedStore)
    await deniedEmitter.startRun({ scenarioId: 'unsafe-write' })
    await deniedEmitter.emit({
      kind: 'custom',
      payload: {
        kind: 'integration_invoke_failed',
        action: 'provider.http.request',
        code: 'policy_denied',
      },
    })
    await deniedEmitter.endRun({ pass: false })
    expect(classifyFailure(await ctxFor(deniedStore, deniedEmitter.runId)).failureClass).toBe(
      'unsafe_integration_write_denied',
    )
  })

  it('classifies bad integration manifests and provider failures', async () => {
    const manifestStore = new InMemoryTraceStore()
    const manifestEmitter = new TraceEmitter(manifestStore)
    await manifestEmitter.startRun({ scenarioId: 'bad-manifest' })
    await manifestEmitter.emit({
      kind: 'custom',
      payload: {
        kind: 'integration_manifest_validated',
        valid: false,
        issues: [{ path: 'requirements[0].requiredActions', message: 'required' }],
      },
    })
    await manifestEmitter.endRun({ pass: false })
    expect(classifyFailure(await ctxFor(manifestStore, manifestEmitter.runId)).failureClass).toBe(
      'bad_integration_manifest',
    )

    const providerStore = new InMemoryTraceStore()
    const providerEmitter = new TraceEmitter(providerStore)
    await providerEmitter.startRun({ scenarioId: 'provider-failure' })
    await providerEmitter.emit({
      kind: 'custom',
      payload: {
        kind: 'integration_invoke_failed',
        action: 'slack.messages.post',
        code: 'provider_rate_limited',
      },
    })
    await providerEmitter.endRun({ pass: false })
    expect(classifyFailure(await ctxFor(providerStore, providerEmitter.runId)).failureClass).toBe(
      'integration_provider_failure',
    )
  })

  it('falls through to unknown when nothing else matches', async () => {
    const store = new InMemoryTraceStore()
    const e = new TraceEmitter(store)
    await e.startRun({ scenarioId: 's' })
    await e.endRun({ pass: false })
    const ctx = await ctxFor(store, e.runId)
    expect(classifyFailure(ctx).failureClass).toBe('unknown')
  })
})

describe('FAILURE_BLAME', () => {
  it('names a blame for every canonical class, with no hole', () => {
    expect(Object.keys(FAILURE_BLAME).sort()).toEqual([...FAILURE_CLASSES].sort())
    for (const failureClass of FAILURE_CLASSES) {
      expect(failureBlame(failureClass)).toBeDefined()
    }
  })

  it('charges success to nobody and an unread record to nobody in particular', () => {
    expect(failureBlame('success')).toBe('none')
    expect(failureBlame('unknown')).toBe('unknown')
    expect(failureBlame('unreported')).toBe('unknown')
  })

  it('counts only machine and provider as infrastructure blames', () => {
    expect([...INFRA_FAILURE_BLAMES].sort()).toEqual(['machine', 'provider'])
    expect(INFRA_FAILURE_BLAMES.has('agent')).toBe(false)
  })

  it('voids nothing an agent could have routed around', () => {
    // A denied write and an out-of-scope call are actions the agent chose.
    expect(failureBlame('unsafe_integration_write_denied')).toBe('agent')
    expect(failureBlame('missing_integration_scope')).toBe('agent')
    // A profile the harness refused is the agent's own broken instrument.
    expect(failureBlame('profile_refused')).toBe('agent')
    // A box that never provisioned is not.
    expect(failureBlame('box_provision_failure')).toBe('machine')
  })
})

describe('classifyFailureReason', () => {
  it('charges a SIGKILL during a bridge refusal to the machine — regression: read on the process signal alone, a bridge outage was charged to the agent', () => {
    const classified = classifyFailureReason(
      'seat killed by SIGKILL; bridge http://127.0.0.1:7433 unreachable: connect ECONNREFUSED',
    )
    expect(classified.failureClass).toBe('bridge_unreachable')
    expect(classified.blame).toBe('machine')
    expect(classified.failureClass).not.toBe('process_killed')
  })

  it('names the measured lane saturation that read as an agent failure', () => {
    // The six r1 director cells settled with the runtime journal's own `infra`
    // flag reading FALSE while this was the real reason.
    const classified = classifyFailureReason(
      'host-executor: acquire timeout after 900000ms (in_flight=10/10)',
    )
    expect(classified.failureClass).toBe('bridge_lane_saturated')
    expect(classified.blame).toBe('machine')
  })

  const CORPUS: ReadonlyArray<[string, FailureClass, FailureBlame]> = [
    ['seat spawn failed: connect ECONNREFUSED 127.0.0.1:7433', 'bridge_unreachable', 'machine'],
    [
      'host-executor: acquire timeout after 900000ms (in_flight=10/10)',
      'bridge_lane_saturated',
      'machine',
    ],
    ['completion did not match its recorded usage', 'router_usage_mismatch', 'machine'],
    ['session s-1 is bound to a different AgentProfile', 'session_profile_conflict', 'machine'],
    ['agent runtime restarted mid-run', 'runtime_restart', 'machine'],
    ['root driver failed before dispatch', 'root_driver_failed', 'machine'],
    ['Sandbox create did not complete within 300000ms', 'box_provision_failure', 'machine'],
    ['teardown reported destroyed=false', 'box_teardown_failure', 'machine'],
    ['profile workspace materialization failed for /w/AGENTS.md', 'profile_refused', 'agent'],
    ['turn ended without emitting any visible output', 'empty_completion', 'provider'],
    ['JSON error injected into SSE stream', 'stream_protocol_error', 'provider'],
    ['Prompt stream ended before a terminal event', 'stream_incomplete', 'provider'],
    ['message already rolled up (sealed)', 'message_sealed', 'provider'],
    ['seat killed by SIGKILL', 'process_killed', 'provider'],
    ['run cancelled by user', 'cancelled', 'unknown'],
    ['worker: terminated', 'terminated', 'provider'],
    ['budget pool: ticket 4 spent', 'budget_exceeded', 'agent'],
    ['deadline exceeded after 3600s', 'timeout', 'agent'],
    ['iteration cap exhausted at depth 4', 'traversal_cap_exhausted', 'agent'],
  ]

  it.each(CORPUS)('classifies %j as %s blamed on %s', (reason, failureClass, blame) => {
    const classified = classifyFailureReason(reason)
    expect(classified.failureClass).toBe(failureClass)
    expect(classified.blame).toBe(blame)
    expect(classified.reason).toBe(reason)
  })

  it('covers every transport death the default rules name', () => {
    expect(new Set(CORPUS.map(([, failureClass]) => failureClass))).toEqual(
      new Set(DEFAULT_FAILURE_REASON_RULES.map((rule) => rule.failureClass)),
    )
  })

  it('separates an absent reason from an unrecognised one, and keeps the text', () => {
    expect(classifyFailureReason('')).toEqual({
      failureClass: 'unreported',
      blame: 'unknown',
      reason: '',
    })
    expect(classifyFailureReason(null)).toEqual({
      failureClass: 'unreported',
      blame: 'unknown',
      reason: '',
    })
    expect(classifyFailureReason('the toaster disagreed')).toEqual({
      failureClass: 'unknown',
      blame: 'unknown',
      reason: 'the toaster disagreed',
    })
  })

  it('lets a caller replace the rule set and override a blame', () => {
    const classified = classifyFailureReason('quota shard drained', [
      { failureClass: 'budget_exceeded', pattern: /quota shard drained/i, blame: 'machine' },
    ])
    expect(classified.failureClass).toBe('budget_exceeded')
    expect(classified.blame).toBe('machine')
  })
})

describe('classifyFailure blame axis', () => {
  it('carries a blame on every verdict it returns', async () => {
    const store = new InMemoryTraceStore()
    const e = new TraceEmitter(store)
    await e.startRun({ scenarioId: 's' })
    await e.endRun({ pass: true, score: 1 })
    expect(classifyFailure(await ctxFor(store, e.runId)).blame).toBe('none')

    const failed = new InMemoryTraceStore()
    const f = new TraceEmitter(failed)
    await f.startRun({ scenarioId: 's' })
    await f.recordBudget({
      dimension: 'tokens',
      limit: 10,
      consumed: 11,
      remaining: -1,
      breached: true,
    })
    await f.endRun({ pass: false })
    const classified = classifyFailure(await ctxFor(failed, f.runId))
    expect(classified.failureClass).toBe('budget_exceeded')
    expect(classified.blame).toBe('agent')
  })

  it('reads a transport reason off an error event — regression: a bridge outage with no structural rule landed in unknown and was charged to the agent', async () => {
    const store = new InMemoryTraceStore()
    const e = new TraceEmitter(store)
    await e.startRun({ scenarioId: 's' })
    const event = await e.emit({
      kind: 'error',
      payload: { reason: 'bridge http://127.0.0.1:7433 unreachable: connect ECONNREFUSED' },
    })
    await e.endRun({ pass: false })
    const classified = classifyFailure(await ctxFor(store, e.runId))
    expect(classified.failureClass).toBe('bridge_unreachable')
    expect(classified.blame).toBe('machine')
    expect(classified.triggerEventId).toBe(event.eventId)
  })

  it('keeps a structural rule ahead of the reason fallback', async () => {
    const store = new InMemoryTraceStore()
    const e = new TraceEmitter(store)
    await e.startRun({ scenarioId: 's' })
    await e.recordBudget({
      dimension: 'tokens',
      limit: 10,
      consumed: 11,
      remaining: -1,
      breached: true,
    })
    await e.emit({ kind: 'error', payload: { reason: 'connect ECONNREFUSED' } })
    await e.endRun({ pass: false })
    expect(classifyFailure(await ctxFor(store, e.runId)).failureClass).toBe('budget_exceeded')
  })

  it('still returns unknown when nothing structural and nothing textual matches', async () => {
    const store = new InMemoryTraceStore()
    const e = new TraceEmitter(store)
    await e.startRun({ scenarioId: 's' })
    await e.emit({ kind: 'error', payload: { reason: 'the toaster disagreed' } })
    await e.endRun({ pass: false })
    const classified = classifyFailure(await ctxFor(store, e.runId))
    expect(classified.failureClass).toBe('unknown')
    expect(classified.blame).toBe('unknown')
  })
})

describe('the two questions the blame axis answers', () => {
  it('keeps an operator cancel out of every charge and out of the outage set', () => {
    // A deliberate stop is not the machine, the provider or the agent. Counting
    // it as infrastructure would turn a cancelled batch into an outage streak.
    const classified = classifyFailureReason('run cancelled by user')
    expect(classified.failureClass).toBe('cancelled')
    expect(classified.blame).toBe('unknown')
    expect(INFRA_FAILURE_BLAMES.has(classified.blame)).toBe(false)
  })

  it('separates voiding a run from counting a dead seat', () => {
    // Voidable — the run never reached a model, so it is not evidence.
    expect(failureBlame('bridge_unreachable')).toBe('machine')
    // Charged, because every arm faces the same provider on the same day...
    expect(failureBlame('empty_completion')).toBe('provider')
    // ...and still counted, because a seat returning only empty completions is
    // as dead as one whose bridge refuses.
    expect(INFRA_FAILURE_BLAMES.has('provider')).toBe(true)
    expect(INFRA_FAILURE_BLAMES.has('agent')).toBe(false)
    expect(INFRA_FAILURE_BLAMES.has('unknown')).toBe(false)
  })

  it('leaves the terminal timeout rule to the agent clock, and a named machine deadline to the machine', () => {
    // A machine deadline the rule set names is caught before the generic rule.
    const machineDeadline = classifyFailureReason(
      'host-executor: acquire timeout after 900000ms (in_flight=10/10)',
    )
    expect(machineDeadline.blame).toBe('machine')
    const provisioning = classifyFailureReason('Sandbox create did not complete within 300000ms')
    expect(provisioning.blame).toBe('machine')
    // Anything the transport rules decline is the agent's own clock. A consumer
    // whose machine has other deadline wording adds a rule ahead of this one.
    const agentDeadline = classifyFailureReason('deadline exceeded after 3600s')
    expect(agentDeadline.failureClass).toBe('timeout')
    expect(agentDeadline.blame).toBe('agent')
    expect(DEFAULT_FAILURE_REASON_RULES.at(-2)?.failureClass).toBe('timeout')
  })
})
