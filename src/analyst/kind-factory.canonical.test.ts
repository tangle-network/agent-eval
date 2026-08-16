import { describe, expect, it } from 'vitest'
import { snapshotAnalystRun } from '../feedback-trajectory-review'
import type { TraceAnalysisStore } from '../trace-analyst/store'
import type { TraceAnalysisEngine } from './engine'
import { createTraceAnalyst, type TraceAnalystDefinition } from './kind-factory'
import { AnalystRegistry, type ExactRegistryRunOpts } from './registry'

const exactOptions = (): ExactRegistryRunOpts => ({
  analystIds: ['canonical-omissions'],
  budget: null,
  totalTimeoutMs: null,
  signal: null,
  costLedger: null,
  costLedgerIdentity: null,
  costPhase: null,
  tags: null,
  priorFindings: null,
  chainFindings: false,
  missingInputMode: 'abort',
  applyRegistryHooks: false,
  useRegistryChat: false,
})

const definition: TraceAnalystDefinition = {
  id: 'canonical-omissions',
  description: 'Verify omitted optional finding fields stay omitted.',
  area: 'data-quality',
  version: '1.0.0',
  instructions: 'Return only evidence-backed findings.',
  toolGroup: 'discovery',
}

const engine: TraceAnalysisEngine = {
  id: 'canonical-test-engine',
  description: 'deterministic fixture',
  model: 'fixture-model',
  version: '1.0.0',
  executionConfig: { kind: 'fixture' },
  async analyze() {
    return {
      answer: 'A cited issue was found.',
      findings: [
        {
          severity: 'medium',
          claim: 'The selected span contains a reproducible issue.',
          confidence: 0.9,
          evidence: [{ uri: 'trace://trace-1/span/span-1' }],
        },
      ],
      trajectory: [],
      modelCalls: 0,
      toolCalls: 0,
      runtime: { kind: 'fixture' },
    }
  },
}

const store = {
  async hasSpans() {
    return ['span-1']
  },
} as unknown as TraceAnalysisStore

describe('createTraceAnalyst exact canonical output', () => {
  it('runs through the exact registry when every optional field is omitted', async () => {
    const registry = new AnalystRegistry()
    registry.register(createTraceAnalyst(definition, { engine }))

    const result = await registry.runExact(
      'canonical-output',
      { traceStore: store },
      exactOptions(),
    )

    expect(result.completion.status).toBe('complete')
    expect(result.findings).toHaveLength(1)
    const finding = result.findings[0]!
    expect(Object.hasOwn(finding, 'subject')).toBe(false)
    expect(Object.hasOwn(finding, 'rationale')).toBe(false)
    expect(Object.hasOwn(finding, 'recommended_action')).toBe(false)
    expect(Object.hasOwn(finding.evidence_refs[0]!, 'excerpt')).toBe(false)
    expect(() => snapshotAnalystRun(result)).not.toThrow()
  })
})
