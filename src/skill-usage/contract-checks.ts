/**
 * A recorded session checked against trace contracts while it is read.
 *
 * The readers already hold each session's normalized form, so a caller that
 * passes contracts gets each session's verdict counts on its record without a
 * second read: for example, how often a session broke each rule of a
 * procedure contract. The checker is the one trajectory-contract checker.
 */

import type { HarnessSession } from '@tangle-network/harness-sessions'
import { evaluateTraceContract } from '../trace-contracts/evaluate'
import { contractSpansFromHarnessSession } from '../trace-contracts/harness-session'
import type { TraceContract } from '../trace-contracts/types'
import type { SessionContractCheck } from './session-record'

export function checkSessionContracts(
  session: HarnessSession,
  contracts: readonly TraceContract[],
): SessionContractCheck[] {
  const spans = contractSpansFromHarnessSession(session)
  return contracts.map((contract) => {
    const verdict = evaluateTraceContract(contract, spans)
    const violations: Record<string, number> = {}
    for (const violation of verdict.violations)
      violations[violation.rule] = (violations[violation.rule] ?? 0) + 1
    return { contract: verdict.contract, status: verdict.status, violations, errors: verdict.errors }
  })
}
