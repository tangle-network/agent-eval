/**
 * Diagnose chain — WHY a run failed, WHAT should have happened, HOW to
 * make it happen.
 *
 * The full remediation pipeline this subpath closes:
 *
 *   fuzz finds → sweep blames → repair prescribes (validated) →
 *   findings / corpus / invariant remediate → gates verify
 *
 * Three stages, all orchestration over existing primitives — nothing here
 * re-implements replay, mutation, or attribution:
 *
 *   1. `causalSweep` — WHY. Runs `reps` counterfactual replays per
 *      (step, mutation) cell through `runCounterfactual` (the consumer's
 *      `CounterfactualRunner` is the execution seam) and reduces the
 *      per-rep deltas into a responsibility ranking with bootstrap CIs
 *      (`confidenceInterval`). Budget-bounded; unprobed steps are named
 *      in `uncovered`, never dropped.
 *   2. `prescribeRepair` — WHAT SHOULD HAVE HAPPENED. Consumer-supplied
 *      `proposeFix` (LLM-backed in live use) proposes candidate mutations
 *      for the blamed steps; each candidate is machine-verified by
 *      replaying WITH it. Only candidates whose every validation rep
 *      crosses `flipThreshold` become repairs; the rest are rejected
 *      with a typed reason.
 *   3. Remediation adapters — HOW. `toAnalystFindings` feeds the analyst
 *      registry, `toCorpusRecord` pins the failure as a permanent corpus
 *      scenario, `suggestInvariant` emits the trace-contracts hint shape.
 */

// The execution-seam types consumers must implement live in counterfactual.ts;
// re-exported so a diagnose consumer imports from one subpath.
export type {
  CounterfactualContext,
  CounterfactualMutation,
  CounterfactualResult,
  CounterfactualRunner,
} from '../counterfactual'
export type {
  CausalResponsibilityReport,
  CausalSweepOptions,
  StepRef,
  StepResponsibility,
} from './causal-sweep'
export { causalSweep, stepRefOf } from './causal-sweep'
export type { InvariantHint } from './remediation'
export {
  DIAGNOSE_ANALYST_ID,
  describeMutation,
  severityFromEffect,
  suggestInvariant,
  toAnalystFindings,
  toCorpusRecord,
} from './remediation'
export type {
  PrescribeRepairOptions,
  RejectedRepair,
  RepairContext,
  RepairReport,
  ValidatedRepair,
} from './repair'
export { prescribeRepair } from './repair'
