/**
 * Turn recorded evidence into cited findings, with every execution choice
 * stated by the caller.
 *
 * Run with: pnpm tsx examples/custom-trace-analyst/index.ts
 *
 * An analyst reads recorded evidence and returns findings. Each finding names
 * a severity, a claim, and the exact evidence it rests on. `runExact()` runs a
 * declared list of analysts in a declared order and takes no default from the
 * registry.
 */

import { createHash } from 'node:crypto'
import type { AnalystFinding, ExactCapableAnalyst } from '../../src/analyst'
import { AnalystRegistry } from '../../src/analyst'

interface ToolCall {
  spanId: string
  tool: string
  ok: boolean
  message: string
}

const PRODUCED_AT = '2026-08-15T00:00:00.000Z'

function findingId(analystId: string, claim: string): string {
  return createHash('sha256').update(`${analystId}\n${claim}`).digest('hex').slice(0, 32)
}

/**
 * A deterministic analyst. It calls no model, so it costs nothing and returns
 * the same findings for the same input every time. `executionConfig` is the
 * canonical record of every behavior knob `version` does not already bind.
 */
const failedTools: ExactCapableAnalyst<{ toolCalls: ToolCall[] }> = {
  id: 'failed-tools',
  description: 'Report every tool call that failed, with the span that carries it.',
  inputKind: 'custom',
  cost: { kind: 'deterministic' },
  version: '1.0.0',
  executionConfig: { kind: 'failed-tools', schemaVersion: '1' },
  async analyze(input): Promise<AnalystFinding[]> {
    return input.toolCalls
      .filter((call) => !call.ok)
      .map((call) => {
        const claim = `${call.tool} failed: ${call.message}`
        return {
          schema_version: '1.0.0',
          finding_id: findingId('failed-tools', claim),
          analyst_id: 'failed-tools',
          produced_at: PRODUCED_AT,
          severity: 'high',
          area: 'tool-use',
          claim,
          evidence_refs: [{ kind: 'span', uri: `span:${call.spanId}` }],
          confidence: 1,
        } satisfies AnalystFinding
      })
  },
}

const registry = new AnalystRegistry()
registry.register(failedTools)

const toolCalls: ToolCall[] = [
  { spanId: 's1', tool: 'read_file', ok: true, message: 'ok' },
  { spanId: 's2', tool: 'run_tests', ok: false, message: 'exit 1, 3 failing specs' },
  { spanId: 's3', tool: 'write_file', ok: true, message: 'ok' },
  { spanId: 's4', tool: 'run_tests', ok: false, message: 'exit 1, 1 failing spec' },
]

const result = await registry.runExact(
  'analysis-1',
  // Custom input is keyed by analyst id: each analyst reads only its own.
  { custom: { 'failed-tools': { toolCalls } } },
  {
    // The array is the execution order. Exact runs are serial.
    analystIds: ['failed-tools'],
    // `null` disables a channel on purpose. There is no implicit default.
    budget: null,
    totalTimeoutMs: null,
    signal: null,
    costLedger: null,
    costLedgerIdentity: null,
    costPhase: null,
    tags: null,
    priorFindings: null,
    chainFindings: false,
    // Stop rather than run an analyst whose declared input is absent.
    missingInputMode: 'abort',
    applyRegistryHooks: false,
    useRegistryChat: false,
  },
)

console.log('run status:', result.completion.status)
console.log('analysts:  ', result.execution_plan.analysts.length)
for (const finding of result.findings) {
  const span = finding.evidence_refs[0]
  console.log(`${finding.severity.padEnd(6)} ${finding.claim}  [${span?.uri}]`)
}
