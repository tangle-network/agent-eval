/**
 * Adversarial mutation contract.
 *
 * `AdversarialMutation<S>` is the scenario-mutation strategy the fuzz harness
 * (`fuzzAgent`, src/fuzz) drives: paraphrase, edge-case substitution, or
 * compositional combination of a scenario the policy currently passes, looking
 * for the tail inputs that break it. The harness supplies the loop; consumers
 * supply the mutations and the failure detector.
 */

export interface AdversarialMutation<S> {
  id: string
  /**
   * Mutate one scenario. Return null to skip; return one or more new
   * scenarios. The harness deduplicates by `mutateScenarioId(scenario)`.
   */
  mutate(parent: S, rng: () => number): Promise<S[]> | S[]
}
