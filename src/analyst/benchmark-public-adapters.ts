import type { TraceAnalysisStore } from '../trace-analyst/store'
import type { AnalystBenchmarkRunner } from './benchmark'
import { agentRxPredictionsToFindings } from './benchmark-datasets'
import {
  codeTraceStepFromEvidence,
  resolveAssistantStepEvidence,
  validateCodeTraceFindingEvidence,
} from './benchmark-evidence-validation'
import { MAX_INCORRECT_BLOCK_STEPS, MAX_INCORRECT_BLOCKS } from './benchmark-public-prompt'
import type { PublicAnalystBenchmarkDataset } from './benchmark-public-types'
import type { AnalystFinding, AnalystRunInputs, AnalystSeverity } from './types'
import { makeFinding } from './types'

/**
 * One contiguous run of incorrect assistant steps, in the shape both public
 * benchmark runners produce. The direct runner parses it from JSON fields; the
 * recursive runner parses it from the finding subject. Expansion, evidence
 * resolution and scoring are identical from here on.
 */
export interface CodeTraceFailureBlock {
  firstStep: number
  lastStep: number
  /** Later step whose action or observation shows the damage this block caused. */
  consequenceStep: number
  escapeStatus: 'escaped' | 'unescaped'
  severity: AnalystSeverity
  claim: string
  confidence: number
  rationale?: string
  recommendedAction?: string
  metadata?: Record<string, unknown>
}

/**
 * What the expansion did with the model's blocks.
 *
 * Escaped blocks are scored exactly like unescaped ones — the escape decision
 * is recorded, never applied — so `escapedBlocks` measures the model's own
 * judgement without moving precision, recall, or the trusted-negative rate.
 */
export interface CodeTraceBlockDiagnostics {
  reportedBlocks: number
  escapedBlocks: number
  /** Blocks dropped because their consequence step is not a real assistant step. */
  blocksWithoutConsequenceEvidence: CodeTraceFailureBlock[]
  /** Interior steps a block claimed that the trace does not carry as assistant steps. */
  unresolvedBlockInteriorSteps: number[]
  /** Steps claimed by more than one block; the first block keeps the step. */
  overlappingBlockSteps: number[]
}

export function emptyPublicBenchmarkRunner(): AnalystBenchmarkRunner<AnalystRunInputs> {
  return {
    id: 'empty',
    analyze() {
      return {
        findings: [],
        usage: {
          calls: 0,
          tokens: { input: 0, output: 0 },
          cost: { kind: 'observed', usd: 0 },
        },
        metadata: { baseline: 'emit-no-findings' },
      }
    },
  }
}

export async function adaptPublicBenchmarkFindings(options: {
  dataset: PublicAnalystBenchmarkDataset
  trajectoryId: string
  findings: readonly AnalystFinding[]
  analystId: string
  store: TraceAnalysisStore
  signal?: AbortSignal
}): Promise<{ findings: AnalystFinding[]; diagnostics: CodeTraceBlockDiagnostics | undefined }> {
  if (options.dataset === 'agentrx') {
    return {
      findings: adaptAgentRxFindings(options.trajectoryId, options.findings, options.analystId),
      diagnostics: undefined,
    }
  }
  return adaptCodeTraceFindings(
    options.trajectoryId,
    options.findings,
    options.analystId,
    options.store,
    options.signal,
  )
}

function adaptAgentRxFindings(
  trajectoryId: string,
  findings: readonly AnalystFinding[],
  analystId: string,
): AnalystFinding[] {
  if (findings.length === 0) return []
  if (findings.length !== 1) {
    throw new Error(
      `AgentRx model analyst must emit zero or one root cause, received ${findings.length}`,
    )
  }
  const source = findings[0]!
  if (!source.subject) {
    throw new Error('AgentRx model analyst finding is missing its failure-category subject')
  }
  const steps = exactFindingSteps(trajectoryId, source)
  if (steps.length !== 1) {
    throw new Error(
      `AgentRx model analyst must cite exactly one root-cause step, received ${steps.length}`,
    )
  }
  const [adapted] = agentRxPredictionsToFindings(
    trajectoryId,
    [
      {
        failure_case: source.subject,
        step_number: steps[0]!,
        description: source.rationale ?? source.claim,
      },
    ],
    {
      analystId,
      producedAt: source.produced_at,
      confidence: source.confidence,
    },
  )
  if (!adapted) throw new Error('AgentRx output adapter produced no root-cause finding')
  return [
    {
      ...adapted,
      metadata: {
        ...adapted.metadata,
        sourceFindingId: source.finding_id,
      },
    },
  ]
}

const CODE_TRACE_BLOCK_SUBJECT =
  /^incorrect-steps-(\d+)-(\d+)-(escaped|unescaped)-consequence-(\d+)$/

async function adaptCodeTraceFindings(
  trajectoryId: string,
  findings: readonly AnalystFinding[],
  analystId: string,
  store: TraceAnalysisStore,
  signal?: AbortSignal,
): Promise<{ findings: AnalystFinding[]; diagnostics: CodeTraceBlockDiagnostics }> {
  const clean = findings.filter((finding) => finding.subject === 'clean')
  if (clean.length > 0) {
    if (findings.length !== 1) {
      throw new Error('CodeTraceBench model analyst mixed a clean verdict with incorrect steps')
    }
    exactFindingSteps(trajectoryId, clean[0]!)
    return {
      findings: [],
      diagnostics: emptyCodeTraceBlockDiagnostics(),
    }
  }
  // Check the model's own citations and excerpts here: expansion replaces them
  // with runner-built evidence, so validating the expanded findings instead
  // would prove nothing about what the model quoted.
  await validateCodeTraceFindingEvidence({
    trajectoryId,
    findings,
    store,
    ...(signal ? { signal } : {}),
  })
  const blocks = findings.map((source) => codeTraceBlockFromFinding(trajectoryId, source))
  return expandCodeTraceFailureBlocks({
    trajectoryId,
    blocks,
    store,
    analystId,
    ...(findings[0] ? { producedAt: findings[0].produced_at } : {}),
    ...(signal ? { signal } : {}),
  })
}

function codeTraceBlockFromFinding(
  trajectoryId: string,
  source: AnalystFinding,
): CodeTraceFailureBlock {
  const parsed = CODE_TRACE_BLOCK_SUBJECT.exec(source.subject ?? '')
  if (!parsed) {
    throw new Error(
      `CodeTraceBench model finding '${source.finding_id}' must set subject to incorrect-steps-<first>-<last>-<escaped|unescaped>-consequence-<step>, received '${source.subject ?? ''}'`,
    )
  }
  const firstStep = Number(parsed[1])
  const lastStep = Number(parsed[2])
  const consequenceStep = Number(parsed[4])
  const cited = exactFindingSteps(trajectoryId, source)
  for (const step of cited) {
    if (step < firstStep || step > lastStep) {
      throw new Error(
        `CodeTraceBench model finding '${source.finding_id}' cites step ${step} outside its block ${firstStep}-${lastStep}`,
      )
    }
  }
  return {
    firstStep,
    lastStep,
    consequenceStep,
    escapeStatus: parsed[3] as 'escaped' | 'unescaped',
    severity: source.severity,
    claim: source.claim,
    confidence: source.confidence,
    ...(source.rationale === undefined ? {} : { rationale: source.rationale }),
    ...(source.recommended_action === undefined
      ? {}
      : { recommendedAction: source.recommended_action }),
    metadata: { sourceFindingId: source.finding_id },
  }
}

/**
 * Expand contiguous failure blocks into one scored finding per member step.
 *
 * The official scorer matches on area plus the exact step evidence URI, so
 * blocks never reach it: every runner reports blocks, and this function turns
 * them into the per-step findings the benchmark defines.
 */
export async function expandCodeTraceFailureBlocks(options: {
  trajectoryId: string
  blocks: readonly CodeTraceFailureBlock[]
  store: TraceAnalysisStore
  analystId: string
  producedAt?: string
  signal?: AbortSignal
}): Promise<{ findings: AnalystFinding[]; diagnostics: CodeTraceBlockDiagnostics }> {
  const diagnostics = emptyCodeTraceBlockDiagnostics()
  diagnostics.reportedBlocks = options.blocks.length
  if (options.blocks.length === 0) return { findings: [], diagnostics }
  assertCodeTraceBlockShape(options.blocks)

  const boundarySteps = options.blocks.flatMap((block) => [block.firstStep, block.lastStep])
  const derivedSteps = options.blocks.flatMap((block) => [
    block.consequenceStep,
    ...interiorSteps(block),
  ])
  const evidenceByStep = await resolveAssistantStepEvidence({
    trajectoryId: options.trajectoryId,
    steps: boundarySteps,
    optionalSteps: derivedSteps,
    store: options.store,
    ...(options.signal ? { signal: options.signal } : {}),
  })

  const byStep = new Map<number, CodeTraceFailureBlock>()
  for (const block of options.blocks) {
    if (!evidenceByStep.has(block.consequenceStep)) {
      diagnostics.blocksWithoutConsequenceEvidence.push(block)
      continue
    }
    if (block.escapeStatus === 'escaped') diagnostics.escapedBlocks += 1
    for (let step = block.firstStep; step <= block.lastStep; step += 1) {
      if (!evidenceByStep.has(step)) {
        diagnostics.unresolvedBlockInteriorSteps.push(step)
        continue
      }
      if (byStep.has(step)) {
        diagnostics.overlappingBlockSteps.push(step)
        continue
      }
      byStep.set(step, block)
    }
  }

  const findings = [...byStep]
    .sort(([left], [right]) => left - right)
    .map(([step, block]) =>
      makeFinding({
        analyst_id: options.analystId,
        area: 'incorrect',
        subject: `incorrect-step-${step}`,
        claim: `Step ${step} is incorrect. ${block.claim}`,
        rationale: block.rationale,
        severity: block.severity,
        confidence: block.confidence,
        evidence_refs: [evidenceByStep.get(step)!],
        recommended_action: block.recommendedAction,
        metadata: {
          ...block.metadata,
          block_first_step: block.firstStep,
          block_last_step: block.lastStep,
          block_consequence_step: block.consequenceStep,
          escape_status: block.escapeStatus,
        },
        ...(options.producedAt === undefined ? {} : { produced_at: options.producedAt }),
        id_basis: `incorrect-step-${step}`,
      }),
    )
  return { findings, diagnostics }
}

function assertCodeTraceBlockShape(blocks: readonly CodeTraceFailureBlock[]): void {
  if (blocks.length > MAX_INCORRECT_BLOCKS) {
    throw new Error(
      `model reported ${blocks.length} failure blocks; the maximum is ${MAX_INCORRECT_BLOCKS}`,
    )
  }
  for (const block of blocks) {
    if (block.lastStep < block.firstStep) {
      throw new Error(
        `failure block last_step ${block.lastStep} precedes first_step ${block.firstStep}`,
      )
    }
    const length = block.lastStep - block.firstStep + 1
    if (length > MAX_INCORRECT_BLOCK_STEPS) {
      throw new Error(
        `failure block spans ${length} steps; the maximum is ${MAX_INCORRECT_BLOCK_STEPS}`,
      )
    }
    if (block.consequenceStep < block.firstStep) {
      throw new Error(
        `failure block consequence_step ${block.consequenceStep} precedes first_step ${block.firstStep}`,
      )
    }
  }
}

function interiorSteps(block: CodeTraceFailureBlock): number[] {
  const steps: number[] = []
  for (let step = block.firstStep + 1; step < block.lastStep; step += 1) steps.push(step)
  return steps
}

function emptyCodeTraceBlockDiagnostics(): CodeTraceBlockDiagnostics {
  return {
    reportedBlocks: 0,
    escapedBlocks: 0,
    blocksWithoutConsequenceEvidence: [],
    unresolvedBlockInteriorSteps: [],
    overlappingBlockSteps: [],
  }
}

function exactFindingSteps(trajectoryId: string, finding: AnalystFinding): number[] {
  if (finding.evidence_refs.length === 0) {
    throw new Error(`model finding '${finding.finding_id}' has no step evidence`)
  }
  const steps = finding.evidence_refs.map((evidence) => {
    const parsed = codeTraceStepFromEvidence(evidence.uri)
    if (!parsed || parsed.traceId !== trajectoryId) {
      throw new Error(
        `model finding '${finding.finding_id}' cites non-case evidence '${evidence.uri}'`,
      )
    }
    return parsed.step
  })
  return [...new Set(steps)]
}
