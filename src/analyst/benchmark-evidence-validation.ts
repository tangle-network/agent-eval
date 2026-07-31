import { TRACE_ANALYSIS_LIMITS, type TraceAnalysisStore } from '../trace-analyst/store'
import type { AnalystFinding, EvidenceRef } from './types'

const MIN_ACTION_EXCERPT_CHARACTERS = 12
export const MAX_ASSISTANT_STEP_EVIDENCE_EXCERPT_CHARACTERS = 512
const MAX_LABEL_SCAN_DEPTH = 64
const MAX_SERIALIZED_JSON_SCAN_BYTES = 64 * 1024
const MAX_SERIALIZED_JSON_SCAN_DEPTH = 8

const BENCHMARK_LABEL_KEYS = new Set([
  'category_reason',
  'failure_category',
  'failure_summary',
  'incorrect_stages',
  'incorrect_step_ids',
  'root_cause',
  'root_cause_failure_id',
  'root_cause_reason',
  'step_reason',
  'unuseful_step_ids',
])
const BENCHMARK_LABEL_KEY_TOKENS = [...BENCHMARK_LABEL_KEYS].sort(
  (left, right) => right.length - left.length,
)

const BENCHMARK_LABEL_PATH_MARKERS = [
  'bench_manifest.verified',
  'codetracer_labels.json',
  '/ground_truth/',
  '\\ground_truth\\',
] as const

export interface BenchmarkLabelLeakScan {
  passed: true
  scannedBytes: number
  scannedValues: number
}

export function assertNoBenchmarkLabelsInTrace(options: {
  traceId: string
  otlpText: string
}): BenchmarkLabelLeakScan {
  let scannedValues = 0
  for (const [index, line] of options.otlpText.split(/\r?\n/).entries()) {
    if (!line.trim()) continue
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch (error) {
      throw new TypeError(
        `trace '${options.traceId}' line ${index + 1} is invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    scannedValues += scanValue(value, options.traceId, `$line[${index + 1}]`, 0, 0)
  }
  if (scannedValues === 0) {
    throw new Error(`trace '${options.traceId}' contains no JSON values`)
  }
  return {
    passed: true,
    scannedBytes: Buffer.byteLength(options.otlpText),
    scannedValues,
  }
}

export function assertNoBenchmarkLabelsInArtifact(options: {
  traceId: string
  relativePath: string
  content: string
}): void {
  const normalizedPath = options.relativePath.toLowerCase()
  for (const marker of BENCHMARK_LABEL_PATH_MARKERS) {
    if (normalizedPath.includes(marker.toLowerCase())) {
      throw new Error(
        `trace '${options.traceId}' verification artifact path contains benchmark label marker '${marker}'`,
      )
    }
  }
  const normalizedContent = options.content.toLowerCase()
  for (const key of BENCHMARK_LABEL_KEYS) {
    if (normalizedContent.includes(key)) {
      throw new Error(
        `trace '${options.traceId}' verification artifact contains benchmark label key '${key}'`,
      )
    }
  }
  for (const marker of BENCHMARK_LABEL_PATH_MARKERS) {
    if (normalizedContent.includes(marker.toLowerCase())) {
      throw new Error(
        `trace '${options.traceId}' verification artifact contains benchmark label path marker '${marker}'`,
      )
    }
  }
}

export async function validateCodeTraceFindingEvidence(options: {
  trajectoryId: string
  findings: readonly AnalystFinding[]
  store: TraceAnalysisStore
  signal?: AbortSignal
}): Promise<void> {
  const citations = options.findings.flatMap((finding) =>
    finding.evidence_refs.map((evidence) => ({
      evidence,
      findingId: finding.finding_id,
      location: codeTraceStepFromEvidence(evidence.uri),
    })),
  )
  if (citations.length === 0) return

  for (const citation of citations) {
    if (!citation.location || citation.location.traceId !== options.trajectoryId) {
      throw new Error(
        `model finding '${citation.findingId}' cites non-case evidence '${citation.evidence.uri}'`,
      )
    }
  }

  const spanIds = [...new Set(citations.map((citation) => `step-${citation.location!.step}`))]
  const { spans, missing } = await fetchTraceSpans(options.store, {
    trajectoryId: options.trajectoryId,
    spanIds,
    ...(options.signal ? { signal: options.signal } : {}),
  })
  if (missing.length > 0) {
    throw new Error(
      `model finding evidence is unavailable in the case trace: ${missing.join(', ')}`,
    )
  }

  for (const citation of citations) {
    const spanId = `step-${citation.location!.step}`
    const span = spans.get(spanId)
    if (!span) {
      throw new Error(`model finding '${citation.findingId}' cites missing span '${spanId}'`)
    }
    if (span.kind !== 'LLM') {
      throw new Error(
        `model finding '${citation.findingId}' cites '${spanId}', which is ${span.kind}, not an assistant LLM span`,
      )
    }
    assertExactActionExcerpt(citation.findingId, citation.evidence, spanId, span.attributes.content)
  }
}

/**
 * Resolve assistant-step evidence for a trajectory.
 *
 * `steps` are claims the model made explicitly: an unresolvable one is a model
 * error and throws. `optionalSteps` are derived by the runner (a block's
 * interior, a block's consequence step), so an unresolvable one is simply
 * absent from the returned map and the caller decides what that means.
 */
export async function resolveAssistantStepEvidence(options: {
  trajectoryId: string
  steps: readonly number[]
  optionalSteps?: readonly number[]
  store: TraceAnalysisStore
  signal?: AbortSignal
}): Promise<Map<number, EvidenceRef>> {
  const required = [...new Set(options.steps)]
  const optional = [...new Set(options.optionalSteps ?? [])].filter(
    (step) => !required.includes(step),
  )
  for (const step of [...required, ...optional]) {
    if (!Number.isSafeInteger(step) || step < 1) {
      throw new TypeError(`assistant evidence step must be a positive safe integer: ${step}`)
    }
  }
  const steps = [...required, ...optional]
  if (steps.length === 0) return new Map()

  const { spans, missing } = await fetchTraceSpans(options.store, {
    trajectoryId: options.trajectoryId,
    spanIds: steps.map((step) => `step-${step}`),
    ...(options.signal ? { signal: options.signal } : {}),
  })
  const missingRequired = missing.filter((spanId) =>
    required.some((step) => `step-${step}` === spanId),
  )
  if (missingRequired.length > 0) {
    throw new Error(`model selected unavailable assistant steps: ${missingRequired.join(', ')}`)
  }

  const evidence = new Map<number, EvidenceRef>()
  for (const step of steps) {
    const spanId = `step-${step}`
    const optionalStep = optional.includes(step)
    const span = spans.get(spanId)
    if (!span) {
      if (optionalStep) continue
      throw new Error(`model selected missing assistant step '${spanId}'`)
    }
    if (span.kind !== 'LLM') {
      if (optionalStep) continue
      throw new Error(
        `model selected '${spanId}', which is ${span.kind}, not an assistant LLM span`,
      )
    }
    const content = span.attributes.content
    if (typeof content !== 'string' || content.trim().length === 0) {
      if (optionalStep) continue
      throw new Error(`model selected '${spanId}' without action content`)
    }
    evidence.set(step, {
      kind: 'span',
      uri: codeTraceStepEvidenceUri(options.trajectoryId, step),
      excerpt: content.trim().slice(0, MAX_ASSISTANT_STEP_EVIDENCE_EXCERPT_CHARACTERS),
    })
  }
  return evidence
}

/**
 * Read spans by id, paging over the store's byte-budget omissions.
 *
 * `omitted_span_ids` names spans that exist but did not fit the response
 * ceiling; the store guarantees at least one span lands per call, so
 * re-requesting exactly the omitted ids terminates. Only `missing_span_ids`
 * describes a span the trace does not contain.
 */
async function fetchTraceSpans(
  store: TraceAnalysisStore,
  options: { trajectoryId: string; spanIds: readonly string[]; signal?: AbortSignal },
): Promise<{
  spans: Map<string, Awaited<ReturnType<TraceAnalysisStore['viewSpans']>>['spans'][number]>
  missing: string[]
}> {
  const spans = new Map<
    string,
    Awaited<ReturnType<TraceAnalysisStore['viewSpans']>>['spans'][number]
  >()
  const missing: string[] = []
  const unique = [...new Set(options.spanIds)]
  const context = options.signal ? { signal: options.signal } : undefined
  for (let offset = 0; offset < unique.length; offset += TRACE_ANALYSIS_LIMITS.viewSpans) {
    let pending = unique.slice(offset, offset + TRACE_ANALYSIS_LIMITS.viewSpans)
    while (pending.length > 0) {
      const result = await store.viewSpans(
        { trace_id: options.trajectoryId, span_ids: pending },
        context,
      )
      for (const span of result.spans) spans.set(span.span_id, span)
      missing.push(...result.missing_span_ids)
      const omitted = result.omitted_span_ids.filter((spanId) => !spans.has(spanId))
      if (omitted.length >= pending.length) {
        throw new Error(
          `trace '${options.trajectoryId}' cannot project spans within the store response budget: ${omitted.join(', ')}`,
        )
      }
      pending = omitted
    }
  }
  return { spans, missing }
}

function scanValue(
  value: unknown,
  traceId: string,
  path: string,
  depth: number,
  serializedDepth: number,
): number {
  if (depth > MAX_LABEL_SCAN_DEPTH) {
    throw new Error(`trace '${traceId}' exceeds benchmark label scan depth at ${path}`)
  }
  if (Array.isArray(value)) {
    return (
      1 +
      value.reduce(
        (count, entry, index) =>
          count + scanValue(entry, traceId, `${path}[${index}]`, depth + 1, serializedDepth),
        0,
      )
    )
  }
  if (typeof value === 'object' && value !== null) {
    let count = 1
    for (const [key, entry] of Object.entries(value)) {
      if (BENCHMARK_LABEL_KEYS.has(key.toLowerCase())) {
        throw new Error(`trace '${traceId}' exposes benchmark label key '${key}' at ${path}`)
      }
      count += scanValue(entry, traceId, `${path}.${key}`, depth + 1, serializedDepth)
    }
    return count
  }
  if (typeof value === 'string') {
    const normalized = value.toLowerCase()
    const labelKey = BENCHMARK_LABEL_KEY_TOKENS.find((candidate) => normalized.includes(candidate))
    if (labelKey) {
      throw new Error(
        `trace '${traceId}' exposes benchmark label key '${labelKey}' inside a string at ${path}`,
      )
    }
    const marker = BENCHMARK_LABEL_PATH_MARKERS.find((candidate) => normalized.includes(candidate))
    if (marker) {
      throw new Error(
        `trace '${traceId}' exposes benchmark label path marker '${marker}' at ${path}`,
      )
    }
    const trimmed = value.trim()
    if (
      serializedDepth < MAX_SERIALIZED_JSON_SCAN_DEPTH &&
      Buffer.byteLength(trimmed) <= MAX_SERIALIZED_JSON_SCAN_BYTES &&
      looksLikeSerializedJson(trimmed)
    ) {
      let parsed: unknown
      try {
        parsed = JSON.parse(trimmed)
      } catch {
        return 1
      }
      return (
        1 + scanValue(parsed, traceId, `${path}<serialized-json>`, depth + 1, serializedDepth + 1)
      )
    }
  }
  return 1
}

function looksLikeSerializedJson(value: string): boolean {
  return (
    (value.startsWith('{') && value.endsWith('}')) ||
    (value.startsWith('[') && value.endsWith(']')) ||
    (value.startsWith('"') && value.endsWith('"'))
  )
}

export function codeTraceStepFromEvidence(uri: string): { traceId: string; step: number } | null {
  const match = /^trace:\/\/([^/]+)\/span\/step-(\d+)$/.exec(uri)
  if (!match) return null
  try {
    const traceId = decodeURIComponent(match[1]!)
    const step = Number(match[2])
    return traceId && Number.isSafeInteger(step) && step > 0 ? { traceId, step } : null
  } catch {
    return null
  }
}

export function codeTraceStepEvidenceUri(traceId: string, step: number): string {
  return `trace://${encodeURIComponent(traceId)}/span/step-${step}`
}

function assertExactActionExcerpt(
  findingId: string,
  evidence: EvidenceRef,
  spanId: string,
  content: unknown,
): void {
  if (typeof content !== 'string' || content.length === 0) {
    throw new Error(`model finding '${findingId}' cites '${spanId}' without action content`)
  }
  const excerpt = evidence.excerpt?.trim()
  if (!excerpt) {
    throw new Error(`model finding '${findingId}' must quote action content from '${spanId}'`)
  }
  const requiredLength = Math.min(MIN_ACTION_EXCERPT_CHARACTERS, content.trim().length)
  if (excerpt.length < requiredLength) {
    throw new Error(
      `model finding '${findingId}' excerpt for '${spanId}' is too short; expected at least ${requiredLength} characters`,
    )
  }
  if (!content.includes(excerpt)) {
    throw new Error(
      `model finding '${findingId}' excerpt is not present in '${spanId}' action content`,
    )
  }
}
