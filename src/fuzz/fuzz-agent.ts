/**
 * `fuzzAgent` — the adversarial batch preset over `BehaviorExplorer`.
 *
 * One call: explore the space to budget with the adversarial objective and
 * return the capsule. For agent-driven, incremental, or multi-objective use,
 * construct a `BehaviorExplorer` and drive it via `makeExploreTools`.
 */

import { BehaviorExplorer } from './explorer'
import { adversarialObjective } from './policies'
import type { CapsuleData, ExploreOptions } from './types'

export type FuzzAgentOptions<S> = Omit<ExploreOptions<S>, 'objective'> & {
  /** Score strictly below this is a candidate failure. Default 0.5. */
  failureThreshold?: number
}

export async function fuzzAgent<S>(
  opts: FuzzAgentOptions<S>,
): Promise<{ capsule: CapsuleData<S> }> {
  const { failureThreshold, ...rest } = opts
  const explorer = new BehaviorExplorer<S>({
    ...rest,
    objective: adversarialObjective(failureThreshold ?? 0.5),
  })
  return { capsule: await explorer.run() }
}
