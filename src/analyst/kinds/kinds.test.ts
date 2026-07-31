import { describe, expect, it, vi } from 'vitest'
import type { TraceAnalysisEngine } from '../engine'
import { parseRawFinding, RawAnalystFindingSchema } from '../finding-signature'
import { findingSubjectGrammarPromptFor, KIND_EXPECTED_SUBJECTS } from '../finding-subject'
import { createTraceAnalyst, type TraceAnalystDefinition } from '../kind-factory'
import { buildTraceToolsForGroup } from '../tool-groups'
import { computeFindingId, makeFinding } from '../types'
import {
  DEFAULT_TRACE_ANALYST_KINDS,
  FAILURE_MODE_KIND_SPEC,
  IMPROVEMENT_KIND_SPEC,
  INTENT_DIVERGENCE_KIND_SPEC,
  KNOWLEDGE_GAP_KIND_SPEC,
  KNOWLEDGE_POISONING_KIND_SPEC,
} from './index'

describe('RawAnalystFindingSchema', () => {
  it('accepts a complete finding', () => {
    const parsed = RawAnalystFindingSchema.safeParse({
      severity: 'high',
      claim: 'agent looped on tool foo',
      subject: 'tool-doc:foo',
      evidence: [
        {
          uri: 'span://abc/def',
          excerpt: 'foo() called 11 times with same args',
        },
      ],
      confidence: 0.9,
      rationale: 'eleven identical calls without progress',
      recommended_action: 'add per-call dedupe in scaffolding',
    })
    expect(parsed.success).toBe(true)
  })

  it('requires at least one citation', () => {
    const parsed = RawAnalystFindingSchema.safeParse({
      severity: 'high',
      claim: 'x',
      evidence: [],
      confidence: 0.5,
    })
    expect(parsed.success).toBe(false)
  })

  it('rejects whitespace-only citation identifiers', () => {
    const parsed = RawAnalystFindingSchema.safeParse({
      severity: 'high',
      claim: 'x',
      evidence: [{ uri: 'span://a/b' }, { uri: '   ' }],
      confidence: 0.5,
    })
    expect(parsed.success).toBe(false)
  })

  it('rejects out-of-range confidence', () => {
    const parsed = RawAnalystFindingSchema.safeParse({
      severity: 'high',
      claim: 'x',
      evidence: [{ uri: 'span://a/b' }],
      confidence: 1.5,
    })
    expect(parsed.success).toBe(false)
  })

  it('rejects unknown severity', () => {
    const parsed = RawAnalystFindingSchema.safeParse({
      severity: 'catastrophic',
      claim: 'x',
      evidence: [{ uri: 'span://a/b' }],
      confidence: 0.5,
    })
    expect(parsed.success).toBe(false)
  })

  it('rejects unknown extra fields (strict mode)', () => {
    const parsed = RawAnalystFindingSchema.safeParse({
      severity: 'low',
      claim: 'x',
      evidence: [{ uri: 'span://a/b' }],
      confidence: 0.5,
      unexpected: 'field',
    })
    expect(parsed.success).toBe(false)
  })
})

describe('parseRawFinding logs the rejection reason on schema failure', () => {
  it('returns null + logs when invalid', () => {
    const log = vi.fn()
    const out = parseRawFinding({ severity: 'high' }, log)
    expect(out).toBeNull()
    expect(log).toHaveBeenCalledWith(
      'finding rejected: schema failure',
      expect.objectContaining({ issues: expect.any(Array) }),
    )
  })

  it('returns the typed value on success without logging', () => {
    const log = vi.fn()
    const out = parseRawFinding(
      {
        severity: 'low',
        claim: 'test',
        evidence: [{ uri: 'span://t/s' }],
        confidence: 0.4,
      },
      log,
    )
    expect(out?.claim).toBe('test')
    expect(out).toHaveProperty('evidence', [{ uri: 'span://t/s' }])
    expect(log).not.toHaveBeenCalled()
  })
})

describe('default kind suite shape', () => {
  it('exposes the five failure/improvement kinds in run order', () => {
    expect(DEFAULT_TRACE_ANALYST_KINDS.map((k) => k.id)).toEqual([
      'failure-mode',
      'intent-divergence',
      'knowledge-gap',
      'knowledge-poisoning',
      'improvement',
    ])
  })

  it('improvement runs after intent-divergence so edits can act on priced divergences', () => {
    const ids = DEFAULT_TRACE_ANALYST_KINDS.map((k) => k.id)
    expect(ids.indexOf('intent-divergence')).toBeLessThan(ids.indexOf('improvement'))
  })

  it('every default kind declares a non-empty lens prompt without duplicating the output contract', () => {
    for (const spec of DEFAULT_TRACE_ANALYST_KINDS) {
      expect(spec.instructions.length).toBeGreaterThan(500)
      expect(spec.instructions).not.toMatch(/`area`\s*=/)
      expect(spec.instructions).not.toContain('`evidence_uri`')
      expect(spec.instructions).not.toContain('`evidence_excerpt`')
      expect(spec.instructions).not.toMatch(/final\(\{\s*findings/)
    }
  })

  it('every default kind has a stable area + version', () => {
    for (const spec of DEFAULT_TRACE_ANALYST_KINDS) {
      expect(spec.id).toBe(spec.area)
      expect(spec.version).toMatch(/^\d+\.\d+\.\d+/)
    }
  })

  it('every default analyst has explicit recursive and trace-read limits', () => {
    for (const spec of DEFAULT_TRACE_ANALYST_KINDS) {
      expect(spec.limits?.maxLlmCalls ?? 0).toBeGreaterThanOrEqual(1)
      expect(spec.limits?.maxIterations ?? 0).toBeGreaterThanOrEqual(1)
      expect(spec.limits?.maxToolCalls ?? 0).toBeGreaterThanOrEqual(1)
    }
  })

  it('improvement kind has a maximum subquery budget for competing fixes', () => {
    const max = Math.max(
      ...DEFAULT_TRACE_ANALYST_KINDS.map((kind) => kind.limits?.maxLlmCalls ?? 0),
    )
    expect(IMPROVEMENT_KIND_SPEC.limits?.maxLlmCalls).toBe(max)
  })

  it("knowledge-gap prompt anchors on agent-knowledge wiki + websearch + tool-doc layers, not generic 'RAG'", () => {
    const p = KNOWLEDGE_GAP_KIND_SPEC.instructions
    expect(p).toMatch(/agent-knowledge/)
    expect(p).toMatch(/wiki/i)
    expect(p).toMatch(/websearch/i)
    expect(p).toMatch(/tool-doc/i)
  })

  it('knowledge-poisoning prompt enforces dual-verify (acted on + actually false)', () => {
    expect(KNOWLEDGE_POISONING_KIND_SPEC.instructions).toMatch(/DUAL-VERIFY/)
    expect(KNOWLEDGE_POISONING_KIND_SPEC.minimumEvidenceCitations).toBe(2)
  })

  it('failure-mode prompt requires clustering, not enumeration', () => {
    expect(FAILURE_MODE_KIND_SPEC.instructions).toMatch(/Cluster, do not enumerate/i)
  })
})

describe('intent-divergence kind', () => {
  const prompt = INTENT_DIVERGENCE_KIND_SPEC.instructions

  it('runs the backward protocol, not a count of corrective turns', () => {
    expect(prompt).toMatch(/DISCOVERY → BACKTRACK → QUANTIFY → CITE/)
    expect(prompt).toMatch(/earliest[- ]detectable/i)
    expect(prompt).toMatch(/burn(ing|ed) K? ?turns/i)
    // The cost estimate is the deliverable: no anchor turn means no finding.
    expect(prompt).toMatch(/you have a correction and not a divergence: drop it/)
  })

  it('supplies searchable corrective-language hints for both correction and clarification', () => {
    for (const hint of ['stop', "don'?t", 'not what I', 'already told you', 'why are you']) {
      expect(prompt).toContain(hint)
    }
    for (const hint of ['I mean(t)?', 'to be clear', 'actually,? I (want|need)']) {
      expect(prompt).toContain(hint)
    }
  })

  it('routes the ambiguous-request case to a clarifying-question policy, not to the agent', () => {
    expect(prompt).toMatch(/scaffolding:\*/)
    expect(prompt).toMatch(/clarifying-question policy/)
    expect(KIND_EXPECTED_SUBJECTS['intent-divergence']).toContain('scaffolding')
  })

  it('emits loci, never failure-mode cluster labels', () => {
    const allowed = KIND_EXPECTED_SUBJECTS['intent-divergence'] ?? []
    expect(allowed.length).toBeGreaterThan(0)
    expect(allowed).not.toContain('cluster')
    expect(INTENT_DIVERGENCE_KIND_SPEC.instructions).toContain(
      findingSubjectGrammarPromptFor('intent-divergence'),
    )
  })

  it('requires both ends of the divergence to be cited', () => {
    expect(INTENT_DIVERGENCE_KIND_SPEC.minimumEvidenceCitations).toBe(2)
  })

  it('gets ordered-read tools — search alone cannot walk backward from the correction', () => {
    expect(INTENT_DIVERGENCE_KIND_SPEC.toolGroup).toBe('all')
    const names = buildTraceToolsForGroup(INTENT_DIVERGENCE_KIND_SPEC.toolGroup, stubStore()).map(
      (t) => (t as { name: string }).name,
    )
    expect(names).toContain('searchTrace')
    expect(names).toContain('viewTrace')
    expect(names).toContain('viewSpans')
  })

  it('does not outrank improvement on subquery budget', () => {
    expect(INTENT_DIVERGENCE_KIND_SPEC.limits?.maxLlmCalls ?? 0).toBeLessThanOrEqual(
      IMPROVEMENT_KIND_SPEC.limits?.maxLlmCalls ?? 0,
    )
  })
})

describe('tool-groups filter the analyst tool surface narrowly', () => {
  it('discovery group exposes only overview/query/count', () => {
    const tools = buildTraceToolsForGroup('discovery', stubStore())
    expect(tools.map((t) => (t as { name: string }).name).sort()).toEqual([
      'countTraces',
      'getDatasetOverview',
      'queryTraces',
    ])
  })

  it("'all' group is the full set", () => {
    expect(buildTraceToolsForGroup('all', stubStore()).length).toBe(7)
  })

  it("'targeted' group drops viewTrace + searchTrace (kept for surgical follow-ups only)", () => {
    const names = buildTraceToolsForGroup('targeted', stubStore()).map(
      (t) => (t as { name: string }).name,
    )
    expect(names).toContain('viewSpans')
    expect(names).toContain('searchSpan')
    expect(names).not.toContain('viewTrace')
    expect(names).not.toContain('searchTrace')
  })

  it('unknown group name throws (silent-all would defeat cost control)', () => {
    expect(() => buildTraceToolsForGroup('weird' as never, stubStore())).toThrow(
      /unknown trace tool group/,
    )
  })
})

describe('createTraceAnalyst wires a definition into the Analyst contract', () => {
  const identityDefinition: TraceAnalystDefinition = {
    id: 'identity-kind',
    description: 'identity',
    area: 'identity',
    version: '1',
    instructions: 'inspect identity',
    toolGroup: 'all',
  }

  it('binds versioned engine identity into exact execution configuration', () => {
    const first = createTraceAnalyst(identityDefinition, { engine: stubEngine() })
    const second = createTraceAnalyst(identityDefinition, {
      engine: stubEngine({ version: '2.0.0' }),
    })

    expect(first.executionConfig.engine_identity).not.toEqual(
      second.executionConfig.engine_identity,
    )
  })

  it('separates engines that differ only by endpoint', () => {
    const first = createTraceAnalyst(identityDefinition, { engine: stubEngine() })
    const second = createTraceAnalyst(identityDefinition, {
      engine: stubEngine({ executionConfig: { base_url: 'https://two.test' } }),
    })

    expect(first.executionConfig.engine_identity).not.toEqual(
      second.executionConfig.engine_identity,
    )
  })

  it('separates definitions that differ only by instructions', () => {
    const first = createTraceAnalyst(identityDefinition, { engine: stubEngine() })
    const second = createTraceAnalyst(
      { ...identityDefinition, instructions: 'inspect identity differently' },
      { engine: stubEngine() },
    )

    expect(first.executionConfig.instructions_digest).not.toEqual(
      second.executionConfig.instructions_digest,
    )
  })

  it('returns a registry-ready Analyst that delegates to the kind id + version', () => {
    const spec: TraceAnalystDefinition = {
      id: 'test-kind',
      description: 'test',
      area: 'test',
      version: '0.0.1',
      instructions: 'mock prompt',
      toolGroup: 'all',
    }
    const analyst = createTraceAnalyst(spec, { engine: stubEngine() })
    expect(analyst.id).toBe('test-kind')
    expect(analyst.version).toBe('0.0.1')
    expect(analyst.inputKind).toBe('trace-store')
    expect(analyst.cost.kind).toBe('llm')
    expect(analyst.executionConfig).toMatchObject({
      kind: 'trace-analyst',
      model: 'test-model',
      engine: 'test-engine',
      tool_group: 'all',
      max_iterations: 12,
      max_llm_calls: 8,
      max_tool_calls: 48,
      max_output_chars: 10_000,
      evidence_verification: 'resolvable-excerpt-v1',
    })
  })

  it('versionSuffix appends to the kind version (used by optimizer pipelines)', () => {
    const spec: TraceAnalystDefinition = {
      id: 'k',
      description: 'test',
      area: 'k',
      version: '1.0.0',
      instructions: 'test',
      toolGroup: 'all',
    }
    const analyst = createTraceAnalyst(spec, {
      engine: stubEngine(),
      versionSuffix: 'mipro-2026-05-18',
    })
    expect(analyst.version).toBe('1.0.0+mipro-2026-05-18')
  })

  describe('renderPriorFindings (cross-run retrieval context)', () => {
    it('returns empty string when there are no prior findings', async () => {
      const { renderPriorFindings } = await import('../kind-factory')
      expect(renderPriorFindings(undefined)).toBe('')
      expect(renderPriorFindings([])).toBe('')
    })

    it('emits one compact line per prior finding with the stable finding_id', async () => {
      const { renderPriorFindings } = await import('../kind-factory')
      const prior = [
        makeFinding({
          analyst_id: 'failure-mode',
          area: 'failure-mode',
          subject: 'tool-doc:foo',
          claim: 'tool foo loops on identical args',
          severity: 'high',
          confidence: 0.9,
          evidence_refs: [],
        }),
        makeFinding({
          analyst_id: 'failure-mode',
          area: 'failure-mode',
          subject: 'auth',
          claim: 'auth revoked mid-run',
          severity: 'critical',
          confidence: 0.95,
          evidence_refs: [],
        }),
      ]
      const out = renderPriorFindings(prior)
      expect(out).toMatch(/PRIOR FINDINGS/)
      expect(out).toMatch(/Reuse a matching finding id/)
      const first = prior[0]
      const second = prior[1]
      if (!first || !second) throw new Error('test setup invariant')
      expect(out).toContain(`id=${first.finding_id}`)
      expect(out).toContain(`id=${second.finding_id}`)
      expect(out).toContain('[tool-doc:foo]')
      expect(out).toContain('[auth]')
    })

    it('truncates over 40 prior findings + reports the overflow count', async () => {
      const { renderPriorFindings } = await import('../kind-factory')
      const many = Array.from({ length: 60 }, (_, i) =>
        makeFinding({
          analyst_id: 'failure-mode',
          area: 'failure-mode',
          subject: `mode-${i}`,
          claim: `finding ${i}`,
          severity: 'medium',
          confidence: 0.7,
          evidence_refs: [],
        }),
      )
      const out = renderPriorFindings(many)
      expect(out).toContain('20 older findings omitted')
    })
  })

  it('finding_id is stable across runs for the same kind + area + claim + subject', () => {
    const a = computeFindingId({
      analyst_id: 'failure-mode',
      area: 'failure-mode',
      subject: 'tool-doc:foo',
      claim: 'tool foo loops on identical args',
    })
    const b = computeFindingId({
      analyst_id: 'failure-mode',
      area: 'failure-mode',
      subject: 'tool-doc:foo',
      claim: 'tool foo loops on identical args.',
    })
    expect(a).toBe(b)
  })
})

function stubStore() {
  return {} as never
}

function stubEngine(overrides: Partial<TraceAnalysisEngine> = {}): TraceAnalysisEngine {
  return {
    id: 'test-engine',
    description: 'test',
    model: 'test-model',
    version: '1.0.0',
    executionConfig: { base_url: 'https://one.test' },
    analyze: async () => {
      throw new Error('not called')
    },
    ...overrides,
  }
}
