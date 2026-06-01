import { describe, expect, it } from 'vitest'
import {
  FINDING_SUBJECT_KINDS,
  type FindingSubject,
  KIND_EXPECTED_SUBJECTS,
  parseFindingSubject,
  renderFindingSubject,
} from './finding-subject'

describe('parseFindingSubject — knowledge loci', () => {
  it('parses agent-knowledge:wiki:<slug>', () => {
    expect(parseFindingSubject('agent-knowledge:wiki:invoice-shape')).toEqual({
      kind: 'knowledge.wiki',
      slug: 'invoice-shape',
    })
  })

  it('parses agent-knowledge:wiki:<slug>#<heading>', () => {
    expect(parseFindingSubject('agent-knowledge:wiki:invoice-shape#line-items')).toEqual({
      kind: 'knowledge.wiki',
      slug: 'invoice-shape',
      heading: 'line-items',
    })
  })

  it('parses agent-knowledge:claim:<topic>', () => {
    expect(parseFindingSubject('agent-knowledge:claim:cap-table-shape')).toEqual({
      kind: 'knowledge.claim',
      topic: 'cap-table-shape',
    })
  })

  it('parses agent-knowledge:raw:<source-id>', () => {
    expect(parseFindingSubject('agent-knowledge:raw:irs-pub-501-2024')).toEqual({
      kind: 'knowledge.raw',
      sourceId: 'irs-pub-501-2024',
    })
  })

  it('parses agent-knowledge:stale:<slug>', () => {
    expect(parseFindingSubject('agent-knowledge:stale:old-vat-rates')).toEqual({
      kind: 'knowledge.stale',
      slug: 'old-vat-rates',
    })
  })

  it('rejects malformed wiki slug (uppercase / underscore)', () => {
    expect(parseFindingSubject('agent-knowledge:wiki:InvoiceShape')).toBeNull()
    expect(parseFindingSubject('agent-knowledge:wiki:invoice_shape')).toBeNull()
  })

  it('rejects malformed wiki anchor heading', () => {
    expect(parseFindingSubject('agent-knowledge:wiki:slug#Heading_With_Caps')).toBeNull()
  })
})

describe('parseFindingSubject — runtime surfaces', () => {
  it('parses system-prompt:<section> with kebab section', () => {
    expect(parseFindingSubject('system-prompt:request-classification')).toEqual({
      kind: 'system-prompt',
      section: 'request-classification',
    })
  })

  it('parses system-prompt:<section> with free-form section text', () => {
    expect(parseFindingSubject('system-prompt:Tool Selection')).toEqual({
      kind: 'system-prompt',
      section: 'Tool Selection',
    })
  })

  it('parses tool-doc:<tool>', () => {
    expect(parseFindingSubject('tool-doc:list_invoices')).toEqual({
      kind: 'tool-doc',
      tool: 'list_invoices',
    })
  })

  it('parses tool-doc:<tool>:<aspect>', () => {
    expect(parseFindingSubject('tool-doc:list_invoices:examples')).toEqual({
      kind: 'tool-doc',
      tool: 'list_invoices',
      aspect: 'examples',
    })
  })

  it('parses new-tool:<name>', () => {
    expect(parseFindingSubject('new-tool:diff_csv')).toEqual({
      kind: 'new-tool',
      name: 'diff_csv',
    })
  })

  it('parses rag:<corpus>:<doc>', () => {
    expect(parseFindingSubject('rag:irs-rulings:rev-rul-2024-12')).toEqual({
      kind: 'rag',
      corpus: 'irs-rulings',
      docId: 'rev-rul-2024-12',
    })
  })

  it('parses memory:<key>', () => {
    expect(parseFindingSubject('memory:last-customer-id')).toEqual({
      kind: 'memory',
      key: 'last-customer-id',
    })
  })

  it('parses scaffolding:<concern>', () => {
    expect(parseFindingSubject('scaffolding:retry-policy')).toEqual({
      kind: 'scaffolding',
      concern: 'retry-policy',
    })
  })

  it('parses output-schema:<field>', () => {
    expect(parseFindingSubject('output-schema:filing_year')).toEqual({
      kind: 'output-schema',
      field: 'filing_year',
    })
  })

  it('rejects tool-doc with uppercase tool name', () => {
    expect(parseFindingSubject('tool-doc:ListInvoices')).toBeNull()
  })

  it('rejects new-tool with empty name', () => {
    expect(parseFindingSubject('new-tool:')).toBeNull()
  })

  it('rejects rag without corpus or doc id', () => {
    expect(parseFindingSubject('rag:irs-rulings')).toBeNull()
    expect(parseFindingSubject('rag:irs-rulings:')).toBeNull()
  })
})

describe('parseFindingSubject — stale signals', () => {
  it('parses websearch:outdated:<topic>', () => {
    expect(parseFindingSubject('websearch:outdated:capital-gains-rates-2023')).toEqual({
      kind: 'websearch.outdated',
      topic: 'capital-gains-rates-2023',
    })
  })

  it('parses prior-run-summary:<topic>', () => {
    expect(parseFindingSubject('prior-run-summary:cost-basis-method')).toEqual({
      kind: 'prior-run-summary',
      topic: 'cost-basis-method',
    })
  })
})

describe('parseFindingSubject — cluster labels (failure-mode)', () => {
  it('parses a kebab-case cluster label', () => {
    expect(parseFindingSubject('tool-call-loop')).toEqual({
      kind: 'cluster',
      label: 'tool-call-loop',
    })
  })

  it('parses a long but valid label', () => {
    expect(parseFindingSubject('auth-revoked-mid-run')).toEqual({
      kind: 'cluster',
      label: 'auth-revoked-mid-run',
    })
  })

  it('rejects a cluster label with whitespace', () => {
    expect(parseFindingSubject('tool call loop')).toBeNull()
  })

  it('rejects a cluster label with uppercase letters', () => {
    expect(parseFindingSubject('ToolCallLoop')).toBeNull()
  })

  it('rejects an overly long label', () => {
    expect(parseFindingSubject('a'.repeat(81))).toBeNull()
  })

  it('admits dotted/underscored identifier labels (e.g. a task id)', () => {
    // A real finding the analyst emitted whose natural subject was a task id.
    // The cluster grammar previously rejected '.'/'_', dropping the whole row.
    expect(parseFindingSubject('appworld.task.530b157_1')).toEqual({
      kind: 'cluster',
      label: 'appworld.task.530b157_1',
    })
    expect(parseFindingSubject('llm.step.5')).toEqual({ kind: 'cluster', label: 'llm.step.5' })
  })

  it('does NOT admit ":" into cluster — prefixed grammars still win', () => {
    // ':' stays out of the cluster charset so prefixed subjects route to their
    // own variant rather than collapsing into a cluster label.
    expect(parseFindingSubject('memory:user-prefs')).toEqual({ kind: 'memory', key: 'user-prefs' })
    expect(parseFindingSubject('system-prompt:tone')).toEqual({
      kind: 'system-prompt',
      section: 'tone',
    })
    expect(parseFindingSubject('scaffolding:retry-policy')).toEqual({
      kind: 'scaffolding',
      concern: 'retry-policy',
    })
  })
})

describe('parseFindingSubject — boundary cases', () => {
  it('returns null for undefined', () => {
    expect(parseFindingSubject(undefined)).toBeNull()
  })

  it('returns null for null', () => {
    expect(parseFindingSubject(null)).toBeNull()
  })

  it('returns null for empty string', () => {
    expect(parseFindingSubject('')).toBeNull()
  })

  it('returns null for whitespace-only string', () => {
    expect(parseFindingSubject('   ')).toBeNull()
  })

  it('returns null for prose subject ("fix the prompt")', () => {
    expect(parseFindingSubject('fix the prompt')).toBeNull()
  })

  it('returns null for unknown prefix', () => {
    expect(parseFindingSubject('unknown-prefix:foo')).toBeNull()
  })

  it('trims leading/trailing whitespace before parsing', () => {
    expect(parseFindingSubject('  system-prompt:request-classification  ')).toEqual({
      kind: 'system-prompt',
      section: 'request-classification',
    })
  })
})

describe('renderFindingSubject', () => {
  it('round-trips every parseable subject', () => {
    const cases: Array<FindingSubject> = [
      { kind: 'knowledge.wiki', slug: 'invoice-shape' },
      { kind: 'knowledge.wiki', slug: 'invoice-shape', heading: 'line-items' },
      { kind: 'knowledge.claim', topic: 'cap-table-shape' },
      { kind: 'knowledge.raw', sourceId: 'irs-pub-501-2024' },
      { kind: 'knowledge.stale', slug: 'old-vat-rates' },
      { kind: 'system-prompt', section: 'request-classification' },
      { kind: 'tool-doc', tool: 'list_invoices' },
      { kind: 'tool-doc', tool: 'list_invoices', aspect: 'examples' },
      { kind: 'new-tool', name: 'diff_csv' },
      { kind: 'rag', corpus: 'irs-rulings', docId: 'rev-rul-2024-12' },
      { kind: 'memory', key: 'last-customer-id' },
      { kind: 'scaffolding', concern: 'retry-policy' },
      { kind: 'output-schema', field: 'filing_year' },
      { kind: 'websearch.outdated', topic: 'capital-gains-rates-2023' },
      { kind: 'prior-run-summary', topic: 'cost-basis-method' },
      { kind: 'cluster', label: 'tool-call-loop' },
    ]
    for (const s of cases) {
      const rendered = renderFindingSubject(s)
      const reparsed = parseFindingSubject(rendered)
      expect(reparsed).toEqual(s)
    }
  })
})

describe('KIND_EXPECTED_SUBJECTS', () => {
  it('covers every emitted kind in DEFAULT_TRACE_ANALYST_KINDS', () => {
    expect(Object.keys(KIND_EXPECTED_SUBJECTS).sort()).toEqual(
      ['failure-mode', 'improvement', 'knowledge-gap', 'knowledge-poisoning'].sort(),
    )
  })

  it('failure-mode is the ONLY kind that emits cluster subjects', () => {
    for (const [kindId, allowed] of Object.entries(KIND_EXPECTED_SUBJECTS)) {
      if (kindId === 'failure-mode') {
        expect(allowed).toContain('cluster')
      } else {
        expect(allowed).not.toContain('cluster')
      }
    }
  })

  it('every expected variant is a known FindingSubject kind', () => {
    for (const allowed of Object.values(KIND_EXPECTED_SUBJECTS)) {
      for (const variant of allowed) {
        expect(FINDING_SUBJECT_KINDS).toContain(variant)
      }
    }
  })

  it('improvement does not include websearch.outdated / prior-run-summary (stale signals are a knowledge-poisoning concern)', () => {
    const improvement = KIND_EXPECTED_SUBJECTS.improvement!
    expect(improvement).not.toContain('websearch.outdated')
    expect(improvement).not.toContain('prior-run-summary')
  })
})
