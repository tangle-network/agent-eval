/**
 * Many questions over one trace store, concurrently, under one cost ledger, with an independent
 * verifier for every finding.
 *
 * `traces ask` answered questions this way for people. A continuation panel (agent-runtime,
 * discovery `docs/38-one-loop-and-continuation.md`, section 5) asks dozens to hundreds of atomic
 * questions of a director's own trace every time the outside check fails, so the runner lives here,
 * beside `runTraceAnalyst`, where both callers reach one implementation.
 *
 * Each question is one `runTraceAnalyst` call, which already refuses a finding with fewer distinct
 * citations than required or with a citation the store cannot resolve. What this module adds:
 *
 *  - a worker pool: at most `concurrency` investigations at once, and one failed question never
 *    stops the others; its failure is its answer;
 *  - one shared `CostLedger`, so a single ceiling bounds every question and every verifier;
 *  - an independent verifier per admitted finding, shown only the spans the finding cites. Analysts
 *    misattribute often: the best method in Who&When found the failing step 14.2% of the time. A
 *    finding a verifier reading only its own evidence does not support never reaches a caller as
 *    verified.
 */

import type { CostLedgerHandle } from '../cost-ledger'
import type { TraceAnalysisStore } from '../trace-analyst/store'
import { defineTraceAnalyst } from './define'
import type { TraceAnalysisEngine, TraceAnalystLimits } from './engine'
import { parseTraceSpanEvidenceUri, type RawAnalystFinding } from './finding-signature'
import { runTraceAnalyst } from './kind-factory'

/** One question to ask of the store. */
export interface TraceQuestionSpec {
  /** Stable id: letters, digits, dot, underscore, hyphen. */
  readonly id: string
  readonly question: string
  /** Guidance for this question only, after the shared rules. */
  readonly instructions?: string
}

export interface AskTraceQuestionsOptions {
  readonly questions: readonly TraceQuestionSpec[]
  readonly store: TraceAnalysisStore
  readonly engine: TraceAnalysisEngine
  /** Every question and verifier charges this ledger; its ceiling bounds the whole call. */
  readonly costLedger: CostLedgerHandle
  /** Stable id for cost attribution and logs. */
  readonly runId: string
  /** Material every question receives before its first model call, such as the check's verdict. */
  readonly context?: string
  /** Investigations running at once. Default 4. */
  readonly concurrency?: number
  /** Distinct citations a finding needs. Default 2. */
  readonly minimumEvidenceCitations?: number
  /** Run the independent verifier on every admitted finding. Default true. */
  readonly verify?: boolean
  readonly limits?: Partial<TraceAnalystLimits>
  readonly signal?: AbortSignal
  readonly log?: (message: string, fields?: Record<string, unknown>) => void
}

/** A finding and what the verifier, shown only its cited spans, concluded. */
export interface VerifiedTraceFinding {
  readonly finding: RawAnalystFinding
  /** The finding's trace citations, as `trace://` URIs. */
  readonly citations: readonly string[]
  /** `true` supported, `false` not supported, `null` when verification was off or failed. */
  readonly verified: boolean | null
  /** The verifier's own words, when it answered. */
  readonly verifierAnswer?: string
}

export interface TraceQuestionOutcome {
  readonly id: string
  readonly question: string
  readonly status: 'answered' | 'failed'
  readonly failure?: string
  /** The engine's prose answer, verbatim; `null` when it returned none. */
  readonly answer: string | null
  readonly findings: readonly VerifiedTraceFinding[]
  /** `null` when the engine failed before reporting. */
  readonly modelCalls: number | null
  readonly toolCalls: number | null
}

const QUESTION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u
const DEFINITION_VERSION = '1.0.0'

const QUESTION_RULES = [
  'Answer QUESTION only from trace tool results retrieved in this run.',
  'Cite each fact as trace://<trace_id>/span/<span_id>, and quote the span in the excerpt.',
  'If the trace does not record a fact, say "not in trace". Never infer a trace fact from the question.',
].join('\n')

const VERIFIER_RULES = [
  'You check one CLAIM against the spans it cites, and nothing else.',
  'Read each cited span with viewSpans. No other trace is readable.',
  'First line: SUPPORTED if the spans themselves establish the claim, otherwise NOT SUPPORTED.',
  'Second line: one sentence naming the span that decides it.',
  'Return no findings.',
].join('\n')

/**
 * Ask every question, then verify every admitted finding. Never throws for a failed question or
 * verifier: each failure is recorded on its outcome. Throws before any model call for a malformed
 * question list or options.
 */
export async function askTraceQuestions(
  opts: AskTraceQuestionsOptions,
): Promise<TraceQuestionOutcome[]> {
  const concurrency = opts.concurrency ?? 4
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
    throw new RangeError('askTraceQuestions: concurrency must be an integer >= 1')
  }
  const minimum = opts.minimumEvidenceCitations ?? 2
  if (!Number.isSafeInteger(minimum) || minimum < 1) {
    throw new RangeError('askTraceQuestions: minimumEvidenceCitations must be an integer >= 1')
  }
  const seen = new Set<string>()
  for (const question of opts.questions) {
    if (!QUESTION_ID.test(question.id)) {
      throw new TypeError(
        `askTraceQuestions: question id ${JSON.stringify(question.id)} is malformed`,
      )
    }
    if (seen.has(question.id)) {
      throw new TypeError(`askTraceQuestions: duplicate question id ${JSON.stringify(question.id)}`)
    }
    seen.add(question.id)
    if (question.question.trim() === '') {
      throw new TypeError(`askTraceQuestions: question ${question.id} is empty`)
    }
  }

  const askOne = async (question: TraceQuestionSpec): Promise<TraceQuestionOutcome> => {
    if (opts.signal?.aborted) {
      return failed(question, 'the run was aborted before the question started')
    }
    let completed: Awaited<ReturnType<typeof runTraceAnalyst>>
    try {
      completed = await runTraceAnalyst({
        definition: defineTraceAnalyst({
          id: `question.${question.id}`,
          description: `trace question ${question.id}`,
          area: 'question',
          version: DEFINITION_VERSION,
          question: question.question.trim(),
          instructions: [QUESTION_RULES, question.instructions?.trim() ?? '']
            .filter(Boolean)
            .join('\n\n'),
          toolGroup: 'all',
          minimumEvidenceCitations: minimum,
          ...(opts.context ? { prepareContext: () => opts.context } : {}),
          ...(opts.limits ? { limits: opts.limits } : {}),
        }),
        engine: opts.engine,
        store: opts.store,
        context: {
          runId: opts.runId,
          correlationId: `${opts.runId}:${question.id}`,
          costLedger: opts.costLedger,
          costPhase: 'trace-question',
          ...(opts.signal ? { signal: opts.signal } : {}),
          ...(opts.log ? { log: opts.log } : {}),
        },
      })
    } catch (error) {
      return failed(question, errorText(error))
    }
    const findings: VerifiedTraceFinding[] = []
    for (const [index, finding] of completed.findings.entries()) {
      const citations = finding.evidence
        .map((citation) => citation.uri.trim())
        .filter((uri) => parseTraceSpanEvidenceUri(uri) !== null)
      findings.push(
        opts.verify === false
          ? { finding, citations, verified: null }
          : await verifyFinding(opts, `${question.id}.v${index + 1}`, finding, citations),
      )
    }
    const answer = completed.answer.trim() === '' ? null : completed.answer
    return {
      id: question.id,
      question: question.question,
      status: 'answered',
      answer,
      findings,
      modelCalls: completed.modelCalls,
      toolCalls: completed.toolCalls,
    }
  }

  // A pool, not Promise.all: at most `concurrency` engines exist at once.
  const outcomes = new Array<TraceQuestionOutcome>(opts.questions.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(concurrency, opts.questions.length) }, async () => {
      while (next < opts.questions.length) {
        const index = next
        next += 1
        const question = opts.questions[index] as TraceQuestionSpec
        outcomes[index] = await askOne(question)
      }
    }),
  )
  return outcomes
}

/** The verifier reads only the spans the finding cites, through a store that holds nothing else. */
async function verifyFinding(
  opts: AskTraceQuestionsOptions,
  id: string,
  finding: RawAnalystFinding,
  citations: readonly string[],
): Promise<VerifiedTraceFinding> {
  const allowed = new Map<string, Set<string>>()
  for (const uri of citations) {
    const location = parseTraceSpanEvidenceUri(uri)
    if (location === null) continue
    const spans = allowed.get(location.traceId) ?? new Set<string>()
    spans.add(location.spanId)
    allowed.set(location.traceId, spans)
  }
  if (allowed.size === 0) return { finding, citations, verified: false }
  try {
    const verdict = await runTraceAnalyst({
      definition: defineTraceAnalyst({
        id: `verify.${id}`,
        description: `independent check of finding ${id}`,
        area: 'question',
        version: DEFINITION_VERSION,
        question: `CLAIM: ${finding.claim}\nCITED SPANS: ${citations.join(', ')}`,
        instructions: VERIFIER_RULES,
        toolGroup: 'targeted',
        ...(opts.limits ? { limits: opts.limits } : {}),
      }),
      engine: opts.engine,
      store: citedSpansOnly(opts.store, allowed),
      context: {
        runId: opts.runId,
        correlationId: `${opts.runId}:verify:${id}`,
        costLedger: opts.costLedger,
        costPhase: 'trace-question-verifier',
        ...(opts.signal ? { signal: opts.signal } : {}),
        ...(opts.log ? { log: opts.log } : {}),
      },
    })
    const first = verdict.answer.trim().split('\n')[0]?.trim().toUpperCase() ?? ''
    return {
      finding,
      citations,
      verified: first.startsWith('SUPPORTED'),
      verifierAnswer: verdict.answer.trim(),
    }
  } catch (error) {
    opts.log?.('verifier failed', { finding: id, error: errorText(error) })
    return { finding, citations, verified: null }
  }
}

/**
 * A store that exposes exactly the cited spans. Discovery and whole-trace reads refuse, so the
 * verifier cannot go looking for other support; the underlying store's bounds still apply.
 */
export function citedSpansOnly(
  store: TraceAnalysisStore,
  allowed: ReadonlyMap<string, ReadonlySet<string>>,
): TraceAnalysisStore {
  const refuse = (what: string) => async (): Promise<never> => {
    throw new Error(`${what} is not available to a verifier: read the cited spans with viewSpans`)
  }
  return {
    hasTrace: async (traceId) => allowed.has(traceId),
    hasSpans: async (input, context) => {
      const spans = allowed.get(input.trace_id)
      if (spans === undefined) return []
      return store.hasSpans(
        { trace_id: input.trace_id, span_ids: input.span_ids.filter((span) => spans.has(span)) },
        context,
      )
    },
    getOverview: refuse('getOverview'),
    queryTraces: refuse('queryTraces'),
    countTraces: refuse('countTraces'),
    viewTrace: refuse('viewTrace'),
    viewSpans: async (input, context) => {
      const spans = allowed.get(input.trace_id)
      const wanted = input.span_ids.filter((span) => spans?.has(span) === true)
      if (wanted.length === 0) {
        throw new Error('viewSpans: only the cited spans are readable')
      }
      return store.viewSpans({ ...input, span_ids: wanted }, context)
    },
    searchTrace: refuse('searchTrace'),
    searchSpan: async (input, context) => {
      if (allowed.get(input.trace_id)?.has(input.span_id) !== true) {
        throw new Error('searchSpan: only the cited spans are readable')
      }
      return store.searchSpan(input, context)
    },
  }
}

function failed(question: TraceQuestionSpec, failure: string): TraceQuestionOutcome {
  return {
    id: question.id,
    question: question.question,
    status: 'failed',
    failure,
    answer: null,
    findings: [],
    modelCalls: null,
    toolCalls: null,
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}
