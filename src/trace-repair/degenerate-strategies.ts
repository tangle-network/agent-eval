/**
 * The strategies that would score without repairing anything, named here so a
 * reviewer can check each one against the mechanism that defeats it and a
 * test can be required for each.
 *
 * Two kinds of defeat, and the difference matters:
 *
 *   gate         the grader refuses the answer before spending a rollout
 *   measurement  the answer runs and measures the same as its control
 *
 * A gate is cheap and certain. A measurement defeat is the honest one where
 * no syntactic rule can decide — a semantic no-op looks like a repair until
 * the tests disagree with it — and it costs rollouts to establish.
 */

export type DegenerateDefeatKind = 'gate' | 'measurement'

export interface DegenerateStrategy {
  readonly id: string
  /** What the analyst does to score without repairing. */
  readonly strategy: string
  /** The mechanism that removes the reward. */
  readonly defeat: string
  readonly defeatKind: DegenerateDefeatKind
  /** Module that carries the mechanism. */
  readonly enforcedIn: string
}

export const DEGENERATE_STRATEGIES = [
  {
    id: 'point-at-any-nonzero-exit-step',
    strategy:
      'Name the first step with a nonzero returncode, claim it failed, and let the reproduction gate confirm it.',
    defeat:
      'Reproduction is a gate, not a tier that pays. The credit vector has no term for it, so a reproduced step with no working intervention scores exactly what an unreproduced one scores: nothing.',
    defeatKind: 'gate',
    enforcedIn: 'funnel.ts (repairCredit has no reproduction term)',
  },
  {
    id: 'propose-the-recorded-command-again',
    strategy:
      'Return the action the agent already ran at step k, so the arm reproduces the recorded state and looks like a faithful replay.',
    defeat:
      'The intervention is compared against the recorded action at k after whitespace normalisation and rejected before a container opens.',
    defeatKind: 'gate',
    enforcedIn: 'grade.ts (recorded-action-reproposed rejection)',
  },
  {
    id: 'propose-a-no-op',
    strategy:
      'Return an action that changes nothing, so the arm inherits whatever the trajectory would have done anyway.',
    defeat:
      'Literal no-ops are rejected at the budget check. A semantic no-op cannot be detected syntactically, so it runs and measures at the no-op control floor: its paired delta is zero.',
    defeatKind: 'measurement',
    enforcedIn: 'action-budget.ts (NO_OP_ACTIONS) and delta-repair.ts (paired delta)',
  },
  {
    id: 'submit-instead-of-repair',
    strategy:
      'Return the submit sentinel so the run ends immediately and the arm terminates cleanly.',
    defeat:
      'An action carrying the submit sentinel is rejected at the budget check. Ending the run is what the recorded agent already did and the tests already failed on it.',
    defeatKind: 'gate',
    enforcedIn: 'action-budget.ts (SUBMIT_SENTINEL rejection)',
  },
  {
    id: 'touch-the-test-suite',
    strategy:
      "Write a passing suite, or a reward file, at the path the grader will read, so the oracle grades the trajectory's own artifact.",
    defeat:
      'The oracle purges the suite root and uploads the held-out suite from outside the session at grade time, then verifies the bytes it reads back. A planted suite is overwritten; a session that refuses the overwrite raises a tamper error instead of returning a pass.',
    defeatKind: 'gate',
    enforcedIn: 'test-oracle.ts (purge, upload, read-back digest)',
  },
  {
    id: 'buy-a-bigger-action',
    strategy:
      'Return a multi-command script or a whole-file rewrite that does far more than one scaffold turn could.',
    defeat:
      'The budget counts top-level statements, heredocs and bytes. More than one action, more than one authored file, or more than 4 KB is rejected before a container opens.',
    defeatKind: 'gate',
    enforcedIn: 'action-budget.ts (checkInterventionBudget)',
  },
  {
    id: 'decline-every-hard-row',
    strategy:
      'Answer no-decisive-failure on everything except the rows that are obviously repairable, so the reported rate is computed on an easy subset.',
    defeat:
      'A declined row keeps its cell in the funnel and stays in the denominator with a paired delta of zero, because its intervention arm is definitionally its control arm. Declining cannot raise the headline; it can only dilute it.',
    defeatKind: 'measurement',
    enforcedIn: 'grade.ts (declined outcome) and delta-repair.ts (full admitted denominator)',
  },
  {
    id: 'repair-somewhere-other-than-k',
    strategy:
      'Name a plausible-looking k, then submit an intervention that fixes the task from any state, so the answer scores without localising anything.',
    defeat:
      'The intervention is executed at the k the analyst named, on the state produced by replaying steps 1..k-1. There is no separate localisation credit to win and no label the grader reads, so a wrong k is only penalised through the repair failing to work there.',
    defeatKind: 'measurement',
    enforcedIn: 'grade.ts (the intervention is applied at the named k only)',
  },
] as const satisfies readonly DegenerateStrategy[]

export type DegenerateStrategyId = (typeof DEGENERATE_STRATEGIES)[number]['id']
