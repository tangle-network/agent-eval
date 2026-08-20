/**
 * Served-model identity: prove the model that ANSWERED is the model that was
 * REQUESTED.
 *
 * A routing gateway can accept `model: "gpt-4.1-mini"` and answer from a
 * different model entirely. Every guard that reasons about the requested id —
 * cross-family judge diversity, per-model leaderboard rows, non-self-judging
 * exclusions, cost attribution — then passes while measuring something else.
 * The requested id is an intent; only the id echoed on the response is
 * evidence.
 *
 * `checkServedModel` classifies one requested/served pair; `assertServedModel`
 * and `assertServedModels` are the fail-loud gates; `assertCrossFamilyServed`
 * is the family-diversity rule computed over SERVED ids (the requested-id
 * version lives in ../judge-families and cannot see substitution).
 *
 * Aliasing is tolerated, substitution is not: `openai/gpt-4.1-mini` and
 * `gpt-4.1-mini` are the same request expressed two ways, so a response
 * echoing either satisfies the other. A response echoing `gemini-2.5-flash-lite`
 * does not.
 */

import { AgentEvalError } from '../errors'
import { type JudgeFamily, judgeFamily } from '../judge-families'

/**
 * Output-token budget a liveness probe must grant a model.
 *
 * Identity is only readable off a response the provider actually produced. A
 * reasoning model spends budget on hidden reasoning tokens before it emits a
 * single visible one, so a cap of a few tokens makes a HEALTHY deepseek/glm
 * model fail with `reasoning_budget_exhausted` — it names no model, its
 * identity reads as `unreported`, and a preflight scores it DEAD. 64 clears
 * that floor. Every probe in this package reads this constant, so two probes
 * cannot reach two different answers about the same router.
 *
 * Cost: a probe spends at most `PROBE_MAX_TOKENS` output tokens per model,
 * plus whatever reasoning tokens a reasoning model bills — roughly 400 output
 * tokens for a six-model preflight. That is fractions of a cent, and far
 * cheaper than a campaign that runs on a model nobody proved was alive.
 */
export const PROBE_MAX_TOKENS = 64

/** How a served id relates to the id that was requested. */
export type ServedModelVerdict =
  /** Byte-identical after normalisation — the requested model answered. */
  | 'exact'
  /** Same model, different spelling (provider prefix, snapshot, tier suffix). */
  | 'alias'
  /** A different model of the SAME provider family answered. */
  | 'substituted-within-family'
  /** A different provider's model answered. */
  | 'substituted-cross-family'
  /** The response carried no model id — identity is unproven either way. */
  | 'unreported'

export interface ServedModelCheck {
  /** The id the caller asked for. */
  requested: string
  /** The id echoed on the response; `null` when the response omitted it. */
  served: string | null
  requestedFamily: JudgeFamily
  /** `null` when `served` is null. */
  servedFamily: JudgeFamily | null
  verdict: ServedModelVerdict
  /** True for every verdict except `exact` and `alias`. */
  substituted: boolean
}

/**
 * Reduce a model id to its comparable core: lowercase, no surrounding space,
 * no `provider/` prefix, no `@snapshot` / `:batch` / `:free` tier suffix, no
 * trailing build date, and `.`/`_` folded to `-` so one version is spelled one
 * way.
 *
 * Dropping the build date is what makes snapshot resolution legible as the
 * non-event it is: a router answering `gpt-4o-mini` with
 * `gpt-4o-mini-2024-07-18` pinned a floating alias to a reproducible build —
 * the same model, which is the behaviour we want. Only routing decoration is
 * stripped; version digits are load-bearing, so `deepseek-v3.2` and
 * `deepseek-v4-flash` stay distinct, and comparison is EXACT equality rather
 * than a prefix test (a prefix rule would accept `gpt-5` → `gpt-5-mini`, a
 * silent downgrade wearing the right vendor name).
 */
export function normalizeModelId(modelId: string): string {
  let id = modelId.trim().toLowerCase()
  const at = id.indexOf('@')
  if (at > 0) id = id.slice(0, at)
  const colon = id.indexOf(':')
  if (colon > 0) id = id.slice(0, colon)
  const slash = id.lastIndexOf('/')
  if (slash >= 0) id = id.slice(slash + 1)
  return id
    .replace(/-\d{4}-\d{2}-\d{2}$/, '')
    .replace(/-\d{8}$/, '')
    .replace(/[._]/g, '-')
    .replace(/-+$/, '')
    .trim()
}

/**
 * Classify one requested/served pair. Pure — no I/O — so it is safe inside
 * response handlers, reducers, and CI gates.
 *
 * `served` is the id echoed by the provider (OpenAI-compatible bodies put it
 * at `model`). `null`/`undefined` means the body omitted it; that is
 * `unreported`, NOT a pass — a provider that does not name what answered has
 * not proven identity, and a transport that drops the field must not read as
 * agreement.
 */
export function checkServedModel(
  requested: string,
  served: string | null | undefined,
): ServedModelCheck {
  const requestedFamily = judgeFamily(requested)
  if (served === null || served === undefined || served.trim() === '') {
    return {
      requested,
      served: null,
      requestedFamily,
      servedFamily: null,
      verdict: 'unreported',
      substituted: true,
    }
  }
  const servedFamily = judgeFamily(served)
  if (requested.trim().toLowerCase() === served.trim().toLowerCase()) {
    return {
      requested,
      served,
      requestedFamily,
      servedFamily,
      verdict: 'exact',
      substituted: false,
    }
  }
  if (normalizeModelId(requested) === normalizeModelId(served)) {
    return {
      requested,
      served,
      requestedFamily,
      servedFamily,
      verdict: 'alias',
      substituted: false,
    }
  }
  return {
    requested,
    served,
    requestedFamily,
    servedFamily,
    verdict:
      requestedFamily === servedFamily ? 'substituted-within-family' : 'substituted-cross-family',
    substituted: true,
  }
}

export class ModelSubstitutionError extends AgentEvalError {
  constructor(
    message: string,
    public readonly checks: ReadonlyArray<ServedModelCheck>,
  ) {
    super('model_substitution', message)
    this.name = 'ModelSubstitutionError'
  }
}

/**
 * Consumer-facing name for the substitution policy a metered surface applies.
 * `'exact'` rejects every substitution. `'allow-within-family'` accepts a
 * different model of the same provider family; it keeps family-level claims
 * valid and forfeits per-model claims. Maps to
 * `AssertServedModelOptions.allowWithinFamily`.
 */
export type ServedModelPolicy = 'exact' | 'allow-within-family'

export function assertServedModelPolicy(
  value: unknown,
  label: string,
): asserts value is ServedModelPolicy | undefined {
  if (value !== undefined && value !== 'exact' && value !== 'allow-within-family') {
    throw new Error(`${label} must be 'exact' or 'allow-within-family'`)
  }
}

export interface AssertServedModelOptions {
  /**
   * Accept a different model of the same provider family (e.g. requested
   * `deepseek-v3.2`, served `deepseek-v4-flash`). Default false. Setting this
   * keeps family-level claims valid and forfeits per-model claims.
   */
  allowWithinFamily?: boolean
  /**
   * Accept a response that carried no model id. Default false — an
   * unidentified response cannot support a per-model or per-family claim.
   */
  allowUnreported?: boolean
  /** Prefixed to the thrown message, e.g. the judge or campaign cell name. */
  context?: string
}

/**
 * The one place the accept/reject policy lives, so a caller that reports
 * substitution (a preflight table, a run record) and a caller that throws on it
 * can never drift apart. A cross-family substitution is never acceptable.
 */
export function servedModelAcceptable(
  check: ServedModelCheck,
  opts: AssertServedModelOptions = {},
): boolean {
  switch (check.verdict) {
    case 'exact':
    case 'alias':
      return true
    case 'unreported':
      return opts.allowUnreported === true
    case 'substituted-within-family':
      return opts.allowWithinFamily === true
    default:
      return false
  }
}

function describe(check: ServedModelCheck): string {
  if (check.verdict === 'unreported')
    return `${check.requested}: response carried no model id (identity unproven)`
  return (
    `${check.requested} (${check.requestedFamily}) → served ${check.served} ` +
    `(${check.servedFamily}) [${check.verdict}]`
  )
}

/**
 * Throw `ModelSubstitutionError` unless the served id is the requested model.
 * Returns the check on success so callers can record the served id alongside
 * the result.
 */
export function assertServedModel(
  requested: string,
  served: string | null | undefined,
  opts: AssertServedModelOptions = {},
): ServedModelCheck {
  const check = checkServedModel(requested, served)
  if (servedModelAcceptable(check, opts)) return check
  const prefix = opts.context ? `${opts.context}: ` : ''
  throw new ModelSubstitutionError(
    `${prefix}model substitution — ${describe(check)}. The measurement is of the SERVED model, ` +
      'not the requested one; any per-model or per-family claim from this call is invalid.',
    [check],
  )
}

/**
 * Batch form: check every pair and throw naming EVERY substitution, so one
 * failure does not hide the rest. Returns all checks on success.
 */
export function assertServedModels(
  pairs: ReadonlyArray<{ requested: string; served: string | null | undefined }>,
  opts: AssertServedModelOptions = {},
): ServedModelCheck[] {
  const checks = pairs.map((p) => checkServedModel(p.requested, p.served))
  const bad = checks.filter((c) => !servedModelAcceptable(c, opts))
  if (bad.length > 0) {
    const prefix = opts.context ? `${opts.context}: ` : ''
    throw new ModelSubstitutionError(
      `${prefix}${bad.length}/${checks.length} call(s) were answered by a different model than ` +
        `requested — ${bad.map(describe).join('; ')}. Per-model and per-family claims from this ` +
        'run are invalid until the ids are re-measured.',
      checks,
    )
  }
  return checks
}

export interface AssertCrossFamilyServedOptions extends AssertServedModelOptions {
  /** Minimum distinct SERVED families required. Default 2. */
  minFamilies?: number
  /** Count `unknown`-family served ids toward the total. Default false. */
  allowUnknown?: boolean
}

export class ServedCrossFamilyError extends AgentEvalError {
  constructor(
    message: string,
    public readonly families: JudgeFamily[],
    public readonly checks: ReadonlyArray<ServedModelCheck>,
  ) {
    super('model_substitution', message)
    this.name = 'ServedCrossFamilyError'
  }
}

/**
 * Family-diversity rule over the models that actually ANSWERED.
 *
 * `assertCrossFamily` (../judge-families) reads the requested ids and so
 * cannot see a gateway that answers three "different" requests from one
 * provider. This one asserts no substitution first, then counts families from
 * the served ids — a panel that collapsed to one family under the hood fails
 * here even though its request list looked diverse.
 */
export function assertCrossFamilyServed(
  pairs: ReadonlyArray<{ requested: string; served: string | null | undefined }>,
  opts: AssertCrossFamilyServedOptions = {},
): JudgeFamily[] {
  const checks = assertServedModels(pairs, opts)
  const families = new Set<JudgeFamily>()
  for (const check of checks) {
    const family = check.servedFamily
    if (family === null) continue
    if (family === 'unknown' && !opts.allowUnknown) continue
    families.add(family)
  }
  const list = [...families].sort()
  const minFamilies = opts.minFamilies ?? 2
  if (list.length < minFamilies) {
    const prefix = opts.context ? `${opts.context}: ` : ''
    throw new ServedCrossFamilyError(
      `${prefix}the models that ANSWERED span ${list.length} provider famil` +
        `${list.length === 1 ? 'y' : 'ies'} (${list.join(', ') || 'none'}) but ${minFamilies} ` +
        `required — served ids: ${checks.map((c) => c.served ?? 'unreported').join(', ')}`,
      list,
      checks,
    )
  }
  return list
}
