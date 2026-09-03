/**
 * Judge model-family classification + cross-family enforcement.
 *
 * A judge ensemble built entirely from one provider family shares that
 * family's blind spots and self-preference — its "agreement" is correlated
 * bias, not independent signal. `assertCrossFamily` makes the consumer prove
 * the ensemble spans ≥2 families; `judgeFamily` is the single regex map that
 * replaces the per-consumer copies (tax/legal/creative/gtm each ship one).
 */

/** Provider family a model belongs to. `unknown` when no rule matches. */
export type JudgeFamily =
  | 'anthropic'
  | 'openai'
  | 'google'
  | 'meta'
  | 'mistral'
  | 'deepseek'
  | 'xai'
  | 'qwen'
  | 'cohere'
  | 'amazon'
  | 'moonshot'
  | 'zhipu'
  | 'unknown'

/** Explicit `provider/...` prefix → family (models.dev / OpenRouter style). */
const PROVIDER_PREFIX: Record<string, JudgeFamily> = {
  anthropic: 'anthropic',
  openai: 'openai',
  'azure-openai': 'openai',
  google: 'google',
  'google-vertex': 'google',
  meta: 'meta',
  'meta-llama': 'meta',
  mistral: 'mistral',
  mistralai: 'mistral',
  deepseek: 'deepseek',
  xai: 'xai',
  qwen: 'qwen',
  alibaba: 'qwen',
  cohere: 'cohere',
  amazon: 'amazon',
  bedrock: 'amazon',
  moonshot: 'moonshot',
  moonshotai: 'moonshot',
  kimi: 'moonshot',
  'kimi-code': 'moonshot',
  zhipu: 'zhipu',
  zhipuai: 'zhipu',
  zai: 'zhipu',
  'z-ai': 'zhipu',
  glm: 'zhipu',
}

/** Fallback model-name patterns when there's no recognised provider prefix. */
const NAME_PATTERNS: Array<[RegExp, JudgeFamily]> = [
  [/claude/i, 'anthropic'],
  // Anthropic's own bare aliases (`claude --model sonnet|opus|haiku`). A run that requested `sonnet`
  // and was served claude-sonnet-5 is an alias resolution, not a cross-family substitution: without
  // this row the alias classified as `unknown` and assertServedModel refused the pair.
  [/^(?:sonnet|opus|haiku)(?:[-@\s]|$)/i, 'anthropic'],
  [/\b(gpt|davinci|babbage)\b|^o[134]\b|[-/]o[134]\b|gpt-/i, 'openai'],
  [/gemini|palm|gemma|bison/i, 'google'],
  [/llama/i, 'meta'],
  [/mi(s|x)tral|codestral|magistral/i, 'mistral'],
  [/deepseek/i, 'deepseek'],
  [/grok/i, 'xai'],
  [/qwen/i, 'qwen'],
  [/command-?(r|a)?/i, 'cohere'],
  [/\b(nova|titan)\b/i, 'amazon'],
  [/\bkimi\b|moonshot/i, 'moonshot'],
  [/\bglm\b|zhipu|\bz-?ai\b/i, 'zhipu'],
]

/**
 * Classify a model id into its provider family. Strips a `@snapshot` suffix
 * and prefers an explicit `provider/...` prefix; otherwise matches the model
 * name. Returns `unknown` when nothing matches (callers decide whether that's
 * acceptable — `assertCrossFamily` counts it as its own family).
 */
export function judgeFamily(modelId: string): JudgeFamily {
  const id = modelId.trim().split('@')[0]!.toLowerCase()
  const slash = id.indexOf('/')
  if (slash > 0) {
    const prefix = id.slice(0, slash)
    const mapped = PROVIDER_PREFIX[prefix]
    if (mapped) return mapped
  }
  for (const [pattern, family] of NAME_PATTERNS) {
    if (pattern.test(id)) return family
  }
  return 'unknown'
}

export interface AssertCrossFamilyOptions {
  /** Minimum number of distinct families the ensemble must span. Default 2. */
  minFamilies?: number
  /** When false (default), `unknown`-family models do NOT count toward the
   *  family total — an ensemble of all-unclassifiable models is not provably
   *  cross-family. Set true to count `unknown` as one shared family. */
  allowUnknown?: boolean
}

export class CrossFamilyError extends Error {
  constructor(
    message: string,
    public readonly families: JudgeFamily[],
    public readonly models: string[],
  ) {
    super(message)
    this.name = 'CrossFamilyError'
  }
}

/**
 * Throw unless the judge models span at least `minFamilies` distinct provider
 * families. Pass the model ids backing your judge ensemble. Fail-loud by
 * design — a correlated single-family ensemble silently inflates agreement.
 *
 * Scope: this reads the ids you REQUEST. It proves the panel was configured
 * across families; it cannot prove the panel RAN across families, because a
 * routing gateway may answer several different ids from one provider. Where
 * the diversity claim is load-bearing (a published leaderboard, a
 * certification, a non-self-judging exclusion), assert on the ids the
 * provider echoed instead: `assertCrossFamilyServed` in
 * ./integrity/served-model.
 */
export function assertCrossFamily(
  models: string[],
  opts: AssertCrossFamilyOptions = {},
): JudgeFamily[] {
  const minFamilies = opts.minFamilies ?? 2
  const families = new Set<JudgeFamily>()
  for (const m of models) {
    const f = judgeFamily(m)
    if (f === 'unknown' && !opts.allowUnknown) continue
    families.add(f)
  }
  const list = [...families].sort()
  if (list.length < minFamilies) {
    throw new CrossFamilyError(
      `judge ensemble spans ${list.length} provider famil${list.length === 1 ? 'y' : 'ies'} ` +
        `(${list.join(', ') || 'none'}) but ${minFamilies} required — a single-family ensemble ` +
        'is correlated bias, not independent signal',
      list,
      models,
    )
  }
  return list
}
