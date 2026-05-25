import { describe, expect, it } from 'vitest'
import { classifyFailure } from '../src/failure-taxonomy'
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
