/**
 * Knowledge capture — knowledge-gap findings become reviewable wiki drafts.
 *
 * The knowledge-gap analyst detects facts an agent had to discover at run
 * time; `@tangle-network/agent-knowledge` stores curated facts. Nothing
 * joined the two, and this module is that join.
 *
 * Drafts, never writes. The transform is pure: no file I/O, no
 * knowledge-base handle, no network. That boundary is the point, not an
 * omission. An analyst finding is a MODEL CLAIM about a trace, and writing
 * model claims straight into a curated knowledge base is precisely the
 * corruption the knowledge-poisoning analyst exists to detect — a KB that
 * ingests its own analyst's guesses will later cite them as sources and
 * launder a guess into a fact. So the output is a reviewable value: a human
 * or a gated activation path decides what gets written.
 *
 * SAFE to do with a reviewed candidate:
 * - render `draft.body` for review;
 * - append `draft.body` as a section to the page identified by `draft.slug`,
 *   creating that page (and synthesizing its title) if it does not exist;
 * - merge `draft.frontmatter` into that page's frontmatter, unioning `tags`
 *   into the page's existing tags rather than assigning over them;
 * - grep the knowledge base for `KNOWLEDGE_CANDIDATE_TAG` afterwards.
 *
 * NOT safe. These are prevented structurally, not warned about in prose:
 * - `KnowledgeCandidateDraft` is NOT agent-knowledge's `KnowledgePage` and
 *   is not assignable to one: it carries no `id`, `path`, `text`,
 *   `sourceIds`, or `outLinks`, so it cannot be handed to a page writer. A
 *   finding cannot distinguish create from update — the locus grammar
 *   defines `agent-knowledge:wiki:<slug>` as "create OR update" — and a
 *   `#heading` locus makes the body a section of a page rather than the
 *   page. Written as a whole page, either one truncates a curated page to
 *   one claim and replaces its frontmatter.
 * - `draft.frontmatter` is a merge patch, not a page's frontmatter. It omits
 *   `id` and `title` so a merge can neither re-identify nor rename an
 *   existing page, and `draft.body` opens at `##` rather than `# ` for the
 *   same reason: a page title is a property of the page, and a finding names
 *   only a locus.
 * - evidence URIs are NOT `SourceRecord` ids. They ride under
 *   `frontmatter.evidence_uris` and never under `sources`, because
 *   `lintKnowledgeIndex` reports every cited id absent from the source
 *   registry as a `missing-source` finding at severity `error`. An
 *   activation path that wants `sources` populated must first mint a
 *   `SourceRecord` per anchor (`addSourceText({ uri, text: excerpt })`) and
 *   write the minted ids. An anchor with no excerpt carries no text to
 *   register, and this module never invents one.
 *
 * Text copied verbatim out of a finding is markup-neutralized before it
 * reaches `draft.body` (see `escapeKnowledgeMarkup`). The knowledge base
 * derives graph edges and source citations from body text by raw regex, so
 * an unescaped excerpt is an injection path into the KB's graph — through
 * text an observed agent can influence, in the module whose stated reason
 * to exist is preventing knowledge poisoning.
 *
 * Routing is by subject prefix. Knowledge findings carry a typed locus
 * (`agent-knowledge:wiki:platform-billing-signup-credit`,
 * `system-prompt:account-access`, `tool-doc:gh:auth`, ...), and the prefix
 * says which layer owns the fix. Only `agent-knowledge:wiki:*` is a wiki
 * draft; every other locus belongs to the improvement adapter or another
 * layer and is dropped here with a stated reason rather than silently
 * skipped.
 *
 * Three analyst kinds emit `agent-knowledge:wiki:*` (see
 * `KIND_EXPECTED_SUBJECTS` in `./finding-subject`): `knowledge-gap` reports
 * a fact the KB lacks, `knowledge-poisoning` reports a page that is WRONG,
 * and `improvement` asks for a revision to an existing page. Only the first
 * is knowledge to add. Pass `allowedAnalystIds` to enforce that; the default
 * admits all three and stamps `analystId` on every candidate so a caller can
 * filter downstream.
 */

import { parseFindingSubject } from './finding-subject'
import type { AnalystFinding, AnalystSeverity, EvidenceRef } from './types'

/**
 * Evidence kinds admissible as draft anchors: references that point at a
 * recorded observation a reviewer can go re-read.
 *
 * `finding` and `metric` refs are excluded on purpose. A `finding` ref
 * anchors one model claim to another model claim, so the resulting draft
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
 * Tag stamped on every candidate. Survives into the knowledge base if a
 * candidate is ever activated, so an unreviewed model claim that reached the
 * store is still greppable after the fact.
 */
export const KNOWLEDGE_CANDIDATE_TAG = 'analyst-candidate'

/** One admitted evidence reference, carried verbatim from the finding. */
export interface KnowledgeCandidateAnchor {
  kind: EvidenceRef['kind']
  uri: string
  excerpt?: string
}

/**
 * A markdown fragment destined for one wiki page, deliberately NOT shaped
 * like agent-knowledge's `KnowledgePage`.
 *
 * The missing fields are the contract: without `id`, `path`, `text`,
 * `sourceIds`, and `outLinks`, this value cannot be passed where a page is
 * expected, which is the only reliable way to stop a section fragment from
 * overwriting the curated page it belongs to.
 */
export interface KnowledgeCandidateDraft {
  /** Page slug from the locus. Page identity in the KB, not a file path. */
  slug: string
  /**
   * Section named by the locus, when it named one. Absent means the finding
   * named only the page; `body` is still a section fragment either way,
   * because a finding cannot say whether that page already exists.
   */
  heading?: string
  /**
   * Markdown fragment opening at `##`. Contains no frontmatter block and no
   * live `[[...]]` or `[^...]` markup — see `escapeKnowledgeMarkup`.
   */
  body: string
  /**
   * Frontmatter fields to MERGE into the target page. Every value is a
   * single-line scalar, a number, a boolean, or an array of
   * control-character-free strings, because agent-knowledge's frontmatter
   * writer emits scalars raw and a newline inside one would inject
   * arbitrary keys into the block.
   */
  frontmatter: Record<string, unknown>
}

/** A draft plus the provenance a reviewer needs to judge it. */
export interface KnowledgeCandidate {
  draft: KnowledgeCandidateDraft
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
  /** Wiki locus from an analyst the caller did not admit as page content. */
  | 'wrong-analyst'
  /** No evidence reference points at a recorded observation. */
  | 'no-grounding-evidence'
  /** Claim text is empty, so the draft would have no content. */
  | 'empty-claim'

/** Why one finding produced no candidate. Drops are reported, never silent. */
export interface KnowledgeCaptureDrop {
  findingId: string
  subject?: string
  reason: KnowledgeCaptureDropReason
}

export interface KnowledgeCaptureOptions {
  /**
   * Analyst ids admitted as page content. Omitting it applies no filter:
   * every wiki-routed finding is captured and the caller judges `analystId`
   * itself. The check runs AFTER locus routing so that `dropped` still
   * reports which loci each analyst actually emits — that diagnostic is why
   * drops are returned at all.
   */
  allowedAnalystIds?: ReadonlyArray<string>
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
 * Turn findings into candidate wiki drafts.
 *
 * Pure and total: every input finding appears in exactly one of
 * `candidates` or `dropped`. Ordering follows the input.
 *
 * Several findings may route to the same slug, producing several drafts that
 * share `draft.slug`. That collision is preserved rather than resolved —
 * merging two claims about one page is an editorial decision, and picking a
 * winner here would discard evidence the reviewer never saw.
 *
 * Confidence is recorded, never thresholded. Discarding a low-confidence
 * finding is a review policy; applying it inside the transform would make
 * the policy invisible to the operator who has to defend the KB's contents.
 */
export function captureKnowledgeCandidates(
  findings: ReadonlyArray<AnalystFinding>,
  options: KnowledgeCaptureOptions = {},
): KnowledgeCaptureResult {
  const candidates: KnowledgeCandidate[] = []
  const dropped: KnowledgeCaptureDrop[] = []

  for (const finding of findings) {
    const outcome = captureOne(finding, options)
    if ('reason' in outcome) dropped.push(outcome)
    else candidates.push(outcome)
  }

  return { candidates, dropped }
}

function captureOne(
  finding: AnalystFinding,
  options: KnowledgeCaptureOptions,
): KnowledgeCandidate | KnowledgeCaptureDrop {
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

  const allowed = options.allowedAnalystIds
  if (allowed !== undefined && !allowed.includes(finding.analyst_id)) return drop('wrong-analyst')

  const anchors = groundingAnchors(finding.evidence_refs)
  if (anchors.length === 0) return drop('no-grounding-evidence')

  const claim = finding.claim.trim()
  if (claim.length === 0) return drop('empty-claim')

  const frontmatter: Record<string, unknown> = {
    status: 'draft',
    drafted_from_finding: finding.finding_id,
    analyst_id: finding.analyst_id,
    severity: finding.severity,
    confidence: finding.confidence,
    // Distinguishes a claim read off a trace from one lifted out of another
    // model's verdict; the second is a weaker basis for a curated page.
    derived_from_judge: finding.derived_from_judge === true,
    // Trace URIs, not source-registry ids. Under `sources` these would each
    // become a `missing-source` lint error the moment the page was indexed.
    evidence_uris: anchors.map((a) => a.uri),
    tags: [KNOWLEDGE_CANDIDATE_TAG],
  }

  return {
    draft: {
      slug: subject.slug,
      ...(subject.heading === undefined ? {} : { heading: subject.heading }),
      body: renderBody({
        finding,
        claim,
        // Both slug and heading are `[a-z0-9-]+` under the locus grammar, so
        // the rendered title needs no markup neutralization.
        sectionTitle: humanize(subject.heading ?? subject.slug),
        anchors,
      }),
      frontmatter,
    },
    sourceFindingId: finding.finding_id,
    analystId: finding.analyst_id,
    severity: finding.severity,
    confidence: finding.confidence,
    anchors,
  }
}

/**
 * Admit references that anchor to observation. Dedupes on URI so a finding
 * that cited one span twice does not inflate the draft's apparent source
 * count.
 *
 * A URI is one line by definition. One carrying a control character is
 * rejected rather than rewritten: it is rendered into a frontmatter list
 * item, and agent-knowledge's frontmatter writer emits list items raw, so an
 * embedded newline would terminate the list and inject arbitrary keys.
 * Silently stripping the character would instead invent a URI the finding
 * never cited.
 */
function groundingAnchors(refs: ReadonlyArray<EvidenceRef>): KnowledgeCandidateAnchor[] {
  const seen = new Set<string>()
  const anchors: KnowledgeCandidateAnchor[] = []
  for (const ref of refs) {
    if (!GROUNDING_EVIDENCE_KINDS.includes(ref.kind)) continue
    const uri = ref.uri.trim()
    if (uri.length === 0 || seen.has(uri)) continue
    if (/\p{Cc}/u.test(uri)) continue
    seen.add(uri)
    const excerpt = ref.excerpt?.trim()
    anchors.push({ kind: ref.kind, uri, ...(excerpt ? { excerpt } : {}) })
  }
  return anchors
}

/**
 * Neutralize knowledge-base markup in text copied verbatim from a finding.
 *
 * agent-knowledge derives a page's `outLinks` from `[[target]]` and its
 * source citations from `[^source-id]`, both by raw regex over the whole
 * body — code fences and blockquotes do not protect them. An excerpt lifted
 * off a span is text an observed agent could have written, so leaving it
 * live lets a trace add graph edges and source citations the finding never
 * made.
 *
 * Every `[` is escaped, not just the pairs: neutralizing `[[` alone leaves
 * runs like `[[[x]]` re-forming a valid pair after one pass. With every `[`
 * preceded by a backslash, no two can end up adjacent. A leading `^` is
 * escaped with it — the citation regex has no lookbehind, so `\[^id]` still
 * matches and only breaking the `[`/`^` adjacency stops it.
 */
function escapeKnowledgeMarkup(text: string): string {
  return text.replace(/\[\^?/g, (match) => (match === '[^' ? '\\[\\^' : '\\['))
}

/**
 * Render the fragment body. Every line originates in the finding: the claim,
 * its rationale, its recommended action, its validation plan, and its
 * evidence URIs with excerpts quoted. The only derived text is the section
 * title, a mechanical de-kebabing of the locus the analyst itself chose.
 *
 * The body opens at `##` in every case. `loadKnowledgePages` reads a page's
 * title from its first `# ` heading, so emitting one here would let a
 * fragment rename the page it is merged into.
 */
function renderBody(input: {
  finding: AnalystFinding
  claim: string
  sectionTitle: string
  anchors: ReadonlyArray<KnowledgeCandidateAnchor>
}): string {
  const { finding, claim, sectionTitle, anchors } = input
  const rationale = finding.rationale?.trim()
  const action = finding.recommended_action?.trim()
  const plan = finding.validation_plan?.trim()

  const lines = [`## ${sectionTitle}`, '', escapeKnowledgeMarkup(claim), '']
  if (rationale) lines.push('### Rationale', '', escapeKnowledgeMarkup(rationale), '')
  if (action) lines.push('### Recommended action', '', escapeKnowledgeMarkup(action), '')
  if (plan) lines.push('### Validation plan', '', escapeKnowledgeMarkup(plan), '')

  lines.push('### Sources', '')
  for (const anchor of anchors) {
    lines.push(`- \`${escapeKnowledgeMarkup(anchor.uri)}\``)
    // Blockquote per line rather than an inline quoted string: excerpts can
    // contain quotes and newlines. Edge whitespace is trimmed and `[` is
    // escaped; nothing else about the excerpt changes.
    if (anchor.excerpt) {
      lines.push(
        ...escapeKnowledgeMarkup(anchor.excerpt)
          .split('\n')
          .map((l) => `  > ${l}`),
      )
    }
  }

  return `${lines.join('\n')}\n`
}

function humanize(slug: string): string {
  const words = slug.split('-').filter((w) => w.length > 0)
  if (words.length === 0) return slug
  return words.map((w) => w[0]!.toUpperCase() + w.slice(1)).join(' ')
}
