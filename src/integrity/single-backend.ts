/**
 * Single-backend guard: assert the agent and the rubric judge run through the
 * SAME backend config, so the judge can't silently re-route through a
 * different (often paid) backend than the agent.
 *
 * The bug class: `--backend cli-bridge` rewires the agent, but the judge still
 * reads `process.env.TANGLE_API_KEY` → router. Cost is billed against the
 * router, the eval reports the cli-bridge model, and the data is unusable.
 * Four consumers hand-roll this comparison (legal at `canonical.ts:702-795`);
 * this is the one substrate copy.
 *
 * Complements `assertRealBackend` (records → stub vs real) and
 * `assertCrossFamily` (judge-ensemble family diversity): this one compares two
 * backend *configs* before the run.
 */

import { AgentEvalError } from '../errors'

/**
 * Minimal backend-config shape the assertion reads. Consumers may pass richer
 * types — only these five fields are inspected.
 */
export interface BackendDescriptor {
  /** Backend route — e.g. `'tcloud' | 'cli-bridge' | 'sandbox' | 'direct-provider'`;
   *  free-form for consumer extensibility. */
  kind: string
  /** Resolved base URL. Compared lexically (trailing slash stripped). */
  baseUrl: string
  /** Model id (with snapshot suffix). Compared lexically. */
  model: string
  /** Optional provider override. Compared when both set; flagged when only
   *  one side sets it. */
  provider?: string
  /** Bearer token. Values are NEVER compared (security) — only that EITHER
   *  both are set OR both are empty. Mismatched presence is a divergence. */
  apiKey?: string
}

export interface AssertSingleBackendOptions {
  /** When true, ANY field divergence fails. When false (default), only
   *  `kind` / `baseUrl` / `provider` / `apiKeyPresence` divergence throws —
   *  a different judge `model` on the same route is allowed (the legal
   *  pattern: a cheaper judge model). */
  strict?: boolean
  agentLabel?: string
  judgeLabel?: string
}

export type SingleBackendField = 'kind' | 'baseUrl' | 'model' | 'provider' | 'apiKeyPresence'

export interface SingleBackendDivergence {
  field: SingleBackendField
  agent: string | undefined
  judge: string | undefined
}

export interface SingleBackendReport {
  /** True when agent + judge agree per the configured strictness. */
  ok: boolean
  /** Every divergence detected (includes `model` even when non-blocking). */
  divergences: ReadonlyArray<SingleBackendDivergence>
}

export class SingleBackendError extends AgentEvalError {
  constructor(
    message: string,
    public readonly report: SingleBackendReport,
  ) {
    super('backend_integrity', message)
    this.name = 'SingleBackendError'
  }
}

function stripSlash(url: string): string {
  return url.replace(/\/+$/, '')
}

/**
 * Throw `SingleBackendError` when the agent and judge backends diverge in a
 * way that would re-route the judge through a different backend than the
 * agent. Returns the report so callers can log it in either case.
 */
export function assertSingleBackend(
  agent: BackendDescriptor,
  judge: BackendDescriptor,
  opts: AssertSingleBackendOptions = {},
): SingleBackendReport {
  const divergences: SingleBackendDivergence[] = []

  if (agent.kind !== judge.kind) {
    divergences.push({ field: 'kind', agent: agent.kind, judge: judge.kind })
  }
  if (stripSlash(agent.baseUrl) !== stripSlash(judge.baseUrl)) {
    divergences.push({ field: 'baseUrl', agent: agent.baseUrl, judge: judge.baseUrl })
  }
  if (agent.model !== judge.model) {
    divergences.push({ field: 'model', agent: agent.model, judge: judge.model })
  }
  // provider: compare when both set; flag when exactly one is set.
  if (agent.provider !== judge.provider) {
    divergences.push({ field: 'provider', agent: agent.provider, judge: judge.provider })
  }
  // apiKey: presence only, never the value.
  const agentHasKey = Boolean(agent.apiKey)
  const judgeHasKey = Boolean(judge.apiKey)
  if (agentHasKey !== judgeHasKey) {
    divergences.push({
      field: 'apiKeyPresence',
      agent: agentHasKey ? 'set' : 'empty',
      judge: judgeHasKey ? 'set' : 'empty',
    })
  }

  const blocking = opts.strict ? divergences : divergences.filter((d) => d.field !== 'model')
  const ok = blocking.length === 0
  const report: SingleBackendReport = { ok, divergences }

  if (!ok) {
    const agentLabel = opts.agentLabel ?? 'agent'
    const judgeLabel = opts.judgeLabel ?? 'judge'
    const detail = blocking
      .map((d) => `${d.field}: ${agentLabel}=${d.agent ?? '∅'} vs ${judgeLabel}=${d.judge ?? '∅'}`)
      .join('; ')
    throw new SingleBackendError(
      `single-backend: ${agentLabel} and ${judgeLabel} backends diverge — the judge would ` +
        `re-route through a different backend than the agent (${detail})`,
      report,
    )
  }

  return report
}
