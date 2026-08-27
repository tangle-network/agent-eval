import { describe, expect, it, vi } from 'vitest'
import {
  CanonicalRawAnalystFindingSchema,
  parseCanonicalRawFinding,
  parseRawFinding,
  RawAnalystFindingSchema,
} from '../finding-signature'
import { createTraceAnalystKind, type TraceAnalystKindSpec } from '../kind-factory'
import { buildTraceToolsForGroup } from '../tool-groups'
import { computeFindingId, makeFinding } from '../types'
import {
  DEFAULT_TRACE_ANALYST_KINDS,
  FAILURE_MODE_KIND_SPEC,
  IMPROVEMENT_KIND_SPEC,
  KNOWLEDGE_GAP_KIND_SPEC,
  KNOWLEDGE_POISONING_KIND_SPEC,
} from './index'

describe('CanonicalRawAnalystFindingSchema', () => {
  it('accepts a complete finding', () => {
    const parsed = CanonicalRawAnalystFindingSchema.safeParse({
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

  it('normalizes legacy single-citation rows into the plural contract', () => {
    const parsed = CanonicalRawAnalystFindingSchema.safeParse({
      severity: 'medium',
      claim: 'legacy finding',
      evidence_uri: 'span://legacy/action',
      evidence_excerpt: 'legacy excerpt',
      confidence: 0.7,
    })
    expect(parsed.success).toBe(true)
    if (!parsed.success) throw new Error('test setup invariant')
    expect(parsed.data.evidence).toEqual([
      { uri: 'span://legacy/action', excerpt: 'legacy excerpt' },
    ])
    expect(parsed.data).not.toHaveProperty('evidence_uri')
  })

  it('preserves both citations when a provider mixes plural and singular fields', () => {
    const parsed = CanonicalRawAnalystFindingSchema.parse({
      severity: 'medium',
      claim: 'mixed finding',
      evidence: [{ uri: 'span://canonical/action' }],
      evidence_uri: 'event://legacy/result',
      evidence_excerpt: 'legacy corroboration',
      confidence: 0.7,
    })

    expect(parsed.evidence).toEqual([
      { uri: 'span://canonical/action' },
      { uri: 'event://legacy/result', excerpt: 'legacy corroboration' },
    ])
  })

  it('keeps a legacy excerpt when mixed fields cite the same source', () => {
    const parsed = CanonicalRawAnalystFindingSchema.parse({
      severity: 'medium',
      claim: 'mixed finding',
      evidence: [{ uri: 'span://canonical/action' }],
      evidence_uri: 'span://canonical/action',
      evidence_excerpt: 'exact corroboration',
      confidence: 0.7,
    })

    expect(parsed.evidence).toEqual([
      { uri: 'span://canonical/action', excerpt: 'exact corroboration' },
    ])
  })

  it('requires at least one citation', () => {
    const parsed = CanonicalRawAnalystFindingSchema.safeParse({
      severity: 'high',
      claim: 'x',
      evidence: [],
      confidence: 0.5,
    })
    expect(parsed.success).toBe(false)
  })

  it('rejects whitespace-only citation identifiers', () => {
    const parsed = CanonicalRawAnalystFindingSchema.safeParse({
      severity: 'high',
      claim: 'x',
      evidence: [{ uri: 'span://a/b' }, { uri: '   ' }],
      confidence: 0.5,
    })
    expect(parsed.success).toBe(false)
  })

  it('rejects out-of-range confidence', () => {
    const parsed = CanonicalRawAnalystFindingSchema.safeParse({
      severity: 'high',
      claim: 'x',
      evidence: [{ uri: 'span://a/b' }],
      confidence: 1.5,
    })
    expect(parsed.success).toBe(false)
  })

  it('rejects unknown severity', () => {
    const parsed = CanonicalRawAnalystFindingSchema.safeParse({
      severity: 'catastrophic',
      claim: 'x',
      evidence: [{ uri: 'span://a/b' }],
      confidence: 0.5,
    })
    expect(parsed.success).toBe(false)
  })

  it('rejects unknown extra fields (strict mode)', () => {
    const parsed = CanonicalRawAnalystFindingSchema.safeParse({
      severity: 'low',
      claim: 'x',
      evidence: [{ uri: 'span://a/b' }],
      confidence: 0.5,
      unexpected: 'field',
    })
    expect(parsed.success).toBe(false)
  })
})

describe('RawAnalystFindingSchema compatibility', () => {
  it('retains the original singular evidence result', () => {
    const parsed = RawAnalystFindingSchema.parse({
      severity: 'medium',
      claim: 'legacy finding',
      evidence_uri: 'span://legacy/action',
      evidence_excerpt: 'legacy excerpt',
      confidence: 0.7,
    })

    expect(parsed).toEqual({
      severity: 'medium',
      claim: 'legacy finding',
      evidence_uri: 'span://legacy/action',
      evidence_excerpt: 'legacy excerpt',
      confidence: 0.7,
    })
    expect(parsed).not.toHaveProperty('evidence')
  })

  it('rejects blank identifiers without rewriting accepted legacy values', () => {
    const parsed = RawAnalystFindingSchema.parse({
      severity: 'medium',
      claim: 'legacy finding',
      evidence_uri: '  span://legacy/action  ',
      confidence: 0.7,
    })

    expect(parsed.evidence_uri).toBe('  span://legacy/action  ')
    expect(
      RawAnalystFindingSchema.safeParse({
        severity: 'medium',
        claim: 'legacy finding',
        evidence_uri: '   ',
        confidence: 0.7,
      }).success,
    ).toBe(false)
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
        evidence_uri: 'span://t/s',
        confidence: 0.4,
      },
      log,
    )
    expect(out?.claim).toBe('test')
    expect(out).toHaveProperty('evidence_uri', 'span://t/s')
    expect(out).not.toHaveProperty('evidence')
    expect(log).not.toHaveBeenCalled()
  })

  it('keeps canonical parsing explicit and separate', () => {
    expect(
      parseCanonicalRawFinding({
        severity: 'low',
        claim: 'canonical',
        evidence: [{ uri: 'span://t/s' }],
        confidence: 0.4,
      }),
    ).toMatchObject({ evidence: [{ uri: 'span://t/s' }] })
  })
})

describe('default kind suite shape', () => {
  it('exposes the four failure/improvement kinds in run order', () => {
    expect(DEFAULT_TRACE_ANALYST_KINDS.map((k) => k.id)).toEqual([
      'failure-mode',
      'knowledge-gap',
      'knowledge-poisoning',
      'improvement',
    ])
  })

  it('every default kind declares a non-empty lens prompt without duplicating the output contract', () => {
    for (const spec of DEFAULT_TRACE_ANALYST_KINDS) {
      expect(spec.actorDescription.length).toBeGreaterThan(500)
      expect(spec.actorDescription).not.toMatch(/`area`\s*=/)
      expect(spec.actorDescription).not.toContain('`evidence_uri`')
      expect(spec.actorDescription).not.toContain('`evidence_excerpt`')
      expect(spec.actorDescription).not.toMatch(/final\(\{\s*findings/)
    }
  })

  it('every default kind has a stable area + version', () => {
    for (const spec of DEFAULT_TRACE_ANALYST_KINDS) {
      expect(spec.id).toBe(spec.area)
      expect(spec.version).toMatch(/^\d+\.\d+\.\d+/)
    }
  })

  it('every default kind has an explicit bounded subquery budget', () => {
    for (const spec of DEFAULT_TRACE_ANALYST_KINDS) {
      expect(spec.subqueries?.maxCalls ?? 0).toBeGreaterThanOrEqual(1)
      expect(spec.subqueries?.maxParallel ?? 0).toBeGreaterThanOrEqual(2)
    }
  })

  it('improvement kind has a maximum subquery budget for competing fixes', () => {
    const max = Math.max(...DEFAULT_TRACE_ANALYST_KINDS.map((k) => k.subqueries?.maxCalls ?? 0))
    expect(IMPROVEMENT_KIND_SPEC.subqueries?.maxCalls).toBe(max)
  })

  it("knowledge-gap prompt anchors on agent-knowledge wiki + websearch + tool-doc layers, not generic 'RAG'", () => {
    const p = KNOWLEDGE_GAP_KIND_SPEC.actorDescription
    expect(p).toMatch(/agent-knowledge/)
    expect(p).toMatch(/wiki/i)
    expect(p).toMatch(/websearch/i)
    expect(p).toMatch(/tool-doc/i)
  })

  it('knowledge-poisoning prompt enforces dual-verify (acted on + actually false)', () => {
    expect(KNOWLEDGE_POISONING_KIND_SPEC.actorDescription).toMatch(/DUAL-VERIFY/)
    expect(KNOWLEDGE_POISONING_KIND_SPEC.minimumEvidenceCitations).toBe(2)
  })

  it('failure-mode prompt requires clustering, not enumeration', () => {
    expect(FAILURE_MODE_KIND_SPEC.actorDescription).toMatch(/Cluster, do not enumerate/i)
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

describe('createTraceAnalystKind wires the spec into the Analyst contract', () => {
  it('returns a registry-ready Analyst that delegates to the kind id + version', () => {
    const spec: TraceAnalystKindSpec = {
      id: 'test-kind',
      description: 'test',
      area: 'test',
      version: '0.0.1',
      actorDescription: 'mock prompt',
      buildTools: () => [],
      cost: { kind: 'llm' },
    }
    const analyst = createTraceAnalystKind(spec, { ai: stubAi(), model: 'test-model' })
    expect(analyst.id).toBe('test-kind')
    expect(analyst.version).toBe('0.0.1')
    expect(analyst.inputKind).toBe('trace-store')
    expect(analyst.cost.kind).toBe('llm')
  })

  it('versionSuffix appends to the kind version (used by optimizer pipelines)', () => {
    const spec: TraceAnalystKindSpec = {
      id: 'k',
      description: '',
      area: 'k',
      version: '1.0.0',
      actorDescription: '',
      buildTools: () => [],
      cost: { kind: 'llm' },
    }
    const analyst = createTraceAnalystKind(spec, {
      ai: stubAi(),
      model: 'test-model',
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
      expect(out).toMatch(/REUSE the `finding_id`/)
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
      expect(out).toContain('+20 more prior findings')
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

function stubAi() {
  return {} as never
}
