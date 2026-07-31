import type {
  AnalystBenchmarkCase,
  AnalystBenchmarkLabelState,
  AnalystFindingScore,
  AnalystIssueExpectation,
} from '../analyst/benchmark'
import { scoreAnalystFindings } from '../analyst/benchmark'
import type { AnalystFinding, AnalystRunResult, AnalystUsageReceipt } from '../analyst/types'
import type { TraceAnalysisStore } from '../trace-analyst/store'
import type { DispatchContext, JudgeConfig, MutableSurface, Scenario } from './types'

export interface TraceAnalystScenario extends Scenario {
  kind: 'trace-analyst'
  traceStore: TraceAnalysisStore
  labelState: AnalystBenchmarkLabelState
  expectedIssues: readonly AnalystIssueExpectation[]
  labeledEvidence?: AnalystBenchmarkCase['labeledEvidence']
}

export interface TraceAnalystArtifact {
  findings: readonly AnalystFinding[]
  usage?: AnalystUsageReceipt
  run?: AnalystRunResult
}

export interface BuildTraceAnalystSurfaceDispatchOptions {
  analyze(input: {
    instructions: string
    traceStore: TraceAnalysisStore
    runId: string
    signal: AbortSignal
  }): Promise<TraceAnalystArtifact>
}

export function buildTraceAnalystSurfaceDispatch(
  options: BuildTraceAnalystSurfaceDispatchOptions,
): (
  surface: MutableSurface,
  scenario: TraceAnalystScenario,
  context: DispatchContext,
) => Promise<TraceAnalystArtifact> {
  return async (surface, scenario, context) => {
    if (typeof surface !== 'string') {
      throw new TypeError(
        `buildTraceAnalystSurfaceDispatch requires a string prompt, received ${surface.kind}`,
      )
    }
    return options.analyze({
      instructions: surface,
      traceStore: scenario.traceStore,
      runId: `${context.cellId}:${scenario.id}`,
      signal: context.signal,
    })
  }
}

export function traceAnalystQualityJudge(): JudgeConfig<
  TraceAnalystArtifact,
  TraceAnalystScenario
> {
  return {
    name: 'trace-analyst-quality',
    judgeVersion: 'agent-eval:trace-analyst-quality:v3',
    dimensions: [
      { key: 'issue_recall', description: 'share of labeled issues found' },
      { key: 'finding_precision', description: 'share of findings tied to a labeled issue' },
      { key: 'f1', description: 'harmonic mean of issue recall and finding precision' },
      { key: 'critical_step_accuracy', description: 'share of labeled causal steps cited' },
      { key: 'citation_coverage', description: 'share of findings with evidence citations' },
      {
        key: 'citation_label_agreement',
        description: 'share of citations matching a labeled case location',
      },
      { key: 'clean', description: '1 when a clean case produces no findings' },
    ],
    appliesTo: (scenario) =>
      scenario.kind === 'trace-analyst' && scenario.labelState !== 'unlabeled',
    score({ artifact, scenario }) {
      assertScorableScenario(scenario)
      const score = scoreAnalystFindings(
        {
          id: scenario.id,
          expectedIssues: scenario.expectedIssues,
          labeledEvidence: scenario.labeledEvidence,
        },
        artifact.findings,
      )
      return traceAnalystJudgeScore(score)
    },
  }
}

function assertScorableScenario(scenario: TraceAnalystScenario): void {
  if (scenario.labelState === 'unlabeled') {
    throw new TypeError(`trace analyst scenario '${scenario.id}' has no quality labels`)
  }
  if (scenario.labelState === 'positive' && scenario.expectedIssues.length === 0) {
    throw new TypeError(`positive trace analyst scenario '${scenario.id}' requires expected issues`)
  }
  if (scenario.labelState === 'trusted-negative' && scenario.expectedIssues.length > 0) {
    throw new TypeError(
      `trusted-negative trace analyst scenario '${scenario.id}' cannot contain expected issues`,
    )
  }
}

function traceAnalystJudgeScore(score: AnalystFindingScore) {
  const dimensions: Record<string, number> = {
    issue_recall: score.issueRecall,
    finding_precision: score.findingPrecision,
    f1: score.f1,
    clean: score.predictionOnLabelEmptyCase ? 0 : 1,
  }
  if (score.criticalStepAccuracy !== null) {
    dimensions.critical_step_accuracy = score.criticalStepAccuracy
  }
  if (score.citationCoverage !== null) dimensions.citation_coverage = score.citationCoverage
  if (score.citationLabelAgreement !== null) {
    dimensions.citation_label_agreement = score.citationLabelAgreement
  }
  const notes = [
    `${score.matchedIssueIds.length}/${score.expectedIssueCount} issues found`,
    `${score.supportedFindingIndexes.length}/${score.supportedFindingIndexes.length + score.unsupportedFindingIndexes.length} findings supported`,
    `${score.unlabeledEvidence.length} citations outside labeled locations`,
  ].join('; ')
  const composite =
    score.criticalStepAccuracy === null ? score.f1 : (score.f1 + score.criticalStepAccuracy) / 2
  return { dimensions, composite, notes }
}
