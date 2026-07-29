/**
 * Deterministic integrity checks over the existing supervisor-run inputs.
 *
 * This analyst deliberately does not invent an "agentic control" record.
 * It accepts either the bytes already represented by `SupervisorRunSources`
 * or the canonical rollout rows already represented by `SupervisorRunTree`.
 * A missing field produces an unavailable-evidence finding; it never becomes
 * a zero, a clean bill of health, or a claim about who made a decision.
 */

import { type RolloutLine, validateRolloutLine } from '../../rollout/schema'
import { analyzeSupervisorRunSources, parseSupervisorTree } from '../../supervisor-run/analyze'
import { supervisorRunRolloutLines } from '../../supervisor-run/rollout-nodes'
import {
  isUnavailable,
  type SupervisorRunSources,
  type SupervisorRunTree,
} from '../../supervisor-run/types'
import {
  type Analyst,
  type AnalystContext,
  type AnalystFinding,
  type AnalystSeverity,
  type EvidenceRef,
  makeFinding,
} from '../types'

const ANALYST_ID = 'control-integrity'
const MAX_EVIDENCE_EXAMPLES = 20

function isTree(input: SupervisorRunSources | SupervisorRunTree): input is SupervisorRunTree {
  return 'nodes' in input && Array.isArray(input.nodes)
}

function shown(value: unknown): string {
  if (value === undefined) return '<absent>'
  const encoded = JSON.stringify(value)
  return encoded === undefined ? String(value) : encoded
}

function metricRef(namespace: string, path: string, value: unknown): EvidenceRef {
  return {
    kind: 'metric',
    uri: `supervisor-run://${encodeURIComponent(namespace)}/${path}`,
    excerpt: shown(value),
  }
}

function nodeRef(namespace: string, node: RolloutLine, path: string, value: unknown): EvidenceRef {
  return metricRef(namespace, `nodes/${encodeURIComponent(node.rollout_id)}/${path}`, value)
}

function countedEvidence(
  namespace: string,
  path: string,
  total: number,
  examples: readonly EvidenceRef[],
): EvidenceRef[] {
  return [metricRef(namespace, `${path}/count`, total), ...examples.slice(0, MAX_EVIDENCE_EXAMPLES)]
}

function finding(init: {
  producedAt: string
  area: 'control-integrity' | 'capture-integrity'
  severity: AnalystSeverity
  subject: string
  claim: string
  rationale: string
  evidence: EvidenceRef[]
  recommendedAction: string
  metadata?: Record<string, unknown>
}): AnalystFinding {
  return makeFinding({
    analyst_id: ANALYST_ID,
    produced_at: init.producedAt,
    area: init.area,
    severity: init.severity,
    subject: init.subject,
    claim: init.claim,
    rationale: init.rationale,
    evidence_refs: init.evidence,
    recommended_action: init.recommendedAction,
    validation_plan:
      'Re-run this deterministic analyst on the retained SupervisorRunSources or SupervisorRunTree after correcting the producer.',
    confidence: 1,
    metadata: init.metadata,
  })
}

function metricNumber(node: RolloutLine, key: string): number | null {
  const value = node.outcome.metrics[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function firstMetricNumber(
  node: RolloutLine,
  keys: readonly string[],
): { key: string; value: number } | null {
  for (const key of keys) {
    const value = metricNumber(node, key)
    if (value !== null) return { key, value }
  }
  return null
}

function treeFindings(
  tree: SupervisorRunTree,
  namespace: string,
  producedAt: string,
): AnalystFinding[] {
  const out: AnalystFinding[] = []

  if (tree.gaps.length > 0) {
    out.push(
      finding({
        producedAt,
        area: 'capture-integrity',
        severity: 'medium',
        subject: 'declared-capture-gaps',
        claim: 'The supervisor tree declares evidence gaps, so some control checks are unavailable',
        rationale: `${tree.gaps.length} declared gap(s): ${tree.gaps.join('; ')}`,
        evidence: countedEvidence(
          namespace,
          'gaps',
          tree.gaps.length,
          tree.gaps.map((gap, index) => metricRef(namespace, `gaps/${index}`, gap)),
        ),
        recommendedAction:
          'Retain or hydrate the named artifacts before using this run to certify control behavior.',
        metadata: {
          assessment: 'unavailable',
          gap_count: tree.gaps.length,
          gap_examples: tree.gaps.slice(0, MAX_EVIDENCE_EXAMPLES),
        },
      }),
    )
  }

  const validated = tree.nodes.map((node, index) => ({
    node,
    index,
    errors: validateRolloutLine(node),
  }))
  for (const row of validated) {
    if (row.errors.length === 0) continue
    out.push(
      finding({
        producedAt,
        area: 'capture-integrity',
        severity: 'high',
        subject: `node-${row.index}:${row.node.rollout_id || '<empty-rollout-id>'}`,
        claim: 'A supervisor-tree node fails canonical rollout validation',
        rationale: row.errors.join('; '),
        evidence: [metricRef(namespace, `nodes/${row.index}/validation`, row.errors)],
        recommendedAction:
          'Fix the producer so every node validates as the existing tangle.rollout.v1 shape before analysis.',
        metadata: { validation_errors: row.errors },
      }),
    )
  }

  // Further checks operate only on valid rows. A malformed row has already
  // been named precisely; interpreting its partial fields would manufacture
  // relationships the canonical type did not establish.
  const nodes = validated.filter((row) => row.errors.length === 0).map((row) => row.node)
  const byId = new Map<string, RolloutLine[]>()
  for (const node of nodes) {
    const rows = byId.get(node.rollout_id) ?? []
    rows.push(node)
    byId.set(node.rollout_id, rows)
  }

  for (const [rolloutId, rows] of byId) {
    if (rows.length < 2) continue
    out.push(
      finding({
        producedAt,
        area: 'control-integrity',
        severity: 'critical',
        subject: rolloutId,
        claim: 'A rollout id is duplicated within one supervisor tree',
        rationale: `${rows.length} nodes claim rollout_id ${JSON.stringify(rolloutId)}, so parent and outcome references are ambiguous.`,
        evidence: countedEvidence(
          namespace,
          `duplicate/${encodeURIComponent(rolloutId)}`,
          rows.length,
          rows.map((node, index) =>
            metricRef(namespace, `duplicate/${encodeURIComponent(rolloutId)}/${index}`, {
              rollout_id: node.rollout_id,
              parent_rollout_id: node.parent_rollout_id,
              role: node.role,
            }),
          ),
        ),
        recommendedAction:
          'Give every invocation one stable rollout id and regenerate the tree from the canonical event source.',
      }),
    )
  }

  const uniquelyIdentifiedNodes = nodes.filter((node) => byId.get(node.rollout_id)?.length === 1)

  if (tree.rootId === null) {
    out.push(
      finding({
        producedAt,
        area: 'capture-integrity',
        severity: 'high',
        subject: 'tree-root',
        claim: 'The supervisor-tree root is unavailable',
        rationale:
          nodes.length === 0
            ? 'rootId is null and no valid invocation nodes were captured.'
            : `rootId is null while ${nodes.length} valid invocation node(s) were captured.`,
        evidence: [metricRef(namespace, 'rootId', tree.rootId)],
        recommendedAction:
          'Capture the root spawned event and preserve its rollout id as SupervisorRunTree.rootId.',
        metadata: { assessment: 'unavailable', valid_nodes: nodes.length },
      }),
    )
  }

  const rootRows = tree.rootId === null ? [] : (byId.get(tree.rootId) ?? [])
  const root = rootRows.length === 1 ? rootRows[0] : undefined
  if (tree.rootId !== null && rootRows.length === 0) {
    out.push(
      finding({
        producedAt,
        area: 'control-integrity',
        severity: 'critical',
        subject: tree.rootId,
        claim: 'The declared supervisor-tree root has no matching invocation node',
        rationale: `rootId ${JSON.stringify(tree.rootId)} is absent from the ${nodes.length} valid node(s).`,
        evidence: [metricRef(namespace, 'rootId', tree.rootId)],
        recommendedAction:
          'Restore the root rollout row or correct rootId to the retained parentless supervisor invocation.',
      }),
    )
  }
  if (root !== undefined) {
    if (root.parent_rollout_id !== null) {
      out.push(
        finding({
          producedAt,
          area: 'control-integrity',
          severity: 'critical',
          subject: root.rollout_id,
          claim: 'The declared supervisor-tree root has a parent',
          rationale: `Root ${JSON.stringify(root.rollout_id)} points to parent ${JSON.stringify(root.parent_rollout_id)}.`,
          evidence: [nodeRef(namespace, root, 'parent_rollout_id', root.parent_rollout_id)],
          recommendedAction: 'Record the root with parent_rollout_id null.',
        }),
      )
    }
    if (root.role !== 'supervisor') {
      out.push(
        finding({
          producedAt,
          area: 'control-integrity',
          severity: 'high',
          subject: root.rollout_id,
          claim: 'The declared supervisor-tree root is not labeled as a supervisor',
          rationale: `Root ${JSON.stringify(root.rollout_id)} has role ${JSON.stringify(root.role)}.`,
          evidence: [nodeRef(namespace, root, 'role', root.role)],
          recommendedAction:
            'Preserve the root invocation role as supervisor when minting rollout rows.',
        }),
      )
    }
  }

  for (const node of uniquelyIdentifiedNodes) {
    if (node.parent_rollout_id === null) {
      if (node.rollout_id !== tree.rootId) {
        out.push(
          finding({
            producedAt,
            area: 'control-integrity',
            severity: 'critical',
            subject: node.rollout_id,
            claim: 'A non-root invocation is recorded as a detached parentless root',
            rationale: `Node ${JSON.stringify(node.rollout_id)} has parent_rollout_id null but SupervisorRunTree.rootId is ${JSON.stringify(tree.rootId)}.`,
            evidence: [
              nodeRef(namespace, node, 'parent_rollout_id', null),
              metricRef(namespace, 'rootId', tree.rootId),
            ],
            recommendedAction:
              'Attach the invocation to its actual spawning parent or record it as a separate supervisor run.',
          }),
        )
      }
      continue
    }

    const parentRows = byId.get(node.parent_rollout_id) ?? []
    if (parentRows.length === 0) {
      out.push(
        finding({
          producedAt,
          area: 'control-integrity',
          severity: 'critical',
          subject: node.rollout_id,
          claim: 'An invocation points to a parent absent from the supervisor tree',
          rationale: `Node ${JSON.stringify(node.rollout_id)} names missing parent ${JSON.stringify(node.parent_rollout_id)}.`,
          evidence: [nodeRef(namespace, node, 'parent_rollout_id', node.parent_rollout_id)],
          recommendedAction:
            'Retain the parent invocation or record this invocation as a separate run instead of preserving a dangling edge.',
        }),
      )
      continue
    }
    if (parentRows.length !== 1) continue

    const parent = parentRows[0] as RolloutLine
    if (parent.role !== 'supervisor') {
      out.push(
        finding({
          producedAt,
          area: 'control-integrity',
          severity: 'high',
          subject: `${parent.rollout_id}->${node.rollout_id}`,
          claim:
            'An invocation not labeled as a supervisor is recorded as the parent of another invocation',
          rationale: `Parent ${JSON.stringify(parent.rollout_id)} has role ${JSON.stringify(parent.role)} but owns child ${JSON.stringify(node.rollout_id)}.`,
          evidence: [
            nodeRef(namespace, parent, 'role', parent.role),
            nodeRef(namespace, node, 'parent_rollout_id', node.parent_rollout_id),
          ],
          recommendedAction:
            'Preserve recursive manager invocations with role supervisor when they own child rollouts.',
        }),
      )
    }
    if (node.run_id !== parent.run_id) {
      out.push(
        finding({
          producedAt,
          area: 'control-integrity',
          severity: 'critical',
          subject: node.rollout_id,
          claim: 'A parent-child edge crosses supervisor-run identities',
          rationale: `Child ${JSON.stringify(node.rollout_id)} has run_id ${JSON.stringify(node.run_id)} while parent ${JSON.stringify(parent.rollout_id)} has run_id ${JSON.stringify(parent.run_id)}.`,
          evidence: [
            nodeRef(namespace, node, 'run_id', node.run_id),
            nodeRef(namespace, parent, 'run_id', parent.run_id),
          ],
          recommendedAction:
            'Keep one run_id across a supervision tree or remove the cross-run parent edge.',
        }),
      )
    }

    const childSpawnedAt = firstMetricNumber(node, ['spawned_at', 'started_at'])
    const parentStartedAt = firstMetricNumber(parent, ['spawned_at', 'started_at'])
    if (
      childSpawnedAt !== null &&
      parentStartedAt !== null &&
      childSpawnedAt.value < parentStartedAt.value
    ) {
      out.push(
        finding({
          producedAt,
          area: 'control-integrity',
          severity: 'high',
          subject: node.rollout_id,
          claim: 'A child invocation is timestamped before its parent started',
          rationale: `Child ${childSpawnedAt.key} ${childSpawnedAt.value} precedes parent ${parentStartedAt.key} ${parentStartedAt.value}.`,
          evidence: [
            nodeRef(namespace, node, `outcome.metrics.${childSpawnedAt.key}`, childSpawnedAt.value),
            nodeRef(
              namespace,
              parent,
              `outcome.metrics.${parentStartedAt.key}`,
              parentStartedAt.value,
            ),
          ],
          recommendedAction:
            'Use one ordered clock for spawn events or retain the source clock metadata needed to reconcile them.',
        }),
      )
    }

    const parentClosedAt = firstMetricNumber(parent, ['settled_at', 'completed_at', 'finished_at'])
    if (
      childSpawnedAt !== null &&
      parentClosedAt !== null &&
      childSpawnedAt.value > parentClosedAt.value
    ) {
      out.push(
        finding({
          producedAt,
          area: 'control-integrity',
          severity: 'critical',
          subject: node.rollout_id,
          claim: 'A child invocation is timestamped after its parent closed',
          rationale: `Child ${childSpawnedAt.key} ${childSpawnedAt.value} follows parent ${parentClosedAt.key} ${parentClosedAt.value}.`,
          evidence: [
            nodeRef(namespace, node, `outcome.metrics.${childSpawnedAt.key}`, childSpawnedAt.value),
            nodeRef(
              namespace,
              parent,
              `outcome.metrics.${parentClosedAt.key}`,
              parentClosedAt.value,
            ),
          ],
          recommendedAction:
            'Correct the causal timestamps or attach the child to the invocation that actually spawned it.',
        }),
      )
    }
  }

  for (const node of uniquelyIdentifiedNodes) {
    const startedAt = firstMetricNumber(node, ['spawned_at', 'started_at'])
    const closedAt = firstMetricNumber(node, ['settled_at', 'completed_at', 'finished_at'])
    if (startedAt === null || closedAt === null || closedAt.value >= startedAt.value) continue
    out.push(
      finding({
        producedAt,
        area: 'control-integrity',
        severity: 'high',
        subject: node.rollout_id,
        claim: 'An invocation is timestamped as closing before it started',
        rationale: `Invocation ${JSON.stringify(node.rollout_id)} has ${startedAt.key} ${startedAt.value} and ${closedAt.key} ${closedAt.value}.`,
        evidence: [
          nodeRef(namespace, node, `outcome.metrics.${startedAt.key}`, startedAt.value),
          nodeRef(namespace, node, `outcome.metrics.${closedAt.key}`, closedAt.value),
        ],
        recommendedAction:
          'Correct the event ordering or preserve clock-domain metadata before computing control latency.',
      }),
    )
  }

  // A cycle is detected only when every traversed id resolves uniquely. If an
  // id is absent or duplicated, the exact ambiguity findings above are the
  // only claims this analyst can make.
  const emittedCycles = new Set<string>()
  const resolvedAncestry = new Set<string>()
  for (const start of uniquelyIdentifiedNodes) {
    if (resolvedAncestry.has(start.rollout_id)) continue
    const path: string[] = []
    const position = new Map<string, number>()
    let current: string | null = start.rollout_id
    while (current !== null) {
      if (resolvedAncestry.has(current)) break
      const existing = position.get(current)
      if (existing !== undefined) {
        const cycle = path.slice(existing)
        const key = [...cycle].sort().join('\u0000')
        if (!emittedCycles.has(key)) {
          emittedCycles.add(key)
          out.push(
            finding({
              producedAt,
              area: 'control-integrity',
              severity: 'critical',
              subject: [...cycle].sort()[0] ?? 'cycle',
              claim: 'The supervisor tree contains a parent cycle',
              rationale: `${cycle.join(' -> ')} -> ${cycle[0]}`,
              evidence: cycle.flatMap((id) => {
                const row = byId.get(id)
                const node = row?.length === 1 ? row[0] : undefined
                return node === undefined
                  ? []
                  : [nodeRef(namespace, node, 'parent_rollout_id', node.parent_rollout_id)]
              }),
              recommendedAction:
                'Correct the parent ids at ingestion; a cyclic graph cannot represent recursive control.',
            }),
          )
        }
        break
      }
      position.set(current, path.length)
      path.push(current)
      const row = byId.get(current)
      if (row?.length !== 1) break
      current = row[0]?.parent_rollout_id ?? null
    }
    for (const id of path) resolvedAncestry.add(id)
  }

  if (root?.outcome.is_completed === true) {
    for (const node of uniquelyIdentifiedNodes) {
      if (node.rollout_id === root.rollout_id) continue
      const terminal =
        node.outcome.is_completed || node.outcome.is_truncated || node.outcome.error !== null
      if (terminal) continue
      out.push(
        finding({
          producedAt,
          area: 'capture-integrity',
          severity: 'high',
          subject: node.rollout_id,
          claim: 'A completed supervisor run has a child with no captured terminal outcome',
          rationale: `Root ${JSON.stringify(root.rollout_id)} is completed, but child ${JSON.stringify(node.rollout_id)} is neither completed, truncated, nor errored. This proves missing terminal evidence, not that the child remained live.`,
          evidence: [
            nodeRef(namespace, root, 'outcome.is_completed', true),
            nodeRef(namespace, node, 'outcome', {
              is_completed: node.outcome.is_completed,
              is_truncated: node.outcome.is_truncated,
              error: node.outcome.error,
            }),
          ],
          recommendedAction:
            'Retain the child settlement or cancellation event before treating the completed tree as fully observed.',
          metadata: { assessment: 'unavailable' },
        }),
      )
    }
  }

  const missingTranscripts = nodes.filter((node) => node.messages.length === 0)
  if (missingTranscripts.length > 0) {
    out.push(
      finding({
        producedAt,
        area: 'capture-integrity',
        severity: 'medium',
        subject: 'decision-transcripts',
        claim: 'Decision transcripts are unavailable for some supervisor-tree invocations',
        rationale: `${missingTranscripts.length}/${nodes.length} valid invocation node(s) have messages: []; authorship and reasoning cannot be assessed for those nodes.`,
        evidence: countedEvidence(
          namespace,
          'capture/missing-transcripts',
          missingTranscripts.length,
          missingTranscripts.map((node) =>
            nodeRef(namespace, node, 'messages', {
              count: node.messages.length,
              gap: node.provenance.gap ?? '<absent>',
            }),
          ),
        ),
        recommendedAction:
          'Hydrate canonical messages from the retained session transcript before asking who chose an action or why.',
        metadata: {
          assessment: 'unavailable',
          unavailable_count: missingTranscripts.length,
          unavailable_rollout_examples: missingTranscripts
            .slice(0, MAX_EVIDENCE_EXAMPLES)
            .map((node) => node.rollout_id),
        },
      }),
    )
  }

  const missingProfiles = nodes.filter(
    (node) =>
      typeof node.policy.agent_profile_cell_id !== 'string' ||
      node.policy.agent_profile_cell_id.length === 0,
  )
  if (missingProfiles.length > 0) {
    out.push(
      finding({
        producedAt,
        area: 'capture-integrity',
        severity: 'medium',
        subject: 'agent-profile-identity',
        claim:
          'Canonical agent-profile identity is unavailable for some supervisor-tree invocations',
        rationale: `${missingProfiles.length}/${nodes.length} valid invocation node(s) omit policy.agent_profile_cell_id, so behavior cannot be attributed to an exact profile cell.`,
        evidence: countedEvidence(
          namespace,
          'capture/missing-agent-profile-cell-id',
          missingProfiles.length,
          missingProfiles.map((node) =>
            nodeRef(
              namespace,
              node,
              'policy.agent_profile_cell_id',
              node.policy.agent_profile_cell_id,
            ),
          ),
        ),
        recommendedAction:
          'Record the existing policy.agent_profile_cell_id on every invocation at dispatch time.',
        metadata: {
          assessment: 'unavailable',
          unavailable_count: missingProfiles.length,
          unavailable_rollout_examples: missingProfiles
            .slice(0, MAX_EVIDENCE_EXAMPLES)
            .map((node) => node.rollout_id),
        },
      }),
    )
  }

  return out
}

function sourceFindings(
  source: SupervisorRunSources,
  tree: SupervisorRunTree,
  namespace: string,
  producedAt: string,
): AnalystFinding[] {
  const out: AnalystFinding[] = []
  const parsed = parseSupervisorTree(source)
  const spawnCounts = new Map<string, number>()
  for (const spawn of parsed.spawns) {
    spawnCounts.set(spawn.id, (spawnCounts.get(spawn.id) ?? 0) + 1)
  }
  const spawnIds = new Set(spawnCounts.keys())
  for (const [id, count] of spawnCounts) {
    if (count < 2) continue
    out.push(
      finding({
        producedAt,
        area: 'control-integrity',
        severity: 'critical',
        subject: id || 'empty-spawn-id',
        claim: 'An invocation has more than one spawned control event',
        rationale: `${count} spawned events name invocation ${JSON.stringify(id)}.`,
        evidence: [metricRef(namespace, `journal/spawn-count/${encodeURIComponent(id)}`, count)],
        recommendedAction:
          'Make spawn event append idempotent so each invocation identity is created exactly once.',
      }),
    )
  }
  const closesById = new Map<string, number>()
  const orphanCloses = new Map<string, (typeof parsed.closes)[number]>()
  for (const close of parsed.closes) {
    closesById.set(close.id, (closesById.get(close.id) ?? 0) + 1)
    if (spawnIds.has(close.id)) continue
    orphanCloses.set(close.id, close)
  }
  for (const close of orphanCloses.values()) {
    out.push(
      finding({
        producedAt,
        area: 'control-integrity',
        severity: 'critical',
        subject: close.id || 'empty-close-id',
        claim: 'A terminal control event names an invocation that was never spawned',
        rationale: `${close.kind} event for ${JSON.stringify(close.id)} has no matching spawned event in the captured journal.`,
        evidence: [
          metricRef(namespace, `journal/closes/${encodeURIComponent(close.id)}`, {
            id: close.id,
            kind: close.kind,
            at: close.at,
          }),
        ],
        recommendedAction:
          'Retain the matching spawn event or reject the orphan terminal event at ingestion.',
      }),
    )
  }
  for (const [id, count] of closesById) {
    if (count < 2) continue
    out.push(
      finding({
        producedAt,
        area: 'control-integrity',
        severity: 'critical',
        subject: id || 'empty-close-id',
        claim: 'An invocation has more than one terminal control event',
        rationale: `${count} settled/cancelled events name invocation ${JSON.stringify(id)}.`,
        evidence: [metricRef(namespace, `journal/terminal-count/${encodeURIComponent(id)}`, count)],
        recommendedAction:
          'Make terminal event append idempotent so each invocation settles or cancels exactly once.',
      }),
    )
  }

  const childCount = parsed.workerSpawns.length
  if (source.workers === null) {
    const reason = source.workersMissingReason ?? 'worker control-log store was not captured'
    out.push(
      finding({
        producedAt,
        area: 'capture-integrity',
        severity: 'medium',
        subject: 'steer-delivery',
        claim:
          'Steer delivery integrity is unavailable because worker control logs were not captured',
        rationale: reason,
        evidence: [metricRef(namespace, 'sources/workers', null)],
        recommendedAction:
          'Retain each worker inbox and event stream before interpreting an absent steer as zero.',
        metadata: { assessment: 'unavailable', reason },
      }),
    )
    return out
  }

  if (childCount === 0) return out

  if (source.workers.length === 0) {
    out.push(
      finding({
        producedAt,
        area: 'capture-integrity',
        severity: 'high',
        subject: 'worker-control-join',
        claim: 'Recorded child invocations have no worker control-log entries',
        rationale: `${childCount} child invocation(s) are present in the tree while SupervisorRunSources.workers is an empty captured list.`,
        evidence: [
          metricRef(namespace, 'tree/child-count', childCount),
          metricRef(namespace, 'sources/workers/count', 0),
        ],
        recommendedAction:
          'Join retained worker logs to the spawned invocations before assessing steering.',
        metadata: { assessment: 'unavailable' },
      }),
    )
    return out
  }

  const labelCounts = new Map<string, number>()
  for (const worker of source.workers) {
    labelCounts.set(worker.label, (labelCounts.get(worker.label) ?? 0) + 1)
  }
  const spawnLabelCounts = new Map<string, number>()
  for (const spawn of parsed.workerSpawns) {
    spawnLabelCounts.set(spawn.label, (spawnLabelCounts.get(spawn.label) ?? 0) + 1)
  }
  const duplicateLabels = [...new Set([...labelCounts.keys(), ...spawnLabelCounts.keys()])]
    .map((label) => ({
      label,
      logCount: labelCounts.get(label) ?? 0,
      spawnCount: spawnLabelCounts.get(label) ?? 0,
    }))
    .filter((row) => row.logCount > 1 || row.spawnCount > 1)
  if (duplicateLabels.length > 0) {
    out.push(
      finding({
        producedAt,
        area: 'capture-integrity',
        severity: 'high',
        subject: 'worker-control-join',
        claim: 'Worker control logs cannot be joined uniquely because labels repeat',
        rationale: duplicateLabels
          .map(
            (row) =>
              `${JSON.stringify(row.label)} has ${row.spawnCount} spawn(s) and ${row.logCount} log row(s)`,
          )
          .join('; '),
        evidence: countedEvidence(
          namespace,
          'sources/workers/ambiguous-labels',
          duplicateLabels.length,
          duplicateLabels.map((row) =>
            metricRef(namespace, `sources/workers/labels/${encodeURIComponent(row.label)}`, row),
          ),
        ),
        recommendedAction:
          'Capture the stable spawned invocation id on each worker log instead of joining by display label.',
        metadata: { assessment: 'unavailable' },
      }),
    )
    return out
  }

  const mismatchedLabels = [...new Set([...labelCounts.keys(), ...spawnLabelCounts.keys()])]
    .map((label) => ({
      label,
      logCount: labelCounts.get(label) ?? 0,
      spawnCount: spawnLabelCounts.get(label) ?? 0,
    }))
    .filter((row) => row.logCount !== row.spawnCount)
  if (mismatchedLabels.length > 0) {
    out.push(
      finding({
        producedAt,
        area: 'capture-integrity',
        severity: 'high',
        subject: 'worker-control-join',
        claim: 'Worker control-log coverage does not match the recorded child invocations',
        rationale: mismatchedLabels
          .map(
            (row) =>
              `${JSON.stringify(row.label)} has ${row.spawnCount} spawn(s) and ${row.logCount} log row(s)`,
          )
          .join('; '),
        evidence: countedEvidence(
          namespace,
          'sources/workers/unmatched-labels',
          mismatchedLabels.length,
          mismatchedLabels.map((row) =>
            metricRef(namespace, `sources/workers/labels/${encodeURIComponent(row.label)}`, row),
          ),
        ),
        recommendedAction:
          'Retain exactly one uniquely joined worker control-log row for every spawned child invocation.',
        metadata: { assessment: 'unavailable' },
      }),
    )
    return out
  }

  const missingArtifacts = source.workers.flatMap((worker) => {
    const missing: string[] = []
    if (worker.inbox === null) missing.push('inbox')
    if (worker.events === null) missing.push('events')
    return missing.length === 0 ? [] : [{ worker: worker.label, missing }]
  })
  if (missingArtifacts.length > 0) {
    out.push(
      finding({
        producedAt,
        area: 'capture-integrity',
        severity: 'medium',
        subject: 'steer-delivery',
        claim: 'Steer delivery integrity is unavailable for workers with missing control artifacts',
        rationale: missingArtifacts
          .map((row) => `${JSON.stringify(row.worker)} missing ${row.missing.join('+')}`)
          .join('; '),
        evidence: countedEvidence(
          namespace,
          'sources/workers/missing-control-artifacts',
          missingArtifacts.length,
          missingArtifacts.flatMap((row) =>
            row.missing.map((artifact) =>
              metricRef(
                namespace,
                `sources/workers/${encodeURIComponent(row.worker)}/${artifact}`,
                null,
              ),
            ),
          ),
        ),
        recommendedAction:
          'Retain both the durable inbox and worker event stream; either missing side makes zero steer delivery unknowable.',
        metadata: { assessment: 'unavailable', missing_artifacts: missingArtifacts },
      }),
    )
    return out
  }

  const report = analyzeSupervisorRunSources(source, () => 0)
  const queued = report.orchestration.steers
  const delivered = report.orchestration.steersDelivered
  if (!isUnavailable(queued) && !isUnavailable(delivered)) {
    if (delivered > queued) {
      out.push(
        finding({
          producedAt,
          area: 'control-integrity',
          severity: 'high',
          subject: 'steer-delivery',
          claim: 'Delivered steer acknowledgements exceed captured queued requests',
          rationale: `${delivered} delivered acknowledgement(s) were captured for ${queued} queued request(s).`,
          evidence: [
            metricRef(namespace, 'orchestration/steers', queued),
            metricRef(namespace, 'orchestration/steersDelivered', delivered),
          ],
          recommendedAction:
            'Reconcile request ids across inbox and event streams before using steer counts.',
        }),
      )
    } else if (rootCompleted(tree) && queued > delivered) {
      out.push(
        finding({
          producedAt,
          area: 'control-integrity',
          severity: 'high',
          subject: 'steer-delivery',
          claim: 'A completed supervisor run has queued steers without delivered acknowledgements',
          rationale: `${queued - delivered} of ${queued} queued steer request(s) have no delivered acknowledgement in the captured worker events.`,
          evidence: [
            metricRef(namespace, 'orchestration/steers', queued),
            metricRef(namespace, 'orchestration/steersDelivered', delivered),
          ],
          recommendedAction:
            'Correlate every queued request id with a delivered or explicitly failed terminal event.',
        }),
      )
    }
  }

  return out
}

function rootCompleted(tree: SupervisorRunTree): boolean {
  if (tree.rootId === null) return false
  const roots = tree.nodes.filter((node) => node.rollout_id === tree.rootId)
  return roots.length === 1 && roots[0]?.outcome.is_completed === true
}

/**
 * Pure deterministic pass over an existing supervisor-run source or tree.
 *
 * An empty result means only that none of the implemented structural checks
 * fired on the captured fields. It does not certify action authorization,
 * agent authorship, budget enforcement, or decision quality.
 */
export function emitControlIntegrityFindings(
  input: SupervisorRunSources | SupervisorRunTree,
  producedAt: string,
): AnalystFinding[] {
  let source: SupervisorRunSources | undefined
  let tree: SupervisorRunTree
  if (isTree(input)) {
    tree = input
  } else {
    source = input
    tree = supervisorRunRolloutLines(source, { capturedAt: producedAt })
  }
  const namespace = source?.runRef ?? tree.rootId ?? 'unidentified-tree'
  return [
    ...treeFindings(tree, namespace, producedAt),
    ...(source === undefined ? [] : sourceFindings(source, tree, namespace, producedAt)),
  ]
}

/** Deterministic Analyst adapter for `SupervisorRunSources | SupervisorRunTree`. */
export class ControlIntegrityAnalyst implements Analyst<SupervisorRunSources | SupervisorRunTree> {
  readonly id = ANALYST_ID
  readonly description =
    'Deterministic supervisor-tree integrity checks with explicit unavailable evidence and no claims about uncaptured authority or intent.'
  readonly inputKind = 'custom' as const
  readonly cost = { kind: 'deterministic' as const, est_usd_per_run: 0 }
  readonly version = '1.0.0'

  async analyze(
    input: SupervisorRunSources | SupervisorRunTree,
    ctx: AnalystContext,
  ): Promise<AnalystFinding[]> {
    const producedAt = ctx.tags?.producedAt ?? new Date().toISOString()
    const findings = emitControlIntegrityFindings(input, producedAt)
    ctx.log?.(`control-integrity: ${findings.length} finding(s)`, {
      input: isTree(input) ? 'SupervisorRunTree' : 'SupervisorRunSources',
    })
    return findings
  }
}

export const CONTROL_INTEGRITY_ANALYST = new ControlIntegrityAnalyst()
