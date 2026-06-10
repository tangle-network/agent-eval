/**
 * @tangle-network/agent-eval/perf
 *
 * Domain-agnostic infra-performance benchmarking substrate: a journeys ×
 * axes scenario matrix, record-integrity contracts over flat metric
 * records, and a percentile ratchet (summarize → baseline → gate).
 *
 * Complements the judge-panel `BenchmarkRunner` (root): that one scores
 * QUALITY; this one scores LATENCY / RELIABILITY over flat metric records.
 */

export type { IntegrityResult, IntegrityViolation } from './integrity'
export { assertRecordIntegrity, checkRecordIntegrity } from './integrity'
export type { JourneySpec, PerfScenario, ScenarioAxes } from './journey'
export { expandMatrix, scenarioKey } from './journey'
export type { PerfBaseline, PerfGateResult, PerfRegression, PerfStat } from './ratchet'
export { gatePerf, summarizeRecords } from './ratchet'
