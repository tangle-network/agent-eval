/**
 * Knowledge capture — knowledge-gap findings become CANDIDATE wiki pages.
 *
 * The gap this closes: the knowledge-gap analyst already detects facts the
 * agent had to discover at run time. Observed case — an agent learned
 * mid-session that the platform grants a signup credit, but only after it
 * had filed a public issue naming the wrong root cause. It corrected
 * itself, the session ended, and the fact died with it; the next session
 * starts ignorant and can repeat the mistake. A detector existed
 * (knowledge-gap) and a store existed (`@tangle-network/agent-knowledge`),
 * and nothing joined them. This module is that join.
 *
 * These are CANDIDATES, never writes. The transform is pure: no file I/O,
 * no knowledge-base handle, no network. That boundary is the point, not an
 * omission. An analyst finding is a MODEL CLAIM about a trace, and writing
 * model claims straight into a curated knowledge base is precisely the
 * corruption the knowledge-poisoning analyst exists to detect — a KB that
 * ingests its own analyst's guesses will later cite them as sources and
 * launder a guess into a fact. So the output is a reviewable value: a human
 * or a gated activation path decides what gets written.
 *
 * Routing is by subject prefix. Knowledge-gap findings carry a typed locus
 * (`agent-knowledge:wiki:platform-billing-signup-credit`,
 * `system-prompt:account-access`, `tool-doc:gh:auth`, ...), and the prefix
 * says which layer owns the fix. Only `agent-knowledge:wiki:*` is a page;
 * every other locus belongs to the improvement adapter or another layer and
 * is dropped here with a stated reason rather than silently skipped.
 *
 * Caller responsibility this transform deliberately does NOT take on:
 * `knowledge-poisoning` findings also emit `agent-knowledge:wiki:*` loci,
 * but their claim describes a page that is WRONG — not knowledge to add.
 * Every candidate carries `analystId` so a caller feeding mixed findings
 * can filter; encoding that policy here would hide it from the operator.
 *
 * Structural contract: `KnowledgeCandidatePage` mirrors `KnowledgePage`
 * from `@tangle-network/agent-knowledge` field for field, so a reviewed
 * candidate can be handed to that package's page store unchanged. The shape
 * is restated rather than imported because agent-eval does not depend on
 * agent-knowledge — the dependency runs the other way (agent-knowledge
 * imports `AnalystFinding` from agent-eval), and importing back would close
 * a package cycle.
 */

import { parseFindingSubject } from './finding-subject'
import type { AnalystFinding, AnalystSeverity, EvidenceRef } from './types'

/**
 * Evidence kinds admissible as page anchors: references that point at a
 * recorded observation a reviewer can go re-read.
 *
 * `finding` and `metric` refs are excluded on purpose. A `finding` ref
 * anchors one model claim to another model claim, so the resulting page
 * would be grounded in nothing observable no matter how deep the chain is
 * followed. A `metric` ref names a scalar reading with no retrievable text,
 * so it cannot support the claim it would be cited for.
 */
export const GROUNDING_EVIDENCE_KINDS: ReadonlyArray<EvidenceRef['kind']> = [
  'span',
  'event',
  'artifact',
]

/**
 * Tag stamped on every candidate page. Survives into the knowledge base if
 * a candidate is ever activated, so an unreviewed model claim that reached
 * the store is still greppable after the fact.
 */
export const KNOWLEDGE_CANDIDATE_TAG = 'analyst-candidate'

/** One admitted evidence reference, carried verbatim from the finding. */
export interface KnowledgeCandidateAnchor {
  kind: EvidenceRef['kind']
  uri: string
  excerpt?: string
}

/**
 * A page value shaped exactly like agent-knowledge's `KnowledgePage`.
 *
 * Arrays are mutable, not `readonly`, because a `readonly string[]` is not
 * assignable to that package's `string[]` fields — the whole point of the
 * shape is that a reviewed candidate passes through without a translation
 * step that could drop provenance.
 *
 * Invariant that the knowledge base's own loader depends on: `text` is the
 * body WITHOUT the frontmatter block, and `sourceIds` / `tags` mirror
 * `frontmatter.sources` / `frontmatter.tags`. That loader reconstructs the
 * page by parsing the frontmatter off the markdown file, so a candidate
 * whose fields disagree with its frontmatter would lose its source anchors
 * the first time it round-tripped through disk.
 */
export interface KnowledgeCandidatePage {
  id: string
  path: string
  title: string
  text: string
  frontmatter: Record<string, unknown>
  sourceIds: string[]
  tags: string[]
  outLinks: string[]
}

/** A candidate page plus the provenance a reviewer needs to judge it. */
export interface KnowledgeCandidate {
  page: KnowledgeCandidatePage
  /** Page slug from the finding's locus — the page identity in the KB. */
  slug: string
  /**
   * Section under `slug` when the locus named one. Present means `page.text`
   * is a SECTION body to append under an existing page, not a whole file.
   */
  heading?: string
  sourceFindingId: string
  analystId: string
  severity: AnalystSeverity
  confidence: number
  anchors: KnowledgeCandidateAnchor[]
}

export type KnowledgeCaptureDropReason =
  /** Descriptive finding with no locus — nothing to route. */
  | 'no-subject'
  /** Subject present but outside the finding-subject grammar. */
  | 'unparsed-subject'
  /** A valid locus owned by another layer (system prompt, tool doc, ...). */
  | 'non-wiki-locus'
  /** No evidence reference points at a recorded observation. */
  | 'no-grounding-evidence'
  /** Claim text is empty, so the page would have no content. */
  | 'empty-claim'

/** Why one finding produced no candidate. Drops are reported, never silent. */
export interface KnowledgeCaptureDrop {
  findingId: string
  subject?: string
  reason: KnowledgeCaptureDropReason
}

export interface KnowledgeCaptureResult {
  candidates: KnowledgeCandidate[]
  /**
   * Every input finding that produced no candidate, with its reason. An
   * invisible skip is how routing tables rot: the caller can assert that
   * `candidates.length + dropped.length === findings.length` and see which
   * loci its analysts actually emit.
   */
  dropped: KnowledgeCaptureDrop[]
}

/**
 * Turn findings into candidate wiki pages.
 *
 * Pure and total: every input finding appears in exactly one of
 * `candidates` or `dropped`. Ordering follows the input.
 *
 * Several findings may route to the same slug, producing several candidates
 * that share `page.id` and `page.path`. That collision is preserved rather
 * than resolved — merging two claims about one page is an editorial
 * decision, and picking a winner here would discard evidence the reviewer
 * never saw.
 *
 * Confidence is recorded, never thresholded. Discarding a low-confidence
 * finding is a review policy; applying it inside the transform would make
 * the policy invisible to the operator who has to defend the KB's contents.
 */
export function captureKnowledgeCandidates(
  findings: ReadonlyArray<AnalystFinding>,
): KnowledgeCaptureResult {
  const candidates: KnowledgeCandidate[] = []
  const dropped: KnowledgeCaptureDrop[] = []

  for (const finding of findings) {
    const outcome = captureOne(finding)
    if ('reason' in outcome) dropped.push(outcome)
    else candidates.push(outcome)
  }

  return { candidates, dropped }
}

function captureOne(finding: AnalystFinding): KnowledgeCandidate | KnowledgeCaptureDrop {
  const drop = (reason: KnowledgeCaptureDropReason): KnowledgeCaptureDrop => ({
    findingId: finding.finding_id,
    ...(finding.subject === undefined ? {} : { subject: finding.subject }),
    reason,
  })

  if (finding.subject === undefined || finding.subject.trim().length === 0) {
    return drop('no-subject')
  }

  const subject = parseFindingSubject(finding.subject)
  if (subject === null) return drop('unparsed-subject')
  if (subject.kind !== 'knowledge.wiki') return drop('non-wiki-locus')

  const anchors = groundingAnchors(finding.evidence_refs)
  if (anchors.length === 0) return drop('no-grounding-evidence')

  const claim = finding.claim.trim()
  if (claim.length === 0) return drop('empty-claim')

  const title = humanize(subject.slug)
  const frontmatter: Record<string, unknown> = {
    id: subject.slug,
    title,
    status: 'candidate',
    drafted_from_finding: finding.finding_id,
    analyst_id: finding.analyst_id,
    severity: finding.severity,
    confidence: finding.confidence,
    // Distinguishes a claim read off a trace from one lifted out of another
    // model's verdict; the second is a weaker basis for a curated page.
    derived_from_judge: finding.derived_from_judge === true,
    sources: anchors.map((a) => a.uri),
    tags: [KNOWLEDGE_CANDIDATE_TAG],
  }

  return {
    page: {
      id: subject.slug,
      path: `knowledge/${subject.slug}.md`,
      title,
      text: renderBody({ finding, claim, title, heading: subject.heading, anchors }),
      frontmatter,
      sourceIds: anchors.map((a) => a.uri),
      tags: [KNOWLEDGE_CANDIDATE_TAG],
      // Never inferred. A link to a page that may not exist is fabricated
      // structure, and the KB's linter reports it as a broken link.
      outLinks: [],
    },
    slug: subject.slug,
    ...(subject.heading === undefined ? {} : { heading: subject.heading }),
    sourceFindingId: finding.finding_id,
    analystId: finding.analyst_id,
    severity: finding.severity,
    confidence: finding.confidence,
    anchors,
  }
}

/**
 * Admit references that anchor to observation, dropping blank URIs. Dedupes
 * on URI so a finding that cited one span twice does not inflate the page's
 * apparent source count.
 */
function groundingAnchors(refs: ReadonlyArray<EvidenceRef>): KnowledgeCandidateAnchor[] {
  const seen = new Set<string>()
  const anchors: KnowledgeCandidateAnchor[] = []
  for (const ref of refs) {
    if (!GROUNDING_EVIDENCE_KINDS.includes(ref.kind)) continue
    const uri = ref.uri.trim()
    if (uri.length === 0 || seen.has(uri)) continue
    seen.add(uri)
    const excerpt = ref.excerpt?.trim()
    anchors.push({ kind: ref.kind, uri, ...(excerpt ? { excerpt } : {}) })
  }
  return anchors
}

/**
 * Render the page body. Every line originates in the finding: the claim, its
 * rationale, its recommended action, and its evidence URIs with excerpts
 * quoted verbatim. The only derived text is the title, a mechanical
 * de-kebabing of the slug the analyst itself chose.
 *
 * The frontmatter block is NOT rendered here — it lives in the `frontmatter`
 * field, matching how the knowledge base splits a page it loads from disk.
 */
function renderBody(input: {
  finding: AnalystFinding
  claim: string
  title: string
  heading?: string
  anchors: ReadonlyArray<KnowledgeCandidateAnchor>
}): string {
  const { finding, claim, title, heading, anchors } = input
  const rationale = finding.rationale?.trim()
  const action = finding.recommended_action?.trim()

  const lines = [heading ? `## ${humanize(heading)}` : `# ${title}`, '', claim, '']
  if (rationale) lines.push(heading ? '### Rationale' : '## Rationale', '', rationale, '')
  if (action)
    lines.push(heading ? '### Recommended action' : '## Recommended action', '', action, '')

  lines.push(heading ? '### Sources' : '## Sources', '')
  for (const anchor of anchors) {
    lines.push(`- \`${anchor.uri}\``)
    // Blockquote per line rather than an inline quoted string: excerpts can
    // contain quotes and newlines, and the excerpt must survive unedited.
    if (anchor.excerpt) lines.push(...anchor.excerpt.split('\n').map((l) => `  > ${l}`))
  }

  return `${lines.join('\n')}\n`
}

function humanize(slug: string): string {
  const words = slug.split('-').filter((w) => w.length > 0)
  if (words.length === 0) return slug
  return words.map((w) => w[0]!.toUpperCase() + w.slice(1)).join(' ')
}
