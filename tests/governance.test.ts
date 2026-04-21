import { describe, expect, it } from 'vitest'
import { InMemoryTraceStore, TraceEmitter } from '../src/trace'
import { InMemoryOutcomeStore } from '../src/meta-eval'
import { Dataset } from '../src/dataset'
import { redTeamReport } from '../src/red-team'
import {
  classifyEuAiRisk,
  euAiActReport,
  nistAiRmfReport,
  renderMarkdown,
  soc2Report,
  type GovernanceContext,
} from '../src/governance'

async function makeContext(
  partial: Partial<GovernanceContext> = {},
): Promise<GovernanceContext> {
  const traceStore = partial.traceStore ?? new InMemoryTraceStore()
  const dataset = new Dataset({
    name: 'default',
    provenance: { version: '1.0.0', createdAt: '2026-04-20T00:00:00Z' },
    scenarios: [{ id: 's1', payload: {}, difficulty: 'easy' }],
  })
  const manifest = await dataset.manifest()
  return {
    organization: 'Tangle Technologies',
    systemName: 'agent-builder',
    periodStart: '2026-04-01T00:00:00Z',
    periodEnd: '2026-04-30T23:59:59Z',
    datasets: [manifest],
    traceStore,
    owner: { role: 'founder', name: 'Drew Stone', email: 'drew@webb.tools' },
    ...partial,
  }
}

describe('NIST AI RMF', () => {
  it('flags missing red-team + missing outcomes + missing calibration', async () => {
    const ctx = await makeContext()
    const report = await nistAiRmfReport(ctx)
    const controls = report.findings.map((f) => f.control)
    expect(controls).toContain('NIST-AI-RMF:MEASURE-2.6')
    expect(controls).toContain('NIST-AI-RMF:MEASURE-2.11')
    expect(controls).toContain('NIST-AI-RMF:MANAGE-1.1')
    expect(report.summary.overall).not.toBe('compliant')
  })

  it('compliant when red-team, calibration, outcomes all present — regression: we must reward full-stack posture', async () => {
    const trace = new InMemoryTraceStore()
    const outcome = new InMemoryOutcomeStore()
    // Add one passing run during the period
    const e = new TraceEmitter(trace, { now: () => Date.parse('2026-04-15T00:00:00Z') })
    await e.startRun({ scenarioId: 's1' })
    await e.endRun({ pass: true, score: 0.9 })
    await outcome.append({
      runId: e.runId,
      capturedAt: Date.parse('2026-04-16T00:00:00Z'),
      metrics: { retention_7d: 0.8 },
    })
    const rt = redTeamReport([
      { scenarioId: 'rt1', category: 'prompt_injection_direct', passed: true, reason: '' },
      { scenarioId: 'rt2', category: 'pii_leak', passed: true, reason: '' },
    ])
    const ctx = await makeContext({
      traceStore: trace,
      outcomeStore: outcome,
      redTeam: rt,
      judgeCalibration: [{ n: 50, pearson: 0.85, kappa: 0.7, mae: 0.3, worstItems: [] }],
    })
    const report = await nistAiRmfReport(ctx)
    expect(report.summary.overall).toBe('compliant')
  })
})

describe('SOC2', () => {
  it('flags high failure rate and absent codeSha', async () => {
    const trace = new InMemoryTraceStore()
    for (let i = 0; i < 10; i++) {
      const e = new TraceEmitter(trace, { now: () => Date.parse('2026-04-15T00:00:00Z') + i })
      await e.startRun({ scenarioId: 's' })
      await e.endRun({ pass: i > 6 }) // 30% pass → 70% fail
    }
    const ctx = await makeContext({ traceStore: trace })
    const report = await soc2Report(ctx)
    const controls = report.findings.map((f) => f.control)
    expect(controls).toContain('SOC2:CC7.1')
    expect(controls).toContain('SOC2:CC7.4')
  })
})

describe('EU AI Act', () => {
  it('classifies biometric public as unacceptable', () => {
    expect(classifyEuAiRisk({ biometricPublic: true })).toBe('unacceptable')
  })

  it('classifies Annex III as high', () => {
    expect(classifyEuAiRisk({ annexIII: true })).toBe('high')
  })

  it('classifies chatbot as limited', () => {
    expect(classifyEuAiRisk({ chatbot: true })).toBe('limited')
  })

  it('defaults to minimal', () => {
    expect(classifyEuAiRisk({})).toBe('minimal')
  })

  it('high-risk report flags Article 9/10/11/14/15 gaps when evidence absent — regression: silent gaps in high-risk deployments are unshippable in the EU', async () => {
    const ctx = await makeContext({ datasets: [] })
    const report = await euAiActReport(ctx, { annexIII: true })
    const controls = report.findings.map((f) => f.control)
    expect(controls).toContain('EU-AI-ACT:Article-9')
    expect(controls).toContain('EU-AI-ACT:Article-10')
    expect(controls).toContain('EU-AI-ACT:Article-11')
  })

  it('unacceptable risk produces critical Article-5 finding', async () => {
    const ctx = await makeContext()
    const report = await euAiActReport(ctx, { socialScoring: true })
    expect(report.findings.some((f) => f.control === 'EU-AI-ACT:Article-5' && f.severity === 'critical')).toBe(true)
    expect(report.summary.overall).toBe('non-compliant')
  })
})

describe('renderMarkdown', () => {
  it('produces a human-readable header + summary + findings list', async () => {
    const ctx = await makeContext()
    const report = await nistAiRmfReport(ctx)
    const md = renderMarkdown(report)
    expect(md).toMatch(/# NIST-AI-RMF report/)
    expect(md).toMatch(/Tangle Technologies/)
    expect(md).toMatch(/## Summary/)
  })
})
