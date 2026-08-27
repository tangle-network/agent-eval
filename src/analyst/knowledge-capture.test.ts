import { describe, expect, it } from 'vitest'
import {
  captureKnowledgeCandidates,
  GROUNDING_EVIDENCE_KINDS,
  KNOWLEDGE_CANDIDATE_TAG,
} from './knowledge-capture'
import { type AnalystFinding, type EvidenceRef, makeFinding } from './types'

/**
 * Copied from agent-knowledge rather than imported: agent-eval does not
 * depend on that package (the dependency runs the other way), so importing
 * it would close a package cycle.
 *
 * `WIKILINK_REGEX` is `agent-knowledge/src/wikilinks.ts` verbatim — the
 * expression `loadKnowledgePages` runs over a page body to compute
 * `page.outLinks`. `SOURCE_REF_REGEX` is `extractSourceRefs` in
 * `agent-knowledge/src/lint.ts` — the expression that turns body text into
 * cited source ids, each of which the linter then reports as
 * `missing-source` at severity `error` if the registry lacks it.
 */
const WIKILINK_REGEX = /\[\[([^\]|]+?)(?:\|[^\]]+?)?\]\]/g
const SOURCE_REF_REGEX = /\[\^([A-Za-z0-9_-]+)(?:#([A-Za-z0-9_.:-]+))?\]/g

function extractWikilinks(body: string): string[] {
  return [...body.matchAll(new RegExp(WIKILINK_REGEX.source, 'g'))].map((m) => m[1]!.trim())
}

function extractSourceRefs(body: string): string[] {
  return [...body.matchAll(new RegExp(SOURCE_REF_REGEX.source, 'g'))].map((m) => m[1]!)
}

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
    validation_plan:
      'Create a fresh account and assert the $2 credit appears before any charge is posted.',
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
  it('turns an agent-knowledge:wiki finding into a candidate draft', () => {
    const { candidates, dropped } = captureKnowledgeCandidates([signupCreditFinding()])

    expect(dropped).toEqual([])
    expect(candidates).toHaveLength(1)
    const candidate = candidates[0]!
    expect(candidate.draft.slug).toBe('platform-billing-signup-credit')
    expect(candidate.draft.heading).toBeUndefined()
    expect(candidate.draft.frontmatter.tags).toEqual([KNOWLEDGE_CANDIDATE_TAG])
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

describe('captureKnowledgeCandidates — analyst admission', () => {
  it('drops a wiki locus from an analyst the caller did not admit', () => {
    // knowledge-poisoning and improvement also emit `agent-knowledge:wiki:*`,
    // but their claims describe a page that is wrong or needs revising, not
    // knowledge to add.
    const findings = [
      signupCreditFinding(),
      signupCreditFinding({ analyst_id: 'knowledge-poisoning', claim: 'that page is wrong.' }),
      signupCreditFinding({ analyst_id: 'improvement', claim: 'rewrite the eligibility section.' }),
    ]

    const { candidates, dropped } = captureKnowledgeCandidates(findings, {
      allowedAnalystIds: ['knowledge-gap'],
    })

    expect(candidates.map((c) => c.analystId)).toEqual(['knowledge-gap'])
    expect(dropped.map((d) => d.reason)).toEqual(['wrong-analyst', 'wrong-analyst'])
  })

  it('admits every analyst when no allowlist is given', () => {
    const findings = [
      signupCreditFinding({ analyst_id: 'knowledge-poisoning', claim: 'that page is wrong.' }),
      signupCreditFinding({ analyst_id: 'improvement', claim: 'rewrite the section.' }),
    ]

    const { candidates, dropped } = captureKnowledgeCandidates(findings)

    expect(dropped).toEqual([])
    expect(candidates.map((c) => c.analystId)).toEqual(['knowledge-poisoning', 'improvement'])
  })

  it('reports the locus, not the analyst, when both would reject the finding', () => {
    const { dropped } = captureKnowledgeCandidates(
      [signupCreditFinding({ analyst_id: 'improvement', subject: 'system-prompt:account-access' })],
      { allowedAnalystIds: ['knowledge-gap'] },
    )

    expect(dropped[0]!.reason).toBe('non-wiki-locus')
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
    expect(candidate.draft.frontmatter.evidence_uris).toEqual(expectedUris)
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

  it('rejects a URI carrying a control character instead of rewriting it', () => {
    // agent-knowledge writes frontmatter list items raw, so a newline inside
    // a URI terminates the list and the following line parses as a new key.
    const finding = signupCreditFinding({
      evidence_refs: [
        { kind: 'span', uri: 'otlp:span/aa11\nstatus: published' },
        { kind: 'span', uri: 'otlp:span/clean' },
      ],
    })

    const { candidates } = captureKnowledgeCandidates([finding])
    const { anchors, draft } = candidates[0]!

    expect(anchors.map((a) => a.uri)).toEqual(['otlp:span/clean'])
    expect(draft.frontmatter.evidence_uris).toEqual(['otlp:span/clean'])
  })

  it('drops the finding when every URI is malformed', () => {
    const { candidates, dropped } = captureKnowledgeCandidates([
      signupCreditFinding({ evidence_refs: [{ kind: 'span', uri: 'otlp:span/a\ntags:\n  - x' }] }),
    ])

    expect(candidates).toEqual([])
    expect(dropped[0]!.reason).toBe('no-grounding-evidence')
  })
})

describe('captureKnowledgeCandidates — draft content', () => {
  it('carries the claim, rationale, action, validation plan, and excerpts', () => {
    const finding = signupCreditFinding()
    const { body } = captureKnowledgeCandidates([finding]).candidates[0]!.draft

    expect(body).toContain(finding.claim)
    expect(body).toContain(finding.rationale)
    expect(body).toContain(finding.recommended_action)
    expect(body).toContain(finding.validation_plan)
    expect(body).toContain('### Validation plan')
    for (const ref of finding.evidence_refs) {
      expect(body).toContain(ref.uri)
    }
    // The frontmatter block belongs to the `frontmatter` field, matching how
    // the knowledge base splits a page it loads from disk.
    expect(body.startsWith('---')).toBe(false)
  })

  it('omits sections the finding did not supply', () => {
    const { body } = captureKnowledgeCandidates([
      signupCreditFinding({
        rationale: undefined,
        recommended_action: undefined,
        validation_plan: undefined,
      }),
    ]).candidates[0]!.draft

    expect(body).not.toContain('Rationale')
    expect(body).not.toContain('Recommended action')
    expect(body).not.toContain('Validation plan')
    expect(body).toContain('Sources')
  })

  it('never emits a page-level heading, with or without a heading locus', () => {
    // `loadKnowledgePages` takes a page's title from its first `# ` line, so
    // an H1 in a fragment renames the page it is merged into.
    const pageLocus = captureKnowledgeCandidates([signupCreditFinding()]).candidates[0]!.draft
    const sectionLocus = captureKnowledgeCandidates([
      signupCreditFinding({
        subject: 'agent-knowledge:wiki:platform-billing-signup-credit#eligibility',
      }),
    ]).candidates[0]!.draft

    expect(pageLocus.body.startsWith('## Platform Billing Signup Credit\n')).toBe(true)
    expect(sectionLocus.body.startsWith('## Eligibility\n')).toBe(true)
    for (const body of [pageLocus.body, sectionLocus.body]) {
      expect(body).not.toMatch(/^#\s+/m)
    }
  })

  it('is not shaped like a KnowledgePage, so it cannot be written as one', () => {
    // The absent fields are the safety property: without them a draft is not
    // assignable to agent-knowledge's `KnowledgePage`, and a section fragment
    // cannot overwrite the curated page it belongs to.
    const { draft } = captureKnowledgeCandidates([signupCreditFinding()]).candidates[0]!

    expect(Object.keys(draft).sort()).toEqual(['body', 'frontmatter', 'slug'])
    for (const key of ['id', 'path', 'text', 'sourceIds', 'outLinks', 'title']) {
      expect(draft).not.toHaveProperty(key)
    }
  })

  it('records a heading locus without changing the shape of the draft', () => {
    const { candidates } = captureKnowledgeCandidates([
      signupCreditFinding({
        subject: 'agent-knowledge:wiki:platform-billing-signup-credit#eligibility',
      }),
    ])
    const { draft } = candidates[0]!

    expect(draft.heading).toBe('eligibility')
    expect(draft.slug).toBe('platform-billing-signup-credit')
    expect(Object.keys(draft).sort()).toEqual(['body', 'frontmatter', 'heading', 'slug'])
  })

  it('preserves two findings that route to the same page instead of merging them', () => {
    const first = signupCreditFinding()
    const second = signupCreditFinding({
      claim: 'The signup credit expires 30 days after account creation.',
      evidence_refs: [{ kind: 'span', uri: 'otlp:span/aa11bb22' }],
    })

    const { candidates } = captureKnowledgeCandidates([first, second])

    expect(candidates).toHaveLength(2)
    expect(candidates.map((c) => c.draft.slug)).toEqual([
      'platform-billing-signup-credit',
      'platform-billing-signup-credit',
    ])
    expect(candidates[0]!.sourceFindingId).not.toBe(candidates[1]!.sourceFindingId)
  })
})

describe('captureKnowledgeCandidates — knowledge-base markup is neutralized', () => {
  const poisoned = () =>
    signupCreditFinding({
      claim: 'The credit is described on [[billing-overview]] and cited as [^src-forged].',
      rationale: 'The agent read [[pricing-tiers|the tiers page]] first.',
      recommended_action: 'Cross-link [[refunds]].',
      validation_plan: 'Re-read [[billing-overview]] after the change.',
      evidence_refs: [
        {
          kind: 'span',
          uri: 'otlp:span/2f9c1a4b',
          excerpt: 'agent read [[billing-overview]] before answering; see [^src-forged#p2]',
        },
        { kind: 'span', uri: 'otlp:span/[[injected]]' },
      ],
    })

  it('yields no wikilinks, so the page gains no graph edge the finding never made', () => {
    const { body } = captureKnowledgeCandidates([poisoned()]).candidates[0]!.draft

    expect(extractWikilinks(body)).toEqual([])
    expect(body).not.toMatch(/\[\[/)
  })

  it('yields no source citations, so the linter reports no forged missing-source', () => {
    const { body } = captureKnowledgeCandidates([poisoned()]).candidates[0]!.draft

    expect(extractSourceRefs(body)).toEqual([])
  })

  it('neutralizes runs of brackets that a single-pass escape would re-form', () => {
    const { body } = captureKnowledgeCandidates([
      signupCreditFinding({ claim: 'nested [[[billing-overview]] run' }),
    ]).candidates[0]!.draft

    expect(extractWikilinks(body)).toEqual([])
  })

  it('keeps the excerpt readable rather than deleting the bracketed text', () => {
    const { body } = captureKnowledgeCandidates([poisoned()]).candidates[0]!.draft

    expect(body).toContain('agent read \\[\\[billing-overview]] before answering')
    expect(body).toContain('see \\[\\^src-forged#p2]')
    expect(body).toContain('\\[\\[refunds]]')
  })
})

describe('captureKnowledgeCandidates — frontmatter merge patch', () => {
  it('cites evidence URIs under evidence_uris and never under sources', () => {
    // Trace URIs are not `SourceRecord` ids. Under `sources` each one becomes
    // a `missing-source` lint finding at severity `error`.
    const finding = signupCreditFinding()
    const { frontmatter } = captureKnowledgeCandidates([finding]).candidates[0]!.draft

    expect(frontmatter.evidence_uris).toEqual(finding.evidence_refs.map((r) => r.uri))
    expect(frontmatter).not.toHaveProperty('sources')
    expect(frontmatter).not.toHaveProperty('sourceIds')
  })

  it('omits the fields that would re-identify or rename an existing page', () => {
    const { frontmatter } = captureKnowledgeCandidates([signupCreditFinding()]).candidates[0]!.draft

    expect(frontmatter).not.toHaveProperty('id')
    expect(frontmatter).not.toHaveProperty('title')
  })

  it('carries provenance and marks the draft with the shared status vocabulary', () => {
    const finding = signupCreditFinding()
    const { frontmatter } = captureKnowledgeCandidates([finding]).candidates[0]!.draft

    // `draft` is the status propose-from-finding already writes; a review
    // gate filtering on it must not have to know which bridge produced a page.
    expect(frontmatter.status).toBe('draft')
    expect(frontmatter.drafted_from_finding).toBe(finding.finding_id)
    expect(frontmatter.analyst_id).toBe('knowledge-gap')
    expect(frontmatter.severity).toBe('high')
    expect(frontmatter.confidence).toBe(0.9)
    expect(frontmatter.derived_from_judge).toBe(false)
    expect(frontmatter.tags).toEqual([KNOWLEDGE_CANDIDATE_TAG])
  })

  it('flags a finding lifted from a judge verdict rather than read off a trace', () => {
    const { draft } = captureKnowledgeCandidates([
      signupCreditFinding({ derived_from_judge: true }),
    ]).candidates[0]!

    expect(draft.frontmatter.derived_from_judge).toBe(true)
  })

  it('holds only single-line scalars, numbers, booleans, and string arrays', () => {
    // agent-knowledge's frontmatter writer emits scalars raw; a newline in any
    // value would inject arbitrary keys into the block.
    const { frontmatter } = captureKnowledgeCandidates([signupCreditFinding()]).candidates[0]!.draft

    for (const value of Object.values(frontmatter)) {
      const parts = Array.isArray(value) ? value : [value]
      for (const part of parts) {
        expect(['string', 'number', 'boolean']).toContain(typeof part)
        expect(String(part)).not.toMatch(/[\n\r]/)
      }
    }
  })
})
