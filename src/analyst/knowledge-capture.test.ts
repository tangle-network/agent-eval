import { describe, expect, it } from 'vitest'
import {
  captureKnowledgeCandidates,
  GROUNDING_EVIDENCE_KINDS,
  KNOWLEDGE_CANDIDATE_TAG,
} from './knowledge-capture'
import { type AnalystFinding, type EvidenceRef, makeFinding } from './types'

/**
 * The observed session this module was built for: the agent filed a public
 * issue naming the wrong root cause, then discovered mid-run that the
 * platform grants a signup credit. The fact was learned and then lost.
 */
function signupCreditFinding(
  overrides: Partial<Omit<AnalystFinding, 'schema_version' | 'finding_id' | 'produced_at'>> = {},
): AnalystFinding {
  // Overrides are folded in BEFORE makeFinding so finding_id derives from the
  // claim and subject the test actually uses; computing it first would give
  // two different findings the same identity.
  return makeFinding({
    analyst_id: 'knowledge-gap',
    severity: 'high',
    area: 'knowledge-gap',
    claim:
      'The platform grants a $2 signup credit to new accounts; the agent did not know this and attributed the balance to a billing bug.',
    rationale:
      'The agent filed issue #412 blaming a double-charge before reading the credit line in the account response.',
    recommended_action:
      'Record the signup credit amount and its eligibility window on the billing wiki page.',
    evidence_refs: [
      {
        kind: 'span',
        uri: 'otlp:span/2f9c1a4b',
        excerpt: 'account.credits[0] = { source: "signup", amount_usd: 2 }',
      },
      { kind: 'span', uri: 'otlp:span/7d31e880', excerpt: 'Actually, that $2 is a signup credit.' },
    ],
    confidence: 0.9,
    subject: 'agent-knowledge:wiki:platform-billing-signup-credit',
    ...overrides,
  })
}

describe('captureKnowledgeCandidates — routing', () => {
  it('turns an agent-knowledge:wiki finding into a candidate page', () => {
    const { candidates, dropped } = captureKnowledgeCandidates([signupCreditFinding()])

    expect(dropped).toEqual([])
    expect(candidates).toHaveLength(1)
    const candidate = candidates[0]!
    expect(candidate.slug).toBe('platform-billing-signup-credit')
    expect(candidate.heading).toBeUndefined()
    expect(candidate.page.id).toBe('platform-billing-signup-credit')
    expect(candidate.page.path).toBe('knowledge/platform-billing-signup-credit.md')
    expect(candidate.page.title).toBe('Platform Billing Signup Credit')
    expect(candidate.page.tags).toEqual([KNOWLEDGE_CANDIDATE_TAG])
    expect(candidate.analystId).toBe('knowledge-gap')
    expect(candidate.severity).toBe('high')
    expect(candidate.confidence).toBe(0.9)
    expect(candidate.sourceFindingId).toBe(signupCreditFinding().finding_id)
  })

  it('ignores loci that belong to other runtime layers', () => {
    const otherLayers = [
      'system-prompt:account-access',
      'tool-doc:billing-api:credits',
      'memory:last-invoice',
      'skill:billing-triage',
      'websearch:outdated:stripe-fees',
      'agent-knowledge:claim:signup-credit',
      'agent-knowledge:raw:billing-docs-2026',
      'agent-knowledge:stale:platform-billing-signup-credit',
    ]
    const findings = otherLayers.map((subject) => signupCreditFinding({ subject }))

    const { candidates, dropped } = captureKnowledgeCandidates(findings)

    expect(candidates).toEqual([])
    expect(dropped.map((d) => d.reason)).toEqual(otherLayers.map(() => 'non-wiki-locus'))
    expect(dropped.map((d) => d.subject)).toEqual(otherLayers)
  })

  it('drops a finding with no subject and one whose subject is not in the grammar', () => {
    const noSubject = signupCreditFinding({ subject: undefined })
    const prose = signupCreditFinding({ subject: 'please add this to the wiki' })

    const { candidates, dropped } = captureKnowledgeCandidates([noSubject, prose])

    expect(candidates).toEqual([])
    expect(dropped).toEqual([
      { findingId: noSubject.finding_id, reason: 'no-subject' },
      {
        findingId: prose.finding_id,
        subject: 'please add this to the wiki',
        reason: 'unparsed-subject',
      },
    ])
  })

  it('accounts for every input finding exactly once', () => {
    const findings = [
      signupCreditFinding({ claim: 'kept: the signup credit is $2.' }),
      signupCreditFinding({ claim: 'other layer', subject: 'system-prompt:account-access' }),
      signupCreditFinding({ claim: 'ungrounded', evidence_refs: [] }),
      signupCreditFinding({ claim: 'no locus', subject: undefined }),
    ]

    const { candidates, dropped } = captureKnowledgeCandidates(findings)

    expect(candidates.length + dropped.length).toBe(findings.length)
    const seen = [...candidates.map((c) => c.sourceFindingId), ...dropped.map((d) => d.findingId)]
    expect(new Set(seen)).toEqual(new Set(findings.map((f) => f.finding_id)))
  })
})

describe('captureKnowledgeCandidates — grounding', () => {
  it('drops a finding with no evidence refs rather than emitting empty anchors', () => {
    const ungrounded = signupCreditFinding({ evidence_refs: [] })

    const { candidates, dropped } = captureKnowledgeCandidates([ungrounded])

    expect(candidates).toEqual([])
    expect(dropped).toEqual([
      {
        findingId: ungrounded.finding_id,
        subject: 'agent-knowledge:wiki:platform-billing-signup-credit',
        reason: 'no-grounding-evidence',
      },
    ])
  })

  it('drops a finding anchored only to another finding or a metric', () => {
    const refs: EvidenceRef[] = [
      { kind: 'finding', uri: 'f_1234567890abcdef1234' },
      { kind: 'metric', uri: 'metric:clarifying_questions' },
    ]
    for (const kind of refs.map((r) => r.kind)) {
      expect(GROUNDING_EVIDENCE_KINDS).not.toContain(kind)
    }

    const { candidates, dropped } = captureKnowledgeCandidates([
      signupCreditFinding({ evidence_refs: refs }),
    ])

    expect(candidates).toEqual([])
    expect(dropped[0]!.reason).toBe('no-grounding-evidence')
  })

  it('drops a wiki-routed finding whose claim is blank', () => {
    const { candidates, dropped } = captureKnowledgeCandidates([
      signupCreditFinding({ claim: '   ' }),
    ])

    expect(candidates).toEqual([])
    expect(dropped[0]!.reason).toBe('empty-claim')
  })

  it('anchors match the finding evidence URIs exactly, in order', () => {
    const finding = signupCreditFinding()
    const { candidates } = captureKnowledgeCandidates([finding])
    const candidate = candidates[0]!

    const expectedUris = finding.evidence_refs.map((r) => r.uri)
    expect(candidate.anchors.map((a) => a.uri)).toEqual(expectedUris)
    expect(candidate.page.sourceIds).toEqual(expectedUris)
    expect(candidate.page.frontmatter.sources).toEqual(expectedUris)
    expect(candidate.anchors).toEqual(
      finding.evidence_refs.map((r) => ({ kind: r.kind, uri: r.uri, excerpt: r.excerpt })),
    )
  })

  it('keeps grounded refs while discarding blank, duplicate, and non-observed ones', () => {
    const finding = signupCreditFinding({
      evidence_refs: [
        { kind: 'span', uri: 'otlp:span/2f9c1a4b' },
        { kind: 'span', uri: '   ' },
        { kind: 'span', uri: 'otlp:span/2f9c1a4b' },
        { kind: 'finding', uri: 'f_1234567890abcdef1234' },
        { kind: 'artifact', uri: 'artifact:issue-412.json' },
      ],
    })

    const { candidates } = captureKnowledgeCandidates([finding])

    expect(candidates[0]!.anchors).toEqual([
      { kind: 'span', uri: 'otlp:span/2f9c1a4b' },
      { kind: 'artifact', uri: 'artifact:issue-412.json' },
    ])
  })
})

describe('captureKnowledgeCandidates — page content', () => {
  it('carries the claim, recommended action, and evidence excerpts, and nothing else', () => {
    const finding = signupCreditFinding()
    const { text } = captureKnowledgeCandidates([finding]).candidates[0]!.page

    expect(text).toContain(finding.claim)
    expect(text).toContain(finding.rationale)
    expect(text).toContain(finding.recommended_action)
    for (const ref of finding.evidence_refs) {
      expect(text).toContain(ref.uri)
      expect(text).toContain(ref.excerpt)
    }
    // The frontmatter block belongs to the `frontmatter` field, matching how
    // the knowledge base splits a page it loads from disk.
    expect(text.startsWith('---')).toBe(false)
    expect(text).toContain('# Platform Billing Signup Credit')
  })

  it('omits sections the finding did not supply', () => {
    const { text } = captureKnowledgeCandidates([
      signupCreditFinding({ rationale: undefined, recommended_action: undefined }),
    ]).candidates[0]!.page

    expect(text).not.toContain('Rationale')
    expect(text).not.toContain('Recommended action')
    expect(text).toContain('Sources')
  })

  it('never fabricates outgoing links', () => {
    const { page } = captureKnowledgeCandidates([signupCreditFinding()]).candidates[0]!

    expect(page.outLinks).toEqual([])
    expect(page.text).not.toMatch(/\[\[/)
  })

  it('mirrors sourceIds and tags into frontmatter so a disk round-trip keeps them', () => {
    const finding = signupCreditFinding()
    const { page } = captureKnowledgeCandidates([finding]).candidates[0]!

    expect(page.frontmatter.sources).toEqual(page.sourceIds)
    expect(page.frontmatter.tags).toEqual(page.tags)
    expect(page.frontmatter.id).toBe(page.id)
    expect(page.frontmatter.title).toBe(page.title)
    expect(page.frontmatter.status).toBe('candidate')
    expect(page.frontmatter.drafted_from_finding).toBe(finding.finding_id)
    expect(page.frontmatter.analyst_id).toBe('knowledge-gap')
    expect(page.frontmatter.severity).toBe('high')
    expect(page.frontmatter.confidence).toBe(0.9)
    expect(page.frontmatter.derived_from_judge).toBe(false)
  })

  it('flags a finding lifted from a judge verdict rather than read off a trace', () => {
    const { page } = captureKnowledgeCandidates([signupCreditFinding({ derived_from_judge: true })])
      .candidates[0]!

    expect(page.frontmatter.derived_from_judge).toBe(true)
  })

  it('records a heading locus as a section body under the same page', () => {
    const { candidates } = captureKnowledgeCandidates([
      signupCreditFinding({
        subject: 'agent-knowledge:wiki:platform-billing-signup-credit#eligibility',
      }),
    ])
    const candidate = candidates[0]!

    expect(candidate.heading).toBe('eligibility')
    expect(candidate.slug).toBe('platform-billing-signup-credit')
    expect(candidate.page.path).toBe('knowledge/platform-billing-signup-credit.md')
    expect(candidate.page.text.startsWith('## Eligibility\n')).toBe(true)
    expect(candidate.page.text).not.toContain('# Platform Billing Signup Credit')
  })

  it('preserves two findings that route to the same page instead of merging them', () => {
    const first = signupCreditFinding()
    const second = signupCreditFinding({
      claim: 'The signup credit expires 30 days after account creation.',
      evidence_refs: [{ kind: 'span', uri: 'otlp:span/aa11bb22' }],
    })

    const { candidates } = captureKnowledgeCandidates([first, second])

    expect(candidates).toHaveLength(2)
    expect(candidates.map((c) => c.page.path)).toEqual([
      'knowledge/platform-billing-signup-credit.md',
      'knowledge/platform-billing-signup-credit.md',
    ])
    expect(candidates[0]!.sourceFindingId).not.toBe(candidates[1]!.sourceFindingId)
  })
})
