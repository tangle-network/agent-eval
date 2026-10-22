import type { Analysis } from './analyze-context'
import type { TotalUsd } from './analyze-spend'
import { parsePatch } from './patch-stats'
import {
  isUnavailable,
  type Measured,
  type OutcomeMetrics,
  type PatchStats,
  unavailable,
} from './types'

/** Terminal status, verdicts, judge result and the delivered patch. */
export function buildOutcome(a: Analysis, t: TotalUsd): OutcomeMetrics {
  const { src, gap, state, result, judge, terminal } = a
  const { stateResult } = t
  const patchStats: Measured<PatchStats> =
    src.patch === null
      ? gap('patch', src.limits.deliverables ?? 'delivered patch file absent')
      : parsePatch(src.patch)

  const outcome: OutcomeMetrics = {
    supStatus: isUnavailable(terminal.supStatus)
      ? gap('supStatus', terminal.supStatus.unavailable)
      : terminal.supStatus,
    supStatusSource: terminal.supStatusSource,
    supReason: terminal.supReason,
    failure: terminal.failure,
    supVerdict:
      pickString(state, 'verdict') ??
      pickString(result, 'sup_verdict') ??
      unavailable('no state.json / result.json verdict'),
    delivered:
      typeof stateResult.delivered === 'boolean'
        ? stateResult.delivered
        : typeof result?.delivered === 'boolean'
          ? result.delivered
          : unavailable('no delivered flag in state.json or result.json'),
    judgeResolved:
      judge === null
        ? gap('judge', 'judge.json absent')
        : typeof judge.resolved === 'boolean'
          ? judge.resolved
          : null,
    judgeScore:
      judge === null
        ? unavailable('judge.json absent')
        : typeof judge.score === 'number'
          ? judge.score
          : null,
    judgePassed:
      judge === null
        ? unavailable('judge.json absent')
        : typeof judge.passed === 'number'
          ? judge.passed
          : null,
    judgeTotal:
      judge === null
        ? unavailable('judge.json absent')
        : typeof judge.total === 'number'
          ? judge.total
          : null,
    verifyPass:
      typeof result?.verify_pass === 'boolean'
        ? result.verify_pass
        : gap('verifyPass', 'result.json absent or has no verify_pass'),
    verifyRc:
      typeof result?.verify_rc === 'number'
        ? result.verify_rc
        : unavailable('result.json absent or has no verify_rc'),
    patch: patchStats,
    judgeSource: src.judgeSource,
  }
  return outcome
}

function pickString(rec: Record<string, unknown> | null, key: string): string | null {
  const v = rec?.[key]
  return typeof v === 'string' ? v : null
}
