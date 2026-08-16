import { describe, expect, it } from 'vitest'
import { snapshotAnalystRun } from '../feedback-trajectory-review'
import type { TraceAnalysisStore } from '../trace-analyst/store'
import type { TraceAnalysisEngine } from './engine'
import { createTraceAnalyst, type TraceAnalystDefinition } from './kind-factory'
import { AnalystRegistry, type ExactRegistryRunOpts } from './registry'

const exactOptions = (analystId = 'canonical-omissions'): ExactRegistryRunOpts => ({
  analystIds: [analystId],
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

const modelLessEngine: TraceAnalysisEngine = {
  id: 'canonical-model-less-engine',
  description: 'deterministic model-less fixture',
  version: '1.0.0',
  executionConfig: { kind: 'fixture-model-less' },
  async analyze() {
    return engine.analyze({} as never)
  },
}

const presentFieldsDefinition: TraceAnalystDefinition = {
  ...definition,
  id: 'canonical-present-fields',
  description: 'Verify present optional finding fields remain canonical.',
}

const presentFieldsEngine: TraceAnalysisEngine = {
  ...engine,
  id: 'canonical-present-fields-engine',
  async analyze() {
    return {
      answer: 'A fully described cited issue was found.',
      findings: [
        {
          severity: 'high',
          claim: 'The selected span contains a fully described reproducible issue.',
          confidence: 0.95,
          subject: 'leaf:fixture-1',
          rationale: 'The exact provider response proves the failure mode.',
          recommended_action: 'Repair the provider boundary and replay this exact run.',
          evidence: [
            {
              uri: 'trace://trace-1/span/span-1',
              excerpt: 'tool returned permission denied',
            },
          ],
        },
      ],
      trajectory: [],
      modelCalls: 1,
      toolCalls: 1,
      runtime: { kind: 'fixture' },
    }
  },
}

const store = {
  async hasSpans() {
    return ['span-1']
  },
  async viewSpans() {
    return {
      spans: [
        {
          span_id: 'span-1',
          attributes: { result: 'tool returned permission denied' },
          status_message: null,
        },
      ],
    }
  },
} as unknown as TraceAnalysisStore

describe('createTraceAnalyst exact canonical output', () => {
  it('runs through the exact registry when every optional finding field is omitted', async () => {
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

  it('omits analysis_model instead of persisting undefined for a model-less engine', async () => {
    const registry = new AnalystRegistry()
    registry.register(createTraceAnalyst(definition, { engine: modelLessEngine }))

    const result = await registry.runExact(
      'canonical-model-less-output',
      { traceStore: store },
      exactOptions(),
    )

    expect(result.completion.status).toBe('complete')
    const finding = result.findings[0]!
    expect(finding.metadata).toMatchObject({
      analysis_engine: 'canonical-model-less-engine',
      analysis_model_calls: 0,
      analysis_tool_calls: 0,
    })
    expect(Object.hasOwn(finding.metadata!, 'analysis_model')).toBe(false)
    expect(() => snapshotAnalystRun(result)).not.toThrow()
  })

  it('preserves every explicitly present optional field in the canonical snapshot', async () => {
    const registry = new AnalystRegistry()
    registry.register(createTraceAnalyst(presentFieldsDefinition, { engine: presentFieldsEngine }))

    const result = await registry.runExact(
      'canonical-present-output',
      { traceStore: store },
      exactOptions(presentFieldsDefinition.id),
    )

    expect(result.completion.status).toBe('complete')
    expect(result.findings[0]).toMatchObject({
      subject: 'leaf:fixture-1',
      rationale: 'The exact provider response proves the failure mode.',
      recommended_action: 'Repair the provider boundary and replay this exact run.',
      evidence_refs: [
        {
          kind: 'span',
          uri: 'trace://trace-1/span/span-1',
          excerpt: 'tool returned permission denied',
        },
      ],
      metadata: {
        analysis_model: 'fixture-model',
        analysis_model_calls: 1,
        analysis_tool_calls: 1,
      },
    })
    expect(() => snapshotAnalystRun(result)).not.toThrow()
  })
})
