import type { JudgeConfig, JudgeScore, Scenario } from './types'

export interface PhoenixEvaluationResultLike {
  score?: number
  label?: string
  explanation?: string
}

export interface PhoenixEvaluatorLike<TRecord extends Record<string, unknown>> {
  name: string
  kind: 'LLM' | 'CODE'
  optimizationDirection?: 'MAXIMIZE' | 'MINIMIZE' | 'NEUTRAL'
  evaluate(record: TRecord): Promise<PhoenixEvaluationResultLike>
}

export interface AutoevalsScoreLike {
  name: string
  score: number | null
  metadata?: Record<string, unknown>
}

export type AutoevalsScorerLike<TInput extends Record<string, unknown>> = (
  input: TInput,
) => AutoevalsScoreLike | Promise<AutoevalsScoreLike>

interface UpstreamJudgeOptions<TScenario extends Scenario> {
  name?: string
  dimension?: string
  judgeVersion?: string
  appliesTo?: (scenario: TScenario) => boolean
  /** Convert the upstream score when its native scale is not higher-is-better. */
  toComposite?: (score: number) => number
}

export function phoenixEvaluatorJudge<
  TRecord extends Record<string, unknown>,
  TArtifact,
  TScenario extends Scenario = Scenario,
>(
  evaluator: PhoenixEvaluatorLike<TRecord>,
  options: UpstreamJudgeOptions<TScenario> & {
    mapInput(input: { artifact: TArtifact; scenario: TScenario }): TRecord
  },
): JudgeConfig<TArtifact, TScenario> {
  if (
    (evaluator.optimizationDirection === 'MINIMIZE' ||
      evaluator.optimizationDirection === 'NEUTRAL') &&
    !options.toComposite
  ) {
    throw new TypeError(
      `phoenixEvaluatorJudge requires toComposite for a ${evaluator.optimizationDirection} evaluator`,
    )
  }
  return upstreamJudge(
    {
      name: options.name ?? evaluator.name,
      dimension: options.dimension,
      judgeVersion: options.judgeVersion,
      appliesTo: options.appliesTo,
      toComposite: options.toComposite,
    },
    async (input) => {
      const result = await evaluator.evaluate(options.mapInput(input))
      if (result.score === undefined || !Number.isFinite(result.score)) {
        throw new Error(`${evaluator.name}: Phoenix evaluator returned no finite score`)
      }
      return {
        score: result.score,
        notes: [result.label, result.explanation].filter(Boolean).join(': ') || evaluator.name,
      }
    },
  )
}

export function autoevalsScorerJudge<
  TInput extends Record<string, unknown>,
  TArtifact,
  TScenario extends Scenario = Scenario,
>(
  scorer: AutoevalsScorerLike<TInput>,
  options: UpstreamJudgeOptions<TScenario> & {
    name: string
    mapInput(input: { artifact: TArtifact; scenario: TScenario }): TInput
  },
): JudgeConfig<TArtifact, TScenario> {
  return upstreamJudge(options, async (input) => {
    const result = await scorer(options.mapInput(input))
    if (result.score === null || !Number.isFinite(result.score)) {
      throw new Error(`${options.name}: Autoevals scorer returned no finite score`)
    }
    return {
      score: result.score,
      notes: result.metadata ? JSON.stringify(result.metadata) : result.name,
    }
  })
}

function upstreamJudge<TArtifact, TScenario extends Scenario>(
  options: UpstreamJudgeOptions<TScenario> & { name: string },
  evaluate: (input: { artifact: TArtifact; scenario: TScenario }) => Promise<{
    score: number
    notes: string
  }>,
): JudgeConfig<TArtifact, TScenario> {
  const dimension = options.dimension ?? options.name
  return {
    name: options.name,
    judgeVersion: options.judgeVersion,
    dimensions: [{ key: dimension, description: `Score from ${options.name}` }],
    appliesTo: options.appliesTo,
    async score(input): Promise<JudgeScore> {
      const result = await evaluate(input)
      const composite = options.toComposite ? options.toComposite(result.score) : result.score
      if (!Number.isFinite(composite)) {
        throw new Error(`${options.name}: toComposite returned a non-finite score`)
      }
      return {
        dimensions: { [dimension]: result.score },
        composite,
        notes: result.notes,
      }
    },
  }
}
