import { CostLedger } from '../cost-ledger'
import type { TraceAnalysisStore } from '../trace-analyst/store'
import type { TraceAnalysisEngine, TraceAnalysisEngineResult, TraceAnalystLimits } from './engine'
import { resolveTraceAnalystLimits } from './engine'
import {
  evidenceRefsFromRawFinding,
  parseRawFinding,
  parseTraceSpanEvidenceUri,
  RAW_FINDING_SCHEMA_PROMPT,
  type RawAnalystFinding,
} from './finding-signature'
import { KIND_EXPECTED_SUBJECTS, parseFindingSubject } from './finding-subject'
import { buildTraceToolsForGroup, type TraceToolGroupName } from './tool-groups'
import type { Analyst, AnalystContext, AnalystFinding } from './types'
import { makeFinding } from './types'
import { settleUsageReceiptFromCostLedger, validateUsageSettlementTimeout } from './usage-receipt'

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
  requireStructuredFindings?: boolean
}

export interface CreateTraceAnalystOptions {
  engine: TraceAnalysisEngine
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
): Analyst<TraceAnalysisStore> {
  validateDefinition(definition)
  const version = options.versionSuffix
    ? `${definition.version}+${options.versionSuffix}`
    : definition.version
  return {
    id: definition.id,
    description: definition.description,
    inputKind: 'trace-store',
    cost: {
      kind: 'llm',
      ...(options.engine.model ? { models: [options.engine.model] } : {}),
      settlement_timeout_ms: validateUsageSettlementTimeout(options.settlementTimeoutMs),
    },
    version,
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
    if (!(await evidenceIsResolvable(validated, store, context))) continue
    accepted.push(validated)
  }
  return accepted
}

async function evidenceIsResolvable(
  finding: RawAnalystFinding,
  store: TraceAnalysisStore,
  context: AnalystContext,
): Promise<boolean> {
  const knownFindings = new Map(
    [...(context.priorFindings ?? []), ...(context.upstreamFindings ?? [])].map((entry) => [
      entry.finding_id,
      entry,
    ]),
  )
  for (const citation of finding.evidence) {
    if (citation.excerpt !== undefined && citation.excerpt.trim().length < MINIMUM_EXCERPT_LENGTH) {
      rejectEvidence(context, citation.uri, 'excerpt is too short to verify')
      return false
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
        return false
      }
      if (citation.excerpt !== undefined) {
        const viewed = await store.viewSpans(
          {
            trace_id: traceLocation.traceId,
            span_ids: [traceLocation.spanId],
          },
          storeContext,
        )
        const span = viewed.spans.find((entry) => entry.span_id === traceLocation.spanId)
        if (!span || !containsExactText([span.attributes, span.status_message], citation.excerpt)) {
          rejectEvidence(context, citation.uri, 'excerpt is not present in the cited span content')
          return false
        }
      }
      continue
    }

    const findingId = parseFindingEvidenceUri(citation.uri)
    const referenced = findingId ? knownFindings.get(findingId) : undefined
    if (!referenced) {
      rejectEvidence(context, citation.uri, 'citation is not a supplied finding or trace span')
      return false
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
      return false
    }
  }
  return true
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
