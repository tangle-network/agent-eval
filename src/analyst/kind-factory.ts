import { CostLedger } from '../cost-ledger'
import { hashCanonical } from '../ledger-core/canonical'
import type { TraceAnalysisStore } from '../trace-analyst/store'
import type { TraceAnalysisEngine, TraceAnalysisEngineResult, TraceAnalystLimits } from './engine'
import { resolveTraceAnalystLimits } from './engine'
import { type ExactCapableAnalyst, snapshotExactExecutionComponentIdentity } from './exact-types'
import {
  evidenceRefsFromRawFinding,
  parseRawFinding,
  parseTraceSpanEvidenceUri,
  RAW_FINDING_SCHEMA_PROMPT,
  type RawAnalystFinding,
} from './finding-signature'
import { KIND_EXPECTED_SUBJECTS, parseFindingSubject } from './finding-subject'
import { buildTraceToolsForGroup, type TraceToolGroupName } from './tool-groups'
import type { AnalystContext, AnalystFinding } from './types'
import { makeFinding } from './types'
import { settleUsageReceiptFromCostLedger, validateUsageSettlementTimeout } from './usage-receipt'

/**
 * Who spoke in a cited turn. Distinct from `openinference.span.kind`
 * (AGENT/LLM/TOOL/…), which types the span rather than the speaker inside it:
 * one LLM span routinely carries a human turn in `llm.input_messages` and an
 * assistant turn in `llm.output_messages`.
 */
export type CitedTurnRole = 'human' | 'assistant'

/** `'unknown'` is an answer, not a default to either side: it means the cited
 *  content carries no role label that can be read. */
type ResolvedTurnRole = CitedTurnRole | 'unknown'

/** A named research question independent of the recursive engine that runs it. */
export interface TraceAnalystDefinition {
  id: string
  description: string
  area: string
  version: string
  /** User-facing question. A function may derive it from run context. */
  question?: string | ((context: AnalystContext) => string)
  /** Research policy, evidence rules, and domain-specific instructions. */
  instructions: string
  /** Smallest trace-tool set that can answer the question. */
  toolGroup: TraceToolGroupName
  /** Optional bounded context assembled deterministically before the investigation. */
  prepareContext?: (
    store: TraceAnalysisStore,
    context: AnalystContext,
  ) => string | undefined | Promise<string | undefined>
  limits?: Partial<TraceAnalystLimits>
  postProcess?: (row: RawAnalystFinding, context: AnalystContext) => RawAnalystFinding | null
  minimumEvidenceCitations?: number
  /** Turn roles the citations must together quote — `['human', 'assistant']`
   *  for a kind whose ground truth is a human turn about an agent turn.
   *  A count of distinct URIs cannot express that: two assistant spans satisfy
   *  `minimumEvidenceCitations: 2` while quoting nothing the user said. */
  requiredCitedTurnRoles?: readonly CitedTurnRole[]
  requireStructuredFindings?: boolean
}

export interface CreateTraceAnalystOptions {
  engine: TraceAnalysisEngine
  /** Override the definition's `version` (e.g. when an optimizer has fitted new instructions). */
  versionSuffix?: string
  settlementTimeoutMs?: number
}

/** Run one definition and retain its answer, findings, and full investigation record. */
export async function runTraceAnalyst(args: {
  definition: TraceAnalystDefinition
  engine: TraceAnalysisEngine
  store: TraceAnalysisStore
  context: AnalystContext
  settlementTimeoutMs?: number
}): Promise<TraceAnalysisEngineResult> {
  const { definition, context } = args
  validateDefinition(definition)
  const minimumEvidenceCitations = definition.minimumEvidenceCitations ?? 1
  const settlementTimeoutMs = validateUsageSettlementTimeout(args.settlementTimeoutMs)
  const costLedger = context.costLedger ?? new CostLedger(context.budgetUsd)
  const costTags = {
    ...(context.tags ?? {}),
    analystId: definition.id,
    ...(context.correlationId ? { analystRunId: context.correlationId } : {}),
  }

  try {
    const preparedContext = await definition.prepareContext?.(args.store, context)
    if (preparedContext !== undefined && typeof preparedContext !== 'string') {
      throw new TypeError(`trace analyst '${definition.id}' prepareContext must return a string`)
    }
    const instructions = [
      definition.instructions.trim(),
      renderPriorFindings(context.priorFindings),
      renderUpstreamFindings(context.upstreamFindings),
      RAW_FINDING_SCHEMA_PROMPT,
      minimumEvidenceCitations > 1
        ? `Every finding requires at least ${minimumEvidenceCitations} distinct evidence citations.`
        : '',
      renderRequiredCitedTurnRoles(definition.requiredCitedTurnRoles),
      preparedContext ? `PREPARED CONTEXT:\n${preparedContext}` : '',
      'Return a direct prose answer and a strict findings array. Use trace tools to investigate. Do not infer trace facts from the question alone.',
    ]
      .filter(Boolean)
      .join('\n\n')

    const completed = await args.engine.analyze({
      analystId: definition.id,
      question: deriveQuestion(context, definition),
      instructions,
      tools: buildTraceToolsForGroup(definition.toolGroup, args.store),
      limits: resolveTraceAnalystLimits(definition.limits),
      costLedger,
      costPhase: context.costPhase ?? 'trace-analysis',
      costTags,
      ...(context.signal ? { signal: context.signal } : {}),
      ...(context.log ? { log: context.log } : {}),
    })
    const findings = await acceptFindings(
      definition,
      completed.findings,
      args.store,
      context,
      minimumEvidenceCitations,
    )
    if (definition.requireStructuredFindings && findings.length === 0) {
      throw new Error(
        `trace analyst '${definition.id}' returned no valid structured findings: ${truncateForContext(completed.answer, 600)}`,
      )
    }
    context.log?.(`trace analyst ${definition.id} completed`, {
      engine: args.engine.id,
      model_calls: completed.modelCalls,
      tool_calls: completed.toolCalls,
      submitted_findings: completed.findings.length,
      accepted_findings: findings.length,
    })
    return { ...completed, findings }
  } finally {
    const usage = await settleUsageReceiptFromCostLedger(costLedger, {
      channel: 'analyst',
      tags: costTags,
      timeoutMs: settlementTimeoutMs,
    })
    if (!usage.settled) {
      context.log?.(`trace analyst ${definition.id} provider settlement timed out`, {
        pending_calls: usage.pendingCalls,
        timeout_ms: settlementTimeoutMs,
      })
    }
    context.recordUsage?.(usage.receipt)
  }
}

/** Adapt a research definition to the common Analyst registry contract. */
export function createTraceAnalyst(
  definition: TraceAnalystDefinition,
  options: CreateTraceAnalystOptions,
): ExactCapableAnalyst<TraceAnalysisStore> {
  validateDefinition(definition)
  const version = options.versionSuffix
    ? `${definition.version}+${options.versionSuffix}`
    : definition.version
  const settlementTimeoutMs = validateUsageSettlementTimeout(options.settlementTimeoutMs)
  // Resolve once: the sealed digest and the executed request must not drift.
  const limits = resolveTraceAnalystLimits(definition.limits)
  const engineIdentity = snapshotExactExecutionComponentIdentity(
    {
      id: options.engine.id,
      version: options.engine.version,
      config: options.engine.executionConfig,
    },
    'createTraceAnalyst engine',
  )
  return {
    id: definition.id,
    description: definition.description,
    inputKind: 'trace-store',
    cost: {
      kind: 'llm',
      ...(options.engine.model ? { models: [options.engine.model] } : {}),
      settlement_timeout_ms: settlementTimeoutMs,
    },
    version,
    executionConfig: {
      kind: 'trace-analyst',
      model: options.engine.model ?? null,
      engine: options.engine.id,
      engine_identity: engineIdentity,
      instructions_digest: hashCanonical(definition.instructions.trim()),
      question:
        typeof definition.question === 'string'
          ? hashCanonical(definition.question.trim())
          : definition.question === undefined
            ? 'context-derived'
            : 'version-bound',
      tool_group: definition.toolGroup,
      max_iterations: limits.maxIterations,
      max_llm_calls: limits.maxLlmCalls,
      max_tool_calls: limits.maxToolCalls,
      max_output_chars: limits.maxOutputChars,
      minimum_evidence_citations: definition.minimumEvidenceCitations ?? 1,
      required_cited_turn_roles: canonicalCitedTurnRoles(definition.requiredCitedTurnRoles),
      require_structured_findings: definition.requireStructuredFindings ?? false,
      prepare_context: definition.prepareContext === undefined ? 'disabled' : 'version-bound',
      post_process: definition.postProcess === undefined ? 'disabled' : 'version-bound',
      evidence_verification: EVIDENCE_VERIFICATION_VERSION,
      settlement_timeout_ms: settlementTimeoutMs,
    },
    async analyze(store, context) {
      const completed = await runTraceAnalyst({
        definition,
        engine: options.engine,
        store,
        context,
        settlementTimeoutMs: options.settlementTimeoutMs,
      })
      return completed.findings.map((finding) =>
        toAnalystFinding(definition, version, finding, {
          analysis_engine: options.engine.id,
          analysis_model: options.engine.model,
          analysis_model_calls: completed.modelCalls,
          analysis_tool_calls: completed.toolCalls,
          analysis_runtime: completed.runtime,
        }),
      )
    },
  }
}

async function acceptFindings(
  definition: TraceAnalystDefinition,
  submitted: readonly unknown[],
  store: TraceAnalysisStore,
  context: AnalystContext,
  minimumEvidenceCitations: number,
): Promise<RawAnalystFinding[]> {
  const expectedSubjects = KIND_EXPECTED_SUBJECTS[definition.id]
  const requiredTurnRoles = definition.requiredCitedTurnRoles
  const accepted: RawAnalystFinding[] = []
  for (const row of submitted) {
    const parsed = parseRawFinding(row, context.log)
    if (!parsed) continue
    const processed = definition.postProcess ? definition.postProcess(parsed, context) : parsed
    if (!processed) continue
    const validated = parseRawFinding(processed, context.log)
    if (!validated) continue
    if (expectedSubjects && validated.subject !== undefined) {
      const subject = parseFindingSubject(validated.subject)
      if (subject === null || !expectedSubjects.includes(subject.kind)) {
        context.log?.('finding rejected: subject is not valid for analyst', {
          analyst_id: definition.id,
          subject: validated.subject,
          allowed: expectedSubjects,
        })
        continue
      }
    }
    const distinctEvidence = new Set(validated.evidence.map((citation) => citation.uri.trim())).size
    if (distinctEvidence < minimumEvidenceCitations) {
      context.log?.('finding rejected: insufficient evidence citations', {
        analyst_id: definition.id,
        required: minimumEvidenceCitations,
        distinct: distinctEvidence,
      })
      continue
    }
    const turnRoles = await resolveEvidenceCitations(
      validated,
      store,
      context,
      requiredTurnRoles !== undefined,
    )
    if (turnRoles === null) continue
    if (!citedTurnRolesSatisfied(requiredTurnRoles, turnRoles)) {
      context.log?.('finding rejected: citations do not cover the required turn roles', {
        analyst_id: definition.id,
        required: requiredTurnRoles,
        resolved: turnRoles,
      })
      continue
    }
    accepted.push(validated)
  }
  return accepted
}

/**
 * Verify every citation against the store. Returns `null` when one fails, and
 * otherwise the turn role of each cited trace span — empty unless the kind
 * asked for role attribution, because attributing a role costs a span read
 * that a citation without an excerpt would otherwise skip.
 */
async function resolveEvidenceCitations(
  finding: RawAnalystFinding,
  store: TraceAnalysisStore,
  context: AnalystContext,
  attributeTurnRoles: boolean,
): Promise<readonly ResolvedTurnRole[] | null> {
  const turnRoles: ResolvedTurnRole[] = []
  const knownFindings = new Map(
    [...(context.priorFindings ?? []), ...(context.upstreamFindings ?? [])].map((entry) => [
      entry.finding_id,
      entry,
    ]),
  )
  for (const citation of finding.evidence) {
    if (citation.excerpt !== undefined && citation.excerpt.trim().length < MINIMUM_EXCERPT_LENGTH) {
      rejectEvidence(context, citation.uri, 'excerpt is too short to verify')
      return null
    }
    const traceLocation = parseTraceSpanEvidenceUri(citation.uri)
    if (traceLocation) {
      const storeContext = context.signal ? { signal: context.signal } : undefined
      const existing = await store.hasSpans(
        {
          trace_id: traceLocation.traceId,
          span_ids: [traceLocation.spanId],
        },
        storeContext,
      )
      if (!existing.includes(traceLocation.spanId)) {
        rejectEvidence(context, citation.uri, 'trace span does not exist')
        return null
      }
      if (citation.excerpt === undefined && !attributeTurnRoles) continue
      const viewed = await store.viewSpans(
        {
          trace_id: traceLocation.traceId,
          span_ids: [traceLocation.spanId],
        },
        storeContext,
      )
      const span = viewed.spans.find((entry) => entry.span_id === traceLocation.spanId)
      if (citation.excerpt !== undefined) {
        if (!span || !containsExactText([span.attributes, span.status_message], citation.excerpt)) {
          rejectEvidence(context, citation.uri, 'excerpt is not present in the cited span content')
          return null
        }
      }
      if (attributeTurnRoles) {
        turnRoles.push(span ? resolveCitedTurnRole(span.attributes, citation.excerpt) : 'unknown')
      }
      continue
    }

    const findingId = parseFindingEvidenceUri(citation.uri)
    const referenced = findingId ? knownFindings.get(findingId) : undefined
    if (!referenced) {
      rejectEvidence(context, citation.uri, 'citation is not a supplied finding or trace span')
      return null
    }
    if (
      citation.excerpt !== undefined &&
      !containsExactText(
        [
          referenced.claim,
          referenced.rationale,
          referenced.recommended_action,
          referenced.validation_plan,
          referenced.evidence_refs?.map((evidence) => evidence.excerpt),
        ],
        citation.excerpt,
      )
    ) {
      rejectEvidence(context, citation.uri, 'excerpt is not present in the cited finding content')
      return null
    }
  }
  return turnRoles
}

function parseFindingEvidenceUri(uri: string): string | null {
  const match = /^finding:\/\/([^/?#]+)$/.exec(uri)
  if (!match) return null
  try {
    return decodeURIComponent(match[1]!) || null
  } catch {
    return null
  }
}

/** Excerpts must quote enough content to be checkable evidence, not an
 *  incidental substring of an id, status, or timestamp. */
const MINIMUM_EXCERPT_LENGTH = 8

/** Bumped whenever the evidence-acceptance rules change, so two differently
 *  strict builds cannot seal identical execution plans. */
const EVIDENCE_VERIFICATION_VERSION = 'resolvable-excerpt-v1'

/** Matches only within the passed content-bearing values — callers must not
 *  hand this whole spans or findings, or identifier fields become quotable. */
function containsExactText(value: unknown, expected: string, depth = 0): boolean {
  if (!expected || depth > 20) return false
  if (typeof value === 'string') return value.includes(expected)
  if (Array.isArray(value)) {
    return value.some((entry) => containsExactText(entry, expected, depth + 1))
  }
  if (typeof value === 'object' && value !== null) {
    return Object.values(value).some((entry) => containsExactText(entry, expected, depth + 1))
  }
  return false
}

function rejectEvidence(context: AnalystContext, uri: string, reason: string): void {
  context.log?.('finding rejected: unresolved evidence', { uri, reason })
}

/**
 * A turn as the OTLP producers this repo reads actually emit one: a
 * `{role, content}` object inside a serialized message array
 * (`llm.input_messages` / `llm.output_messages` in
 * `tests/fixtures/trace-analyst/tiny-trace.jsonl` and `src/trace/store-to-otlp.ts`;
 * `llm.output_messages` in the CodeTraceBench-shaped spans of
 * `src/analyst/benchmark-command.test-support.ts`).
 *
 * The scan keys on that SHAPE, never on an attribute name. Attribute keys
 * differ across datasets and a guessed key resolves every span to `'unknown'`,
 * which is the failure this rule exists to avoid.
 */
interface RoleTaggedTurn {
  role: string
  content: string
}

/** Bounds on the role scan: an attribute can hold a whole serialized
 *  conversation, and attributing a role must not dominate the cost of
 *  accepting a finding. */
const MAXIMUM_SCANNED_TURNS = 200
const MAXIMUM_TURN_SCAN_DEPTH = 6
const MAXIMUM_SCANNED_ATTRIBUTE_CHARS = 262_144

/** Producer role vocabularies. `system`, `developer`, `tool`, and `function`
 *  are deliberately absent: none of them is a party to a human/agent exchange,
 *  so attributing one to either side would invent the evidence. */
const HUMAN_TURN_ROLES = new Set(['user', 'human'])
const ASSISTANT_TURN_ROLES = new Set(['assistant', 'ai', 'model'])

/**
 * Attribute one citation to the speaker of the turn it quotes.
 *
 * The quote is the anchor, not the span: a single LLM span carries the human
 * turn it was given and the assistant turn it produced, so a span cited
 * without an excerpt that holds both sides is `'unknown'` rather than a coin
 * flip between them.
 */
export function resolveCitedTurnRole(
  attributes: Record<string, unknown>,
  excerpt: string | undefined,
): ResolvedTurnRole {
  const turns = collectRoleTaggedTurns(attributes)
  if (turns.length === 0) return 'unknown'
  const quoted = excerpt?.trim()
  const quoting = quoted ? turns.filter((turn) => turn.content.includes(quoted)) : turns
  const roles = new Set(quoting.map((turn) => normalizeTurnRole(turn.role)))
  roles.delete('unknown')
  const [only] = [...roles]
  return roles.size === 1 && only !== undefined ? only : 'unknown'
}

function normalizeTurnRole(role: string): ResolvedTurnRole {
  const normalized = role.trim().toLowerCase()
  if (HUMAN_TURN_ROLES.has(normalized)) return 'human'
  if (ASSISTANT_TURN_ROLES.has(normalized)) return 'assistant'
  return 'unknown'
}

function collectRoleTaggedTurns(attributes: Record<string, unknown>): RoleTaggedTurn[] {
  const turns: RoleTaggedTurn[] = []
  for (const value of Object.values(attributes)) {
    if (turns.length >= MAXIMUM_SCANNED_TURNS) break
    collectRoleTaggedTurnsFrom(value, turns, 0)
  }
  return turns
}

function collectRoleTaggedTurnsFrom(value: unknown, out: RoleTaggedTurn[], depth: number): void {
  if (out.length >= MAXIMUM_SCANNED_TURNS || depth > MAXIMUM_TURN_SCAN_DEPTH) return
  if (typeof value === 'string') {
    if (value.length > MAXIMUM_SCANNED_ATTRIBUTE_CHARS) return
    const trimmed = value.trim()
    if (!trimmed.startsWith('[') && !trimmed.startsWith('{')) return
    try {
      collectRoleTaggedTurnsFrom(JSON.parse(trimmed), out, depth + 1)
    } catch {
      // `viewSpans` truncates oversized attributes, so a partial message array
      // does not parse. Unattributed is the correct read of a truncated turn.
    }
    return
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectRoleTaggedTurnsFrom(entry, out, depth + 1)
    return
  }
  if (typeof value !== 'object' || value === null) return
  const record = value as Record<string, unknown>
  // A speaker plus a payload is a turn; a bare `role` field is some other
  // record (an artifact role, a permission) and must not be read as one.
  if (typeof record.role === 'string' && ('content' in record || 'parts' in record)) {
    // Non-string content (multimodal blocks) still labels a speaker; it just
    // cannot anchor a quote, so the turn counts with no quotable content.
    out.push({
      role: record.role,
      content: typeof record.content === 'string' ? record.content : '',
    })
    return
  }
  for (const entry of Object.values(record)) collectRoleTaggedTurnsFrom(entry, out, depth + 1)
}

/**
 * Enforce the required pair only where the dataset can answer.
 *
 * A dataset that carries no role labels resolves every citation to
 * `'unknown'`; rejecting there would empty this kind's output on every such
 * dataset, which is strictly worse than the citation-count bound it replaces.
 * So the rule fires only once at least one citation resolved — that is the
 * evidence that roles ARE readable here and a missing side is a real absence
 * rather than an unlabelled one.
 */
function citedTurnRolesSatisfied(
  required: readonly CitedTurnRole[] | undefined,
  resolved: readonly ResolvedTurnRole[],
): boolean {
  if (required === undefined || required.length === 0) return true
  const present = new Set(resolved.filter((role) => role !== 'unknown'))
  if (present.size === 0) return true
  return required.every((role) => present.has(role))
}

function canonicalCitedTurnRoles(required: readonly CitedTurnRole[] | undefined): CitedTurnRole[] {
  return required === undefined ? [] : [...new Set(required)].sort()
}

function renderRequiredCitedTurnRoles(required: readonly CitedTurnRole[] | undefined): string {
  const roles = canonicalCitedTurnRoles(required)
  if (roles.length === 0) return ''
  return `Your citations must together quote ${roles.join(' and ')} turns, each with the exact wording in excerpt. When the trace labels who spoke, a finding missing one of those roles is rejected.`
}

function validateDefinition(definition: TraceAnalystDefinition): void {
  for (const [name, value] of [
    ['id', definition.id],
    ['description', definition.description],
    ['area', definition.area],
    ['version', definition.version],
    ['instructions', definition.instructions],
  ] as const) {
    if (typeof value !== 'string' || !value.trim()) {
      throw new TypeError(`trace analyst ${name} must be a non-empty string`)
    }
  }
  const minimumEvidenceCitations = definition.minimumEvidenceCitations ?? 1
  if (!Number.isSafeInteger(minimumEvidenceCitations) || minimumEvidenceCitations < 1) {
    throw new TypeError('minimumEvidenceCitations must be a positive safe integer')
  }
  for (const role of definition.requiredCitedTurnRoles ?? []) {
    if (role !== 'human' && role !== 'assistant') {
      throw new TypeError("requiredCitedTurnRoles accepts only 'human' and 'assistant'")
    }
  }
  resolveTraceAnalystLimits(definition.limits)
}

function deriveQuestion(context: AnalystContext, definition: TraceAnalystDefinition): string {
  const supplied =
    typeof definition.question === 'function' ? definition.question(context) : definition.question
  const base =
    supplied?.trim() ||
    `Analyze this trace dataset and report ${definition.area} findings. ${definition.description}`
  const focus = context.tags?.focus?.trim()
  return focus ? `${base}\nFocus: ${focus}` : base
}

function toAnalystFinding(
  definition: TraceAnalystDefinition,
  version: string,
  raw: RawAnalystFinding,
  metadata: Record<string, unknown>,
): AnalystFinding {
  return makeFinding({
    analyst_id: definition.id,
    area: definition.area,
    subject: raw.subject,
    claim: raw.claim,
    rationale: raw.rationale,
    severity: raw.severity,
    confidence: raw.confidence,
    evidence_refs: evidenceRefsFromRawFinding(raw),
    recommended_action: raw.recommended_action,
    metadata: { definition_version: version, ...metadata },
  })
}

export function renderPriorFindings(prior: AnalystContext['priorFindings']): string {
  if (!prior || prior.length === 0) return ''
  const maxRows = 40
  const rows = prior.slice(0, maxRows).map((finding) => {
    const subject = finding.subject ? ` [${finding.subject}]` : ''
    return `- id=${finding.finding_id} ${finding.severity}${subject} ${truncateForContext(finding.claim, 160)}`
  })
  if (prior.length > maxRows) rows.push(`- ${prior.length - maxRows} older findings omitted`)
  return [
    'PRIOR FINDINGS:',
    'Reuse a matching finding id through id_basis and raise confidence only when current evidence confirms recurrence.',
    ...rows,
  ].join('\n')
}

export function renderUpstreamFindings(upstream: AnalystContext['upstreamFindings']): string {
  if (!upstream || upstream.length === 0) return ''
  const maxRows = 40
  const rows = upstream.slice(0, maxRows).map((finding) => {
    const subject = finding.subject ? ` [${finding.subject}]` : ''
    const evidence = finding.evidence_refs[0]?.uri
      ? ` evidence=${truncateForContext(finding.evidence_refs[0].uri, 120)}`
      : ''
    return `- id=${finding.finding_id} source=${finding.analyst_id} ${finding.severity}${subject} claim=${truncateForContext(finding.claim, 160)}${evidence}`
  })
  if (upstream.length > maxRows) {
    rows.push(`- ${upstream.length - maxRows} additional upstream findings omitted`)
  }
  return [
    'UPSTREAM FINDINGS:',
    'Build on these findings instead of repeating them. Cite dependencies as finding://<id>.',
    ...rows,
  ].join('\n')
}

function truncateForContext(value: string, max: number): string {
  if (value.length <= max) return value
  return `${value.slice(0, max - 3).trimEnd()}...`
}
