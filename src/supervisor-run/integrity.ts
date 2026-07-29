import { evidence, issue } from './integrity-issues'
import { sourceIssues } from './integrity-source'
import { treeIssues } from './integrity-tree'
import {
  SUPERVISOR_RUN_INTEGRITY_SCHEMA,
  type SupervisorRunIntegrityOptions,
  type SupervisorRunIntegrityReport,
  type SupervisorRunSourceOnlyCheckCode,
} from './integrity-types'
import { supervisorRunRolloutLinesFromFacts } from './rollout-nodes'
import { parseSupervisorTree } from './source-facts'
import type { SupervisorRunSources, SupervisorRunTree } from './types'

export {
  SUPERVISOR_RUN_INTEGRITY_SCHEMA,
  type SupervisorRunIntegrityEvidence,
  type SupervisorRunIntegrityIssue,
  type SupervisorRunIntegrityIssueCode,
  type SupervisorRunIntegrityOptions,
  type SupervisorRunIntegrityReport,
  type SupervisorRunIntegritySeverity,
  type SupervisorRunSourceOnlyCheckCode,
} from './integrity-types'

function isTree(input: SupervisorRunSources | SupervisorRunTree): input is SupervisorRunTree {
  return 'nodes' in input && Array.isArray(input.nodes)
}

function treeRunRef(tree: SupervisorRunTree): string {
  const runIds = [
    ...new Set(
      tree.nodes
        .map((node) => node.run_id)
        .filter((runId): runId is string => typeof runId === 'string' && runId.length > 0),
    ),
  ].sort()
  if (runIds.length === 1) return runIds[0]!
  if (runIds.length > 1) return `mixed-runs:${runIds.join(',')}`
  return tree.rootId ?? 'unidentified-tree'
}

/**
 * Run deterministic integrity checks over source bytes or an already minted tree.
 * Source input is parsed exactly once and reused by projection and source-only checks.
 */
export function analyzeSupervisorRunIntegrity(
  input: SupervisorRunSources | SupervisorRunTree,
  options: SupervisorRunIntegrityOptions = {},
): SupervisorRunIntegrityReport {
  if (isTree(input)) {
    const sourceOnlyChecks: readonly SupervisorRunSourceOnlyCheckCode[] = [
      'journal-event-cardinality',
      'worker-control-join',
      'steer-ack-correlation',
    ]
    return {
      schema: SUPERVISOR_RUN_INTEGRITY_SCHEMA,
      runRef: treeRunRef(input),
      input: 'tree',
      tree: input,
      issues: [
        ...treeIssues(input),
        issue({
          code: 'source-checks-unavailable',
          area: 'capture-integrity',
          severity: 'medium',
          subject: 'source-only-control-checks',
          claim: 'Source-only control checks are unavailable for SupervisorRunTree input',
          detail:
            'Rollout rows do not retain journal event multiplicity or worker inbox and acknowledgement rows.',
          evidence: [evidence('input/source-only-checks', sourceOnlyChecks)],
          recommendedAction:
            'Pass SupervisorRunSources when journal and worker control checks are required.',
          metadata: { assessment: 'unavailable', checks: sourceOnlyChecks },
        }),
      ],
    }
  }

  const facts = parseSupervisorTree(input)
  const tree = supervisorRunRolloutLinesFromFacts(input, facts, {
    capturedAt: options.capturedAt,
  })
  return {
    schema: SUPERVISOR_RUN_INTEGRITY_SCHEMA,
    runRef: input.runRef,
    input: 'sources',
    tree,
    issues: [
      ...treeIssues(tree, {
        unknownIdentityRows:
          facts.journalInvalidRows +
          facts.spawns.filter((spawn) => !spawn.valid && spawn.id.length === 0).length,
        uncertainIds: new Set(
          facts.spawns
            .filter((spawn) => !spawn.valid && spawn.id.length > 0)
            .map((spawn) => spawn.id),
        ),
      }),
      ...sourceIssues(input, facts, tree),
    ],
  }
}
