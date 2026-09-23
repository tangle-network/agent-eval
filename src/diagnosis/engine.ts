/**
 * The agent-failure diagnosis engine: flat spans plus context in, a findings
 * document out.
 *
 * It is a plain function. Its only side effect is the model call made through
 * the caller's transport, and in deterministic mode it makes none. It keeps no
 * storage, files no issues, and retains nothing: where the spans came from and
 * where the findings go belong to the caller. That is what lets one engine
 * serve both the internal daily mining run and a customer diagnosis while their
 * data paths stay separate.
 *
 * Order of operations, each step reading only the previous step's output:
 *   1. secret filter and content drop over every input (spans, focus, topology);
 *   2. the deterministic pass: capability table, execution facts, observed findings;
 *   3. in model mode, the prime-protocol pass over the highest-signal runs;
 *   4. evidence resolution: every cited id must be a span id of the input that
 *      no other run shares; findings left without evidence are rejected.
 */

import { packageVersion } from '../package-version'
import { type DeterministicResult, groupByTrace, runDeterministicPass } from './deterministic'
import {
  type DiagnosisFinding,
  type DiagnosisFindingsDocument,
  SEVERITY_RANK,
  validateDiagnosisFindings,
} from './findings'
import {
  type DiagnosisModelOptions,
  type ModelQuestion,
  type ModelRejection,
  type ModelRowNote,
  type ModelRunRecord,
  runModelPass,
  runTopologyPass,
} from './model-pass'
import { redactSecrets, redactSecretsDeep } from './secret-filter'
import { type IngestReport, ingestSpans } from './spans'

export interface DiagnosisContext {
  /** Whose traces these are. Operator critique and topology run only for `internal`. */
  subject: 'internal' | 'customer'
  /** What was analysed, in the owner's words. Never an internal id for a customer. */
  label: string
  /** The owner's question, e.g. from the intake form. */
  focus?: string
  /**
   * Whether prompt, response and tool payload attributes may be read. Default
   * false: they are dropped before anything reads the spans.
   */
  contentIncluded?: boolean
  /** Project or repository names the runs belong to, for grouping questions. */
  projects?: string[]
  /** A run-graph summary (internal only), e.g. from the lineage graph. */
  topology?: { runs: Array<{ id: string } & Record<string, unknown>> } & Record<string, unknown>
}

export type DiagnosisOptions =
  | { mode: 'deterministic'; reason?: string; signal?: AbortSignal }
  | { mode: 'model'; model: DiagnosisModelOptions; signal?: AbortSignal }

export interface DiagnosisUsage {
  exchanges: number
  inputTokens: number | null
  outputTokens: number | null
  usd: number | null
}

export interface DiagnosisResult {
  /** Validates against diagnosis-findings-v1. The only part a customer report renders. */
  document: DiagnosisFindingsDocument
  /** Questions for the owner, grouped later by project. */
  questions: ModelQuestion[]
  /** Operator critique and topology notes; internal runs only. */
  notes: ModelRowNote[]
  /** The model's one-paragraph reading of each run it read. */
  summaries: Array<{ traceId: string; answer: string }>
  facts: DeterministicResult['facts']
  conformance: DeterministicResult['validation']['findings']
  ingest: IngestReport
  /** Model rows and findings dropped, each with why. */
  rejected: ModelRejection[]
  model: {
    used: boolean
    model: string | null
    runs: ModelRunRecord[]
    promptSha256: string | null
    usage: DiagnosisUsage
  }
  engine: { name: 'agent-eval/diagnosis'; version: string }
}

export const DEFAULT_MAX_MODEL_TRACES = 6

export async function diagnoseSpans(
  spans: readonly unknown[],
  context: DiagnosisContext,
  options: DiagnosisOptions,
): Promise<DiagnosisResult> {
  if (context.subject !== 'internal' && context.subject !== 'customer') {
    throw new TypeError(
      `diagnoseSpans: subject must be internal or customer, got ${String(context.subject)}`,
    )
  }
  if (context.subject === 'customer' && context.topology !== undefined) {
    throw new TypeError(
      'diagnoseSpans: topology analysis is internal only; a customer context must not carry one',
    )
  }
  const contentIncluded = context.contentIncluded === true
  const { spans: filtered, report: ingest } = ingestSpans(spans, { contentIncluded })
  const focus =
    context.focus === undefined ? undefined : redactSecrets(context.focus, ingest.secrets)
  const deterministic = runDeterministicPass(filtered)
  const skipped = [...deterministic.skipped]
  const ambiguous = new Set(ingest.ambiguousSpanIds)
  const rejected: ModelRejection[] = []
  const questions: ModelQuestion[] = []
  const notes: ModelRowNote[] = []
  const summaries: Array<{ traceId: string; answer: string }> = []
  const runs: ModelRunRecord[] = []
  let promptSha256: string | null = null
  let modelFindings: DiagnosisFinding[] = []

  const traces = groupByTrace(filtered)
  if (options.mode === 'deterministic') {
    skipped.push({
      analysis: 'model reading of the runs',
      reason: options.reason ?? 'deterministic mode: no model call was made',
    })
  } else {
    const maxTraces = options.model.maxTraces ?? DEFAULT_MAX_MODEL_TRACES
    const ranked = rankTraces(traces)
    const selected = ranked.slice(0, maxTraces)
    if (ranked.length > selected.length) {
      skipped.push({
        analysis: `model reading of ${ranked.length - selected.length} of ${ranked.length} runs`,
        reason: `the model reads at most ${maxTraces} runs per diagnosis, chosen by error count then size`,
      })
    }
    const pass = await runModelPass(
      selected,
      ambiguous,
      {
        subject: context.subject,
        contentIncluded,
        ...(focus ? { focus } : {}),
        ...(context.projects ? { projects: context.projects } : {}),
      },
      options.model,
      options.signal,
    )
    promptSha256 = pass.promptSha256
    modelFindings = pass.findings
    questions.push(...pass.questions)
    notes.push(...(context.subject === 'internal' ? pass.notes : []))
    summaries.push(...pass.summaries)
    rejected.push(...pass.rejected)
    runs.push(...pass.runs)
    for (const gap of pass.uncovered) {
      skipped.push({ analysis: `model reading of part of run ${gap.traceId}`, reason: gap.reason })
    }
    for (const run of pass.runs) {
      if (!run.ok)
        skipped.push({
          analysis: `model reading of run ${run.traceId}`,
          reason: run.failure ?? 'failed',
        })
    }
    if (context.subject === 'internal' && context.topology) {
      const topology = redactSecretsDeep(context.topology, ingest.secrets) as NonNullable<
        DiagnosisContext['topology']
      >
      const runIds = new Set(
        (topology.runs ?? [])
          .map((run) => run.id)
          .filter((id): id is string => typeof id === 'string'),
      )
      const reading = await runTopologyPass(topology, runIds, options.model, options.signal)
      notes.push(...reading.notes)
      questions.push(...reading.questions)
      rejected.push(...reading.rejected)
      runs.push(reading.run)
      if (!reading.run.ok)
        skipped.push({ analysis: 'topology reading', reason: reading.run.failure ?? 'failed' })
    }
  }

  const spanIds = new Set(filtered.map((span) => span.spanId))
  const findings = resolveEvidence(
    [...deterministic.findings, ...modelFindings],
    spanIds,
    ambiguous,
    rejected,
  ).sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      (a.confidence === b.confidence ? 0 : a.confidence === 'observed' ? -1 : 1),
  )

  const document: DiagnosisFindingsDocument = {
    schemaVersion: 1,
    subject: {
      label: context.label,
      runCount: traces.size,
      window: deterministic.window,
      contentIncluded,
    },
    coverage: {
      capabilities: deterministic.capabilities,
      skipped,
      redaction: {
        redactionCount: ingest.secrets.redactionCount,
        byRule: { ...ingest.secrets.byRule },
        droppedAttributes: ingest.droppedAttributes,
      },
    },
    findings,
  }
  const defects = validateDiagnosisFindings(document, { spanIds })
  if (defects.length > 0) {
    throw new Error(
      `diagnoseSpans produced an invalid findings document: ${defects.slice(0, 5).join('; ')}`,
    )
  }
  const pricing = options.mode === 'model' ? options.model.pricing : undefined
  return {
    document,
    questions,
    notes,
    summaries,
    facts: deterministic.facts,
    conformance: deterministic.validation.findings,
    ingest,
    rejected,
    model: {
      used: options.mode === 'model',
      model: options.mode === 'model' ? options.model.model : null,
      runs,
      promptSha256,
      usage: totalUsage(runs, pricing),
    },
    engine: { name: 'agent-eval/diagnosis', version: packageVersion() },
  }
}

/** Runs with more errors first, then larger runs; runs under three spans carry too little to read. */
function rankTraces(traces: ReadonlyMap<string, import('./spans').DiagnosisSpan[]>) {
  return [...traces.entries()]
    .filter(([, spans]) => spans.length >= 3)
    .map(([traceId, spans]) => ({
      traceId,
      spans,
      errors: spans.filter((span) => span.status === 'ERROR').length,
    }))
    .sort(
      (a, b) =>
        b.errors - a.errors ||
        b.spans.length - a.spans.length ||
        a.traceId.localeCompare(b.traceId),
    )
}

function resolveEvidence(
  findings: DiagnosisFinding[],
  spanIds: ReadonlySet<string>,
  ambiguous: ReadonlySet<string>,
  rejected: ModelRejection[],
): DiagnosisFinding[] {
  const kept: DiagnosisFinding[] = []
  for (const finding of findings) {
    const evidence = finding.evidence.filter((id) => spanIds.has(id) && !ambiguous.has(id))
    if (evidence.length === 0) {
      rejected.push({
        reason: `finding ${finding.id} lost all evidence: its span ids are missing or shared by several runs`,
      })
      continue
    }
    kept.push({ ...finding, evidence })
  }
  return kept
}

function totalUsage(
  runs: readonly ModelRunRecord[],
  pricing: DiagnosisModelOptions['pricing'],
): DiagnosisUsage {
  let inputTokens: number | null = 0
  let outputTokens: number | null = 0
  let exchanges = 0
  for (const run of runs) {
    if (
      run.usage.calls === null &&
      run.usage.inputTokens === null &&
      run.usage.outputTokens === null &&
      !run.ok
    )
      continue
    exchanges += 1
    inputTokens =
      inputTokens === null || run.usage.inputTokens === null
        ? null
        : inputTokens + run.usage.inputTokens
    outputTokens =
      outputTokens === null || run.usage.outputTokens === null
        ? null
        : outputTokens + run.usage.outputTokens
  }
  const usd =
    pricing && inputTokens !== null && outputTokens !== null
      ? (inputTokens * pricing.inputUsdPerMillion + outputTokens * pricing.outputUsdPerMillion) /
        1_000_000
      : null
  return {
    exchanges,
    inputTokens: exchanges === 0 ? 0 : inputTokens,
    outputTokens: exchanges === 0 ? 0 : outputTokens,
    usd,
  }
}
