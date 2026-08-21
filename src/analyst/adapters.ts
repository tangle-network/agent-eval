/**
 * Adapter factory — lifts the semantic-concept judge into the Analyst
 * contract without re-implementing it.
 *
 * It builds an Analyst with a stable id (caller chooses; a default is given),
 * a version derived from the judge's version plus an adapter revision, and an
 * `analyze()` that calls the judge and lifts its output to `AnalystFinding[]`
 * through `makeFinding()`. The judge's `Severity` ('critical' | 'major' |
 * 'minor' | 'info') projects onto `AnalystSeverity`: 'major' becomes 'high'
 * and 'minor' becomes 'medium'.
 *
 * The adapter owns no state. Calling the factory twice is safe.
 */

import { CostLedger } from '../cost-ledger'
import type { Severity as LayerSeverity } from '../multi-layer-verifier'
import {
  runSemanticConceptJudge,
  SEMANTIC_CONCEPT_JUDGE_VERSION,
  type SemanticConceptJudgeInput,
  type SemanticConceptJudgeOptions,
  type SemanticConceptJudgeResult,
} from '../semantic-concept-judge'
import type { Analyst, AnalystFinding, AnalystSeverity } from './types'
import { makeFinding } from './types'
import { settleUsageReceiptFromCostLedger, validateUsageSettlementTimeout } from './usage-receipt'

const ADAPTER_REV = '1'

// ── Severity bridges ───────────────────────────────────────────────

function liftSeverity(s: LayerSeverity): AnalystSeverity {
  switch (s) {
    case 'critical':
      return 'critical'
    case 'major':
      return 'high'
    case 'minor':
      return 'medium'
    case 'info':
      return 'info'
  }
}

// ── SemanticConceptJudge → Analyst ─────────────────────────────────

export interface SemanticConceptJudgeAdapterOpts {
  id?: string
  area?: string
  /** Registry context owns cancellation and the per-analyst cost ledger. */
  options: Omit<SemanticConceptJudgeOptions, 'costLedger' | 'signal'>
  /** Maximum post-cancellation wait for a provider receipt. Default 5 seconds. */
  settlementTimeoutMs?: number
}

export function createSemanticConceptJudgeAdapter(
  opts: SemanticConceptJudgeAdapterOpts,
): Analyst<SemanticConceptJudgeInput> {
  const id = opts.id ?? 'semantic-concept-judge'
  const area = opts.area ?? 'concept-coverage'
  const settlementTimeoutMs = validateUsageSettlementTimeout(opts.settlementTimeoutMs)
  return {
    id,
    description:
      'Runs the semantic-concept judge and surfaces missing / weak concepts as findings.',
    inputKind: 'custom',
    cost: {
      kind: 'llm',
      models: opts.options.model ? [opts.options.model] : undefined,
      settlement_timeout_ms: settlementTimeoutMs,
    },
    version: `${SEMANTIC_CONCEPT_JUDGE_VERSION}-adapter-${ADAPTER_REV}`,
    async analyze(input, ctx) {
      const costLedger = new CostLedger(ctx.budgetUsd)
      let result: SemanticConceptJudgeResult
      try {
        result = await runSemanticConceptJudge(input, {
          ...opts.options,
          costLedger,
          signal: ctx.signal,
        })
      } finally {
        const usage = await settleUsageReceiptFromCostLedger(costLedger, {
          channel: 'judge',
          timeoutMs: settlementTimeoutMs,
        })
        if (!usage.settled) {
          ctx.log?.('semantic-concept judge provider settlement timed out', {
            pending_calls: usage.pendingCalls,
            timeout_ms: settlementTimeoutMs,
          })
        }
        ctx.recordUsage?.(usage.receipt)
      }
      if (!result.available) {
        return [
          makeFinding({
            analyst_id: id,
            area,
            claim: 'semantic-concept judge unavailable',
            rationale: result.error,
            severity: 'info',
            confidence: 1,
            evidence_refs: [],
            metadata: { reason: result.error },
          }),
        ]
      }
      const out: AnalystFinding[] = []
      for (const f of result.findings) {
        // Only surface gaps: missing concepts or low scores. Concepts at
        // 7+/10 with present=true are not findings — they're successes.
        if (f.present && f.score >= 7) continue
        out.push(
          makeFinding({
            analyst_id: id,
            area,
            subject: f.concept,
            claim: f.present
              ? `concept "${f.concept}" is weak (${f.score}/10)`
              : `concept "${f.concept}" is missing`,
            rationale: f.evidence,
            severity: liftSeverity(f.severity),
            confidence: 0.85,
            evidence_refs: [{ kind: 'artifact', uri: 'inline:evidence', excerpt: f.evidence }],
            metadata: {
              concept: f.concept,
              present: f.present,
              score_10: f.score,
            },
          }),
        )
      }
      return out
    },
  }
}
