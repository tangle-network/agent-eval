import type { RunTokenUsage } from '../run-record'
import { numberField, stringField, tokenUsageField } from './trace-event-fields'
import type { WorkflowTraceEvent } from './types'

export interface WorkflowPhaseGraphNode {
  id: string
  title: string
  startedAt?: number
  endedAt?: number
  eventCount: number
  branchCount: number
  failedBranchCount: number
  agentCalls: number
  loopCalls: number
  verifierCalls: number
  analystCalls: number
  reviewerCalls: number
  costUsd: number
  tokenUsage: RunTokenUsage
}

export interface WorkflowPhaseGraphBranch {
  id: string
  operation: string
  branchIndex: number
  phase: string | null
  status: 'started' | 'ended' | 'failed'
  startedAt?: number
  endedAt?: number
  durationMs?: number
  stageCount?: number
  stageIndex?: number
  message?: string
  code?: string
}

export interface WorkflowPhaseGraph {
  nodes: WorkflowPhaseGraphNode[]
  branches: WorkflowPhaseGraphBranch[]
}

type MutableWorkflowPhaseGraphNode = WorkflowPhaseGraphNode
type MutableWorkflowPhaseGraphBranch = WorkflowPhaseGraphBranch

export function workflowPhaseGraph(events: readonly WorkflowTraceEvent[]): WorkflowPhaseGraph {
  const nodes = new Map<string, MutableWorkflowPhaseGraphNode>()
  const branches: MutableWorkflowPhaseGraphBranch[] = []

  for (const event of events) {
    const phaseTitle = phaseTitleForEvent(event)
    if (phaseTitle) observePhaseEvent(phaseNode(nodes, phaseTitle), event)

    if (event.kind === 'workflow.branch.started') {
      branches.push(branchStarted(event, branches.length))
      continue
    }

    if (event.kind === 'workflow.branch.ended' || event.kind === 'workflow.branch.failed') {
      const branch = openBranchFor(branches, event) ?? branchStarted(event, branches.length)
      if (!branches.includes(branch)) branches.push(branch)
      observeBranchTerminal(branch, event)
    }
  }

  return {
    nodes: Array.from(nodes.values()).map(readonlyPhaseNode),
    branches: branches.map(readonlyBranch),
  }
}

function phaseNode(
  nodes: Map<string, MutableWorkflowPhaseGraphNode>,
  title: string,
): MutableWorkflowPhaseGraphNode {
  const existing = nodes.get(title)
  if (existing) return existing
  const node: MutableWorkflowPhaseGraphNode = {
    id: `phase-${nodes.size}`,
    title,
    eventCount: 0,
    branchCount: 0,
    failedBranchCount: 0,
    agentCalls: 0,
    loopCalls: 0,
    verifierCalls: 0,
    analystCalls: 0,
    reviewerCalls: 0,
    costUsd: 0,
    tokenUsage: { input: 0, output: 0 },
  }
  nodes.set(title, node)
  return node
}

function observePhaseEvent(node: MutableWorkflowPhaseGraphNode, event: WorkflowTraceEvent): void {
  node.eventCount += 1
  node.startedAt = minDefined(node.startedAt, event.timestamp)
  node.endedAt = maxDefined(node.endedAt, event.timestamp)

  switch (event.kind) {
    case 'workflow.branch.ended':
      node.branchCount += 1
      break
    case 'workflow.branch.failed':
      node.failedBranchCount += 1
      break
    case 'workflow.agent.ended':
      node.agentCalls += 1
      break
    case 'workflow.loop.ended':
      node.loopCalls += 1
      break
    case 'workflow.verifier.ended':
      node.verifierCalls += 1
      break
    case 'workflow.analyst.ended':
      node.analystCalls += 1
      break
    case 'workflow.reviewer.ended':
      node.reviewerCalls += 1
      break
  }

  const costUsd = numberField(event.payload, 'costUsd')
  if (costUsd !== null) node.costUsd += costUsd
  const tokenUsage = tokenUsageField(event.payload.tokenUsage)
  if (tokenUsage) addTokenUsage(node.tokenUsage, tokenUsage)
}

function phaseTitleForEvent(event: WorkflowTraceEvent): string | null {
  return event.kind === 'workflow.phase'
    ? stringField(event.payload, 'title')
    : stringField(event.payload, 'phase')
}

function branchStarted(event: WorkflowTraceEvent, index: number): MutableWorkflowPhaseGraphBranch {
  const branch: MutableWorkflowPhaseGraphBranch = {
    id: `branch-${index}`,
    operation: stringField(event.payload, 'operation') ?? 'unknown',
    branchIndex: numberField(event.payload, 'branchIndex') ?? -1,
    phase: stringField(event.payload, 'phase'),
    status: 'started',
  }
  const stageCount = numberField(event.payload, 'stageCount')
  if (stageCount !== null) branch.stageCount = stageCount
  branch.startedAt = event.timestamp
  return branch
}

function openBranchFor(
  branches: readonly MutableWorkflowPhaseGraphBranch[],
  event: WorkflowTraceEvent,
): MutableWorkflowPhaseGraphBranch | null {
  const operation = stringField(event.payload, 'operation') ?? 'unknown'
  const branchIndex = numberField(event.payload, 'branchIndex') ?? -1
  const phase = stringField(event.payload, 'phase')

  for (let i = branches.length - 1; i >= 0; i -= 1) {
    const branch = branches[i]
    if (
      branch?.status === 'started' &&
      branch.operation === operation &&
      branch.branchIndex === branchIndex &&
      branch.phase === phase
    ) {
      return branch
    }
  }
  return null
}

function observeBranchTerminal(
  branch: MutableWorkflowPhaseGraphBranch,
  event: WorkflowTraceEvent,
): void {
  branch.status = event.kind === 'workflow.branch.failed' ? 'failed' : 'ended'
  branch.endedAt = event.timestamp

  const durationMs = numberField(event.payload, 'durationMs')
  if (durationMs !== null) {
    branch.durationMs = durationMs
  } else if (branch.startedAt !== undefined) {
    branch.durationMs = Math.max(0, event.timestamp - branch.startedAt)
  }

  const stageCount = numberField(event.payload, 'stageCount')
  if (stageCount !== null) branch.stageCount = stageCount
  const stageIndex = numberField(event.payload, 'stageIndex')
  if (stageIndex !== null) branch.stageIndex = stageIndex
  const message = stringField(event.payload, 'message')
  if (message) branch.message = message
  const code = stringField(event.payload, 'code')
  if (code) branch.code = code
}

function readonlyPhaseNode(node: MutableWorkflowPhaseGraphNode): WorkflowPhaseGraphNode {
  const result: WorkflowPhaseGraphNode = {
    id: node.id,
    title: node.title,
    eventCount: node.eventCount,
    branchCount: node.branchCount,
    failedBranchCount: node.failedBranchCount,
    agentCalls: node.agentCalls,
    loopCalls: node.loopCalls,
    verifierCalls: node.verifierCalls,
    analystCalls: node.analystCalls,
    reviewerCalls: node.reviewerCalls,
    costUsd: node.costUsd,
    tokenUsage: node.tokenUsage,
  }
  if (node.startedAt !== undefined) result.startedAt = node.startedAt
  if (node.endedAt !== undefined) result.endedAt = node.endedAt
  return result
}

function readonlyBranch(branch: MutableWorkflowPhaseGraphBranch): WorkflowPhaseGraphBranch {
  const result: WorkflowPhaseGraphBranch = {
    id: branch.id,
    operation: branch.operation,
    branchIndex: branch.branchIndex,
    phase: branch.phase,
    status: branch.status,
  }
  if (branch.startedAt !== undefined) result.startedAt = branch.startedAt
  if (branch.endedAt !== undefined) result.endedAt = branch.endedAt
  if (branch.durationMs !== undefined) result.durationMs = branch.durationMs
  if (branch.stageCount !== undefined) result.stageCount = branch.stageCount
  if (branch.stageIndex !== undefined) result.stageIndex = branch.stageIndex
  if (branch.message !== undefined) result.message = branch.message
  if (branch.code !== undefined) result.code = branch.code
  return result
}

function minDefined(current: number | undefined, next: number): number {
  return current === undefined ? next : Math.min(current, next)
}

function maxDefined(current: number | undefined, next: number): number {
  return current === undefined ? next : Math.max(current, next)
}

function addTokenUsage(target: RunTokenUsage, value: RunTokenUsage): void {
  target.input += value.input
  target.output += value.output
  if (value.cached !== undefined) target.cached = (target.cached ?? 0) + value.cached
}
