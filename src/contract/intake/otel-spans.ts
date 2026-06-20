/**
 * # `intake/otel-spans` — OTel `TraceSpanEvent[]` → `RunRecord[]`.
 *
 * Turns an existing observability stream into the substrate-canonical
 * `RunRecord` shape so consumers with logs but no eval discipline can
 * call `analyzeRuns()` against their production traffic immediately.
 *
 * Pivot rule: spans are grouped by `tangle.runId` (the same attribute the
 * hosted-tier wire format uses) or, when absent, by `traceId`. One group
 * becomes one `RunRecord`. The root span (no `parentSpanId`) supplies:
 *
 *   - `runId` (the group key)
 *   - `wallMs` from `endTimeUnixNano - startTimeUnixNano`
 *   - `model` from `gen_ai.request.model` / `llm.model` / `tangle.model`
 *   - cost from `cost.usd` / `gen_ai.usage.cost_usd` / `tangle.cost.usd`
 *   - token usage from `gen_ai.usage.{input,output}_tokens`
 *   - `outcome.searchScore` from `tangle.score` / `eval.score` when
 *     present; `outcome.raw` collects every numeric attribute.
 *
 * Spans that ERRORed (`status.code === 'ERROR'`) populate `failureMode`
 * with their `name` so `analyzeRuns()`'s failure clustering sees them.
 */

import type { TraceSpanEvent } from '../../hosted/types'
import type {
  JudgeScoresRecord,
  RunOutcome,
  RunRecord,
  RunSplitTag,
  RunTokenUsage,
} from '../../run-record'
import {
  LLM_INPUT_TOKEN_ATTR_KEYS,
  LLM_MODEL_ATTR_KEYS,
  LLM_OUTPUT_TOKEN_ATTR_KEYS,
} from '../../trace/otlp-attributes'

const SCORE_KEYS = ['tangle.score', 'eval.score', 'score']
const MODEL_KEYS = ['tangle.model', ...LLM_MODEL_ATTR_KEYS, 'model']
const COST_KEYS = ['tangle.cost.usd', 'gen_ai.usage.cost_usd', 'cost.usd', 'cost']
const INPUT_TOKEN_KEYS = [...LLM_INPUT_TOKEN_ATTR_KEYS, 'tangle.tokens.in', 'tokens.in']
const OUTPUT_TOKEN_KEYS = [...LLM_OUTPUT_TOKEN_ATTR_KEYS, 'tangle.tokens.out', 'tokens.out']
const PROMPT_HASH_KEYS = ['tangle.prompt_hash', 'prompt.hash']
const CONFIG_HASH_KEYS = ['tangle.config_hash', 'config.hash']

export interface FromOtelSpansOptions {
  spans: TraceSpanEvent[]
  /** Default split tag for synthesized records. Defaults to `'holdout'`. */
  defaultSplit?: RunSplitTag
  /** Default `experimentId` when not present on any span. */
  experimentId?: string
}

export function fromOtelSpans(opts: FromOtelSpansOptions): RunRecord[] {
  const { spans, defaultSplit = 'holdout', experimentId = 'otel-corpus' } = opts
  const grouped = groupSpans(spans)

  const runs: RunRecord[] = []
  for (const [groupKey, groupSpans] of grouped) {
    const root = findRoot(groupSpans)
    if (!root) continue

    const wallMs = Math.max(0, (root.endTimeUnixNano - root.startTimeUnixNano) / 1_000_000)
    const model = readAttrString(groupSpans, MODEL_KEYS) ?? 'unknown@unknown'
    const costUsd = readAttrNumber(groupSpans, COST_KEYS) ?? 0
    const inputTokens = readAttrNumber(groupSpans, INPUT_TOKEN_KEYS) ?? 0
    const outputTokens = readAttrNumber(groupSpans, OUTPUT_TOKEN_KEYS) ?? 0
    const promptHash = readAttrString(groupSpans, PROMPT_HASH_KEYS) ?? 'sha256:unknown'
    const configHash = readAttrString(groupSpans, CONFIG_HASH_KEYS) ?? 'sha256:unknown'
    const score = readAttrNumber(groupSpans, SCORE_KEYS)

    const rawNumeric = collectNumericAttrs(groupSpans)
    const tokenUsage: RunTokenUsage = {
      input: inputTokens,
      output: outputTokens,
    }

    const judgeScores: JudgeScoresRecord | undefined =
      score !== undefined
        ? {
            perJudge: { 'otel-derived': { score } },
            perDimMean: { score },
            composite: score,
          }
        : undefined

    const errorSpan = groupSpans.find((s) => s.status?.code === 'ERROR')
    const outcome: RunOutcome = {
      ...(opts.defaultSplit === 'search' ? { searchScore: score } : { holdoutScore: score }),
      raw: rawNumeric,
      ...(judgeScores ? { judgeScores } : {}),
    }

    runs.push({
      runId: groupKey,
      experimentId,
      candidateId: (root.attributes['tangle.candidateId'] as string | undefined) ?? 'otel-default',
      seed: 0,
      model,
      promptHash,
      configHash,
      commitSha: (root.attributes['tangle.commit_sha'] as string | undefined) ?? 'unknown',
      wallMs,
      costUsd,
      tokenUsage,
      outcome,
      splitTag: defaultSplit,
      ...(errorSpan ? { failureMode: errorSpan.name } : {}),
    } as RunRecord)
  }
  return runs
}

// ── Internal helpers ────────────────────────────────────────────────

function groupSpans(spans: TraceSpanEvent[]): Map<string, TraceSpanEvent[]> {
  const m = new Map<string, TraceSpanEvent[]>()
  for (const span of spans) {
    const key = (span['tangle.runId'] as string | undefined) ?? span.traceId
    const list = m.get(key) ?? []
    list.push(span)
    m.set(key, list)
  }
  return m
}

function findRoot(group: TraceSpanEvent[]): TraceSpanEvent | undefined {
  return group.find((s) => !s.parentSpanId) ?? group[0]
}

function readAttrString(spans: TraceSpanEvent[], keys: string[]): string | undefined {
  for (const span of spans) {
    for (const key of keys) {
      const v = span.attributes[key]
      if (typeof v === 'string' && v.length > 0) return v
    }
  }
  return undefined
}

function readAttrNumber(spans: TraceSpanEvent[], keys: string[]): number | undefined {
  for (const span of spans) {
    for (const key of keys) {
      const v = span.attributes[key]
      if (typeof v === 'number' && Number.isFinite(v)) return v
      if (typeof v === 'string') {
        const parsed = Number(v)
        if (Number.isFinite(parsed)) return parsed
      }
    }
  }
  return undefined
}

function collectNumericAttrs(spans: TraceSpanEvent[]): Record<string, number> {
  const raw: Record<string, number> = {}
  for (const span of spans) {
    for (const [k, v] of Object.entries(span.attributes)) {
      if (typeof v === 'number' && Number.isFinite(v)) raw[k] = v
    }
  }
  return raw
}
