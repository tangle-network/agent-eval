/**
 * @tangle-network/agent-eval/matrix
 *
 * N-axis cartesian runner over substrate types. The matrix is a runner +
 * aggregator: cells carry caller-supplied values (AgentProfile from
 * agent-interface, Driver / Validator from agent-runtime, rubric records, anything), and the
 * runner returns per-axis pass / score / cost / duration summaries.
 *
 * No "Spec" / "Wrapper" / "Config" types around substrate. The only
 * matrix-owned types are orchestration types: `MatrixAxis<V>`, `MatrixCell`,
 * `CellResult`, `AxisSummary`, `MatrixResult`.
 */

export { buildByAxis, summariseRows } from './aggregation'
export { runAgentMatrix } from './runner'
export type {
  AxisSummary,
  CellResult,
  DefaultVerdict,
  MatrixAxis,
  MatrixCell,
  MatrixResult,
  RunAgentMatrixOptions,
} from './types'
