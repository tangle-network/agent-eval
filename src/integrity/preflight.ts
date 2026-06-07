/**
 * Backend preflight: verify the models a campaign is about to spend tokens
 * against are actually served by the router BEFORE the run starts. The PRE-hoc
 * complement to `assertRealBackend` (which inspects RunRecords AFTER the run to
 * catch a stub/unconfigured backend).
 *
 * Two checks, increasing in cost:
 *   - membership (free): GET `{baseUrl}/models` once; a model is `listed` when
 *     its id is in the served set.
 *   - probe (spends a tiny number of tokens): POST `{baseUrl}/chat/completions`
 *     per model with a 1-message, 5-token request; `served` is whether the
 *     router returns 2xx, with the HTTP `status` and the body's `error.message`
 *     captured in `detail`.
 *
 * A default model the router cannot serve is a config bug. Gate a campaign on
 * `assertModelsServed` and it surfaces every dead id with its status + detail
 * instead of silently producing a stub run.
 */

import { AgentEvalError, ConfigError } from '../errors'

export interface ModelPreflight {
  /** The model id as supplied by the caller. */
  model: string
  /** Membership in the `{baseUrl}/models` served set. */
  listed: boolean
  /** 2xx on a 1-token chat probe. `null` when `probe` was not requested. */
  served: boolean | null
  /** HTTP status of the probe. `null` when not probed. */
  status: number | null
  /** Probe body's `error.message` when present, else `null`. */
  detail: string | null
}

export interface PreflightModelsOptions {
  /** Router base URL, e.g. `https://router.tangle.tools/v1`. Trailing slash tolerated. */
  baseUrl: string
  /** Bearer token sent as `Authorization: Bearer <apiKey>`. */
  apiKey: string
  /** Model ids to check. */
  models: string[]
  /** When true, additionally spend a 1-token chat probe per model. Default false. */
  probe?: boolean
  /** Injectable fetch for tests; defaults to the global. */
  fetchImpl?: typeof fetch
}

export interface PreflightOutcome {
  succeeded: boolean
  value: ModelPreflight[] | null
  error: string | null
}

interface ModelsListBody {
  data?: ReadonlyArray<{ id?: unknown }>
}

interface ChatErrorBody {
  error?: { message?: unknown }
  message?: unknown
}

function stripSlash(url: string): string {
  return url.replace(/\/+$/, '')
}

/** Extract `error.message` (then top-level `message`) from a chat-completions error body. */
function errorMessage(body: unknown): string | null {
  if (body == null || typeof body !== 'object') return null
  const b = body as ChatErrorBody
  if (b.error && typeof b.error.message === 'string') return b.error.message
  if (typeof b.message === 'string') return b.message
  return null
}

/**
 * Check that `models` are reachable on the router. Returns a typed outcome —
 * a network failure yields `{ succeeded: false, error }`, never a throw and
 * never a partial result silently reported as success. No retries, no
 * fallbacks.
 *
 * The membership check (one GET) always runs. When `probe` is true, each model
 * additionally gets a 1-token chat probe so a model that is listed but
 * unconfigured (a 401 `model_not_found` from the router) is caught.
 */
export async function preflightModels(opts: PreflightModelsOptions): Promise<PreflightOutcome> {
  const fetchImpl = opts.fetchImpl ?? fetch
  const baseUrl = stripSlash(opts.baseUrl)
  const authHeaders = { authorization: `Bearer ${opts.apiKey}` }

  let served: Set<string>
  try {
    const res = await fetchImpl(`${baseUrl}/models`, { method: 'GET', headers: authHeaders })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      return {
        succeeded: false,
        value: null,
        error: `preflightModels: GET ${baseUrl}/models → ${res.status} ${text.slice(0, 400)}`,
      }
    }
    const body = (await res.json()) as ModelsListBody
    const ids = Array.isArray(body.data) ? body.data : []
    served = new Set(ids.map((m) => m.id).filter((id): id is string => typeof id === 'string'))
  } catch (err) {
    return {
      succeeded: false,
      value: null,
      error: `preflightModels: GET ${baseUrl}/models failed — ${err instanceof Error ? err.message : String(err)}`,
    }
  }

  const results: ModelPreflight[] = []
  for (const model of opts.models) {
    const listed = served.has(model)
    if (!opts.probe) {
      results.push({ model, listed, served: null, status: null, detail: null })
      continue
    }
    try {
      const res = await fetchImpl(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { ...authHeaders, 'content-type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 5,
        }),
      })
      let detail: string | null = null
      if (!res.ok) {
        const body = await res.json().catch(() => null)
        detail = errorMessage(body)
      }
      results.push({ model, listed, served: res.ok, status: res.status, detail })
    } catch (err) {
      return {
        succeeded: false,
        value: null,
        error: `preflightModels: probe POST ${baseUrl}/chat/completions (model ${model}) failed — ${err instanceof Error ? err.message : String(err)}`,
      }
    }
  }

  return { succeeded: true, value: results, error: null }
}

export class ModelsUnreachableError extends AgentEvalError {
  constructor(
    message: string,
    public readonly results: ReadonlyArray<ModelPreflight>,
  ) {
    super('config', message)
    this.name = 'ModelsUnreachableError'
  }
}

function describeFailure(r: ModelPreflight): string {
  if (!r.listed) {
    const probeNote =
      r.served === false ? ` (probe ${r.status}${r.detail ? `: ${r.detail}` : ''})` : ''
    return `${r.model}: not in /models${probeNote}`
  }
  // listed but failed its probe
  return `${r.model}: listed but probe ${r.status}${r.detail ? ` — ${r.detail}` : ''}`
}

/**
 * Throw `ModelsUnreachableError` naming EVERY model that is unlisted or (when
 * probed) failed its probe — with status + detail per model. A model is dead
 * if it is unlisted, or if `served === false`. Callers gate a campaign on this
 * before spending tokens. When the network call itself fails the underlying
 * outcome error is rethrown — there is no partial silent pass.
 */
export async function assertModelsServed(opts: PreflightModelsOptions): Promise<ModelPreflight[]> {
  const outcome = await preflightModels(opts)
  if (!outcome.succeeded || outcome.value === null) {
    throw new ConfigError(
      outcome.error ?? 'assertModelsServed: preflight failed without an error message',
    )
  }
  const dead = outcome.value.filter((r) => !r.listed || r.served === false)
  if (dead.length > 0) {
    throw new ModelsUnreachableError(
      `assertModelsServed: ${dead.length}/${outcome.value.length} model(s) unreachable on the router — ${dead
        .map(describeFailure)
        .join('; ')}`,
      outcome.value,
    )
  }
  return outcome.value
}
