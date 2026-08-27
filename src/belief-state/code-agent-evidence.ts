import {
  type CodeAgentSessionDiagnostic,
  type CodeAgentSessionIntakeOptions,
  type CodeAgentSessionIntakeResult,
  type CodeAgentSessionMetrics,
  type CodeAgentSessionSource,
  fromClaudeCodeSession,
  fromCodexSession,
  fromKimiCodeSession,
  fromOpenCodeSession,
  fromPiSession,
} from '../contract/intake/code-agent-session'
import type { RunRecord } from '../run-record'
import {
  type BeliefDecisionInventoryReport,
  extractCodeAgentBeliefDecisionPoints,
  inventoryBeliefDecisionPoints,
} from './code-agent-corpus'
import {
  type BeliefDecisionResearchEvidencePacket,
  type BuildBeliefDecisionResearchEvidencePacketOptions,
  buildBeliefDecisionResearchEvidencePacket,
} from './research-evidence'
import type { BeliefDecisionExtractionDiagnostic, BeliefDecisionPoint } from './types'

export interface CodeAgentBeliefSession extends CodeAgentSessionIntakeOptions {
  source: CodeAgentSessionSource
}

export interface BuildCodeAgentBeliefEvidenceCorpusOptions
  extends Omit<BuildBeliefDecisionResearchEvidencePacketOptions, 'points'> {
  sessions: CodeAgentBeliefSession[]
}

export interface CodeAgentBeliefEvidenceCorpus {
  runs: RunRecord[]
  metrics: CodeAgentSessionMetrics[]
  intakeDiagnostics: CodeAgentSessionDiagnostic[]
  extractionDiagnostics: BeliefDecisionExtractionDiagnostic[]
  decisions: BeliefDecisionPoint[]
  inventory: BeliefDecisionInventoryReport
  evidence: BeliefDecisionResearchEvidencePacket
}

export function buildCodeAgentBeliefEvidenceCorpus(
  options: BuildCodeAgentBeliefEvidenceCorpusOptions,
): CodeAgentBeliefEvidenceCorpus {
  const { sessions, ...evidenceOptions } = options
  const runs: RunRecord[] = []
  const metrics: CodeAgentSessionMetrics[] = []
  const intakeDiagnostics: CodeAgentSessionDiagnostic[] = []
  const extractionDiagnostics: BeliefDecisionExtractionDiagnostic[] = []
  const decisions: BeliefDecisionPoint[] = []

  for (const session of sessions) {
    const intake = fromCodeAgentBeliefSession(session)
    runs.push(...intake.runs)
    metrics.push(...intake.metrics)
    intakeDiagnostics.push(...intake.diagnostics)

    for (const [index, run] of intake.runs.entries()) {
      const extraction = extractCodeAgentBeliefDecisionPoints({
        source: session.source,
        entries: session.entries,
        observation: intake.observations[index],
        run,
        sourcePath: session.sourcePath,
      })
      decisions.push(...extraction.decisions)
      extractionDiagnostics.push(...extraction.diagnostics)
    }
  }

  const evidence = buildBeliefDecisionResearchEvidencePacket({
    ...evidenceOptions,
    points: decisions,
  })

  return {
    runs,
    metrics,
    intakeDiagnostics,
    extractionDiagnostics,
    decisions,
    inventory: inventoryBeliefDecisionPoints(decisions),
    evidence,
  }
}

function fromCodeAgentBeliefSession(session: CodeAgentBeliefSession): CodeAgentSessionIntakeResult {
  switch (session.source) {
    case 'codex':
      return fromCodexSession(session)
    case 'claude-code':
      return fromClaudeCodeSession(session)
    case 'opencode':
      return fromOpenCodeSession(session)
    case 'kimi-code':
      return fromKimiCodeSession(session)
    case 'pi':
      return fromPiSession(session)
  }
}
