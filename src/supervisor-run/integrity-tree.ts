import { validateRolloutLine } from '../rollout/schema'
import { evidence, issue, MAX_EXAMPLES } from './integrity-issues'
import type { SupervisorRunIntegrityEvidence, SupervisorRunIntegrityIssue } from './integrity-types'
import type { SupervisorRunTree } from './types'

interface NodeRecord {
  readonly index: number
  readonly raw: Record<string, unknown>
  readonly errors: readonly string[]
  readonly id: string | null
  readonly parent: string | null | undefined
  readonly runId: string | null
  readonly role: string | null
  readonly messages: readonly unknown[] | null
  readonly profileId: string | null
  readonly completed: boolean | null
  readonly terminal: boolean | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function parentValue(raw: Record<string, unknown>): string | null | undefined {
  if (raw.parent_rollout_id === null) return null
  return nonEmptyString(raw.parent_rollout_id) ?? undefined
}

function terminalValue(outcome: Record<string, unknown> | null): boolean | null {
  if (outcome === null) return null
  if (typeof outcome.is_completed !== 'boolean' || typeof outcome.is_truncated !== 'boolean') {
    return null
  }
  if (outcome.error !== null && typeof outcome.error !== 'string') return null
  return outcome.is_completed || outcome.is_truncated || outcome.error !== null
}

function nodeRecord(value: unknown, index: number): NodeRecord {
  const raw = isRecord(value) ? value : {}
  const policy = isRecord(raw.policy) ? raw.policy : null
  const outcome = isRecord(raw.outcome) ? raw.outcome : null
  return {
    index,
    raw,
    errors: validateRolloutLine(value),
    id: nonEmptyString(raw.rollout_id),
    parent: parentValue(raw),
    runId: nonEmptyString(raw.run_id),
    role: nonEmptyString(raw.role),
    messages: Array.isArray(raw.messages) ? raw.messages : null,
    profileId: policy === null ? null : nonEmptyString(policy.agent_profile_cell_id),
    completed:
      outcome !== null && typeof outcome.is_completed === 'boolean' ? outcome.is_completed : null,
    terminal: terminalValue(outcome),
  }
}

function metric(
  record: NodeRecord,
  keys: readonly string[],
): { key: string; value: number } | null {
  const outcome = isRecord(record.raw.outcome) ? record.raw.outcome : null
  const metrics = outcome !== null && isRecord(outcome.metrics) ? outcome.metrics : null
  if (metrics === null) return null
  for (const key of keys) {
    const value = metrics[key]
    if (typeof value === 'number' && Number.isFinite(value)) return { key, value }
  }
  return null
}

function nodeEvidence(
  record: NodeRecord,
  path: string,
  value: unknown,
): SupervisorRunIntegrityEvidence {
  const key = record.id ?? `index-${record.index}`
  return evidence(`nodes/${encodeURIComponent(key)}/${path}`, value)
}

function unavailableNodeChecks(record: NodeRecord): string[] {
  const checks: string[] = []
  if (record.id === null) checks.push('identity', 'root-membership', 'parent-link', 'cycle')
  if (record.parent === undefined) checks.push('parent-link', 'cycle')
  if (record.runId === null) checks.push('cross-run-parent')
  if (record.role === null) checks.push('root-role')
  if (!isRecord(record.raw.outcome)) checks.push('timing', 'terminal-state')
  return [...new Set(checks)]
}

interface TreeIssueUncertainty {
  readonly unknownIdentityRows?: number
  readonly uncertainIds?: ReadonlySet<string>
}

export function treeIssues(
  tree: SupervisorRunTree,
  uncertainty: TreeIssueUncertainty = {},
): SupervisorRunIntegrityIssue[] {
  const out: SupervisorRunIntegrityIssue[] = []
  const records = (tree.nodes as readonly unknown[]).map(nodeRecord)
  const malformedSourceRows = tree.gaps
    .filter((gap) => gap.code === 'source-row-malformed')
    .reduce((count, gap) => count + (gap.count ?? 1), 0)

  for (const record of records) {
    if (record.errors.length === 0) continue
    out.push(
      issue({
        code: 'node-schema-invalid',
        area: 'capture-integrity',
        severity: 'high',
        subject: record.id ?? `node-${record.index}`,
        claim: 'A supervisor-tree node fails canonical rollout validation',
        detail: record.errors.join('; '),
        evidence: [evidence(`nodes/${record.index}/validation`, record.errors)],
        recommendedAction:
          'Fix the producer so every node validates as the existing tangle.rollout.v1 shape before analysis.',
        metadata: { validation_errors: record.errors },
      }),
    )
    const unavailableChecks = unavailableNodeChecks(record)
    if (unavailableChecks.length === 0) continue
    out.push(
      issue({
        code: 'node-checks-unavailable',
        area: 'capture-integrity',
        severity: 'medium',
        subject: record.id ?? `node-${record.index}`,
        claim: 'Some integrity checks are unavailable for a malformed supervisor-tree node',
        detail: `Unavailable checks: ${unavailableChecks.join(', ')}.`,
        evidence: [evidence(`nodes/${record.index}/unavailable-checks`, unavailableChecks)],
        recommendedAction:
          'Retain the named identity and relationship fields with their canonical types.',
        metadata: { assessment: 'unavailable', checks: unavailableChecks },
      }),
    )
  }

  const byId = new Map<string, NodeRecord[]>()
  for (const record of records) {
    if (record.id === null) continue
    const matches = byId.get(record.id) ?? []
    matches.push(record)
    byId.set(record.id, matches)
  }

  for (const [rolloutId, matches] of byId) {
    if (matches.length < 2) continue
    out.push(
      issue({
        code: 'duplicate-rollout-id',
        area: 'control-integrity',
        severity: 'critical',
        subject: rolloutId,
        claim: 'A rollout id is duplicated within one supervisor tree',
        detail: `${matches.length} nodes claim rollout_id ${JSON.stringify(rolloutId)}, so references are ambiguous.`,
        evidence: [
          evidence(`duplicates/${encodeURIComponent(rolloutId)}/count`, matches.length),
          ...matches.slice(0, MAX_EXAMPLES).map((record) =>
            evidence(`nodes/${record.index}/identity`, {
              rollout_id: record.id,
              parent_rollout_id: record.parent,
              role: record.role,
            }),
          ),
        ],
        recommendedAction: 'Give every invocation one stable rollout id and regenerate the tree.',
      }),
    )
  }

  const unknownIdentityRows =
    records.filter((record) => record.id === null).length +
    Math.max(malformedSourceRows, uncertainty.unknownIdentityRows ?? 0)
  const unique = records.filter(
    (record): record is NodeRecord & { readonly id: string } =>
      record.id !== null && byId.get(record.id)?.length === 1,
  )

  let root: NodeRecord | undefined
  if (tree.rootId === null) {
    out.push(
      issue({
        code: 'root-unavailable',
        area: 'capture-integrity',
        severity: 'high',
        subject: 'tree-root',
        claim: 'The supervisor-tree root is unavailable',
        detail: `rootId is null while ${records.length} node row(s) were captured.`,
        evidence: [evidence('rootId', null)],
        recommendedAction: 'Capture the root spawned event and preserve its rollout id as rootId.',
        metadata: { assessment: 'unavailable', node_rows: records.length },
      }),
    )
  } else {
    const rootRows = byId.get(tree.rootId) ?? []
    if (rootRows.length === 1) {
      root = rootRows[0]
    } else if (rootRows.length === 0 && unknownIdentityRows > 0) {
      out.push(
        issue({
          code: 'node-checks-unavailable',
          area: 'capture-integrity',
          severity: 'high',
          subject: tree.rootId,
          claim: 'Root membership is unavailable because a malformed node lost its rollout id',
          detail: `${unknownIdentityRows} malformed node row(s) have no usable rollout_id, so absence of root ${JSON.stringify(tree.rootId)} cannot be established.`,
          evidence: [evidence('rootId', tree.rootId)],
          recommendedAction: 'Retain rollout_id even when another node field fails validation.',
          metadata: { assessment: 'unavailable', checks: ['root-membership'] },
        }),
      )
    } else if (rootRows.length === 0) {
      out.push(
        issue({
          code: 'declared-root-missing',
          area: 'control-integrity',
          severity: 'critical',
          subject: tree.rootId,
          claim: 'The declared supervisor-tree root has no matching invocation node',
          detail: `rootId ${JSON.stringify(tree.rootId)} is absent from ${records.length} node row(s).`,
          evidence: [evidence('rootId', tree.rootId)],
          recommendedAction: 'Restore the root rollout row or correct rootId.',
        }),
      )
    }
  }

  if (root !== undefined) {
    if (root.parent !== undefined && root.parent !== null) {
      out.push(
        issue({
          code: 'root-has-parent',
          area: 'control-integrity',
          severity: 'critical',
          subject: root.id ?? tree.rootId ?? 'tree-root',
          claim: 'The declared supervisor-tree root has a parent',
          detail: `Root points to parent ${JSON.stringify(root.parent)}.`,
          evidence: [nodeEvidence(root, 'parent_rollout_id', root.parent)],
          recommendedAction: 'Record the root with parent_rollout_id null.',
        }),
      )
    }
    if (root.role !== null && root.role !== 'supervisor') {
      out.push(
        issue({
          code: 'root-role-invalid',
          area: 'control-integrity',
          severity: 'high',
          subject: root.id ?? tree.rootId ?? 'tree-root',
          claim: 'The declared supervisor-tree root is not labeled as a supervisor',
          detail: `Root has role ${JSON.stringify(root.role)}.`,
          evidence: [nodeEvidence(root, 'role', root.role)],
          recommendedAction:
            'Preserve the root invocation role as supervisor when minting rollout rows.',
        }),
      )
    }
  }

  for (const record of unique) {
    if (record.parent === undefined) continue
    if (record.parent === null) {
      if (record.id !== tree.rootId) {
        out.push(
          issue({
            code: 'detached-node',
            area: 'control-integrity',
            severity: 'critical',
            subject: record.id,
            claim: 'A non-root invocation is recorded as a detached parentless root',
            detail: `Node ${JSON.stringify(record.id)} is parentless while rootId is ${JSON.stringify(tree.rootId)}.`,
            evidence: [
              nodeEvidence(record, 'parent_rollout_id', null),
              evidence('rootId', tree.rootId),
            ],
            recommendedAction:
              'Attach the invocation to its spawning parent or record a separate run.',
          }),
        )
      }
      continue
    }

    const parentRows = byId.get(record.parent) ?? []
    if (parentRows.length === 0) {
      if (unknownIdentityRows > 0 || uncertainty.uncertainIds?.has(record.parent) === true) {
        out.push(
          issue({
            code: 'node-checks-unavailable',
            area: 'capture-integrity',
            severity: 'high',
            subject: record.id,
            claim: 'Parent membership is unavailable because a malformed node lost its rollout id',
            detail:
              uncertainty.uncertainIds?.has(record.parent) === true
                ? `Parent ${JSON.stringify(record.parent)} appears only in a malformed source row, so its absence cannot be established.`
                : `Parent ${JSON.stringify(record.parent)} cannot be matched while ${unknownIdentityRows} row(s) have no usable rollout_id.`,
            evidence: [nodeEvidence(record, 'parent_rollout_id', record.parent)],
            recommendedAction: 'Retain rollout_id on every row before assessing detached children.',
            metadata: { assessment: 'unavailable', checks: ['parent-membership'] },
          }),
        )
      } else {
        out.push(
          issue({
            code: 'parent-missing',
            area: 'control-integrity',
            severity: 'critical',
            subject: record.id,
            claim: 'An invocation points to a parent absent from the supervisor tree',
            detail: `Node ${JSON.stringify(record.id)} names missing parent ${JSON.stringify(record.parent)}.`,
            evidence: [nodeEvidence(record, 'parent_rollout_id', record.parent)],
            recommendedAction: 'Retain the parent invocation or remove the dangling edge.',
          }),
        )
      }
      continue
    }
    if (parentRows.length !== 1) continue
    const parent = parentRows[0] as NodeRecord

    if (record.runId !== null && parent.runId !== null && record.runId !== parent.runId) {
      out.push(
        issue({
          code: 'cross-run-parent',
          area: 'control-integrity',
          severity: 'critical',
          subject: record.id,
          claim: 'A parent-child edge crosses supervisor-run identities',
          detail: `Child run_id ${JSON.stringify(record.runId)} differs from parent run_id ${JSON.stringify(parent.runId)}.`,
          evidence: [
            nodeEvidence(record, 'run_id', record.runId),
            nodeEvidence(parent, 'run_id', parent.runId),
          ],
          recommendedAction:
            'Keep one run_id across a supervision tree or remove the cross-run edge.',
        }),
      )
    }

    const childStart = metric(record, ['spawned_at', 'started_at'])
    const parentStart = metric(parent, ['spawned_at', 'started_at'])
    if (childStart !== null && parentStart !== null && childStart.value < parentStart.value) {
      out.push(
        issue({
          code: 'child-before-parent',
          area: 'control-integrity',
          severity: 'high',
          subject: record.id,
          claim: 'A child invocation is timestamped before its parent started',
          detail: `Child ${childStart.key} ${childStart.value} precedes parent ${parentStart.key} ${parentStart.value}.`,
          evidence: [
            nodeEvidence(record, `outcome.metrics.${childStart.key}`, childStart.value),
            nodeEvidence(parent, `outcome.metrics.${parentStart.key}`, parentStart.value),
          ],
          recommendedAction: 'Use one ordered clock for spawn events or retain clock metadata.',
        }),
      )
    }

    const parentClose = metric(parent, ['settled_at', 'completed_at', 'finished_at'])
    if (childStart !== null && parentClose !== null && childStart.value > parentClose.value) {
      out.push(
        issue({
          code: 'child-after-parent-close',
          area: 'control-integrity',
          severity: 'critical',
          subject: record.id,
          claim: 'A child invocation is timestamped after its parent closed',
          detail: `Child ${childStart.key} ${childStart.value} follows parent ${parentClose.key} ${parentClose.value}.`,
          evidence: [
            nodeEvidence(record, `outcome.metrics.${childStart.key}`, childStart.value),
            nodeEvidence(parent, `outcome.metrics.${parentClose.key}`, parentClose.value),
          ],
          recommendedAction:
            'Correct the causal timestamps or attach the child to its actual spawner.',
        }),
      )
    }
  }

  for (const record of unique) {
    const start = metric(record, ['spawned_at', 'started_at'])
    const close = metric(record, ['settled_at', 'completed_at', 'finished_at'])
    if (start === null || close === null || close.value >= start.value) continue
    out.push(
      issue({
        code: 'close-before-start',
        area: 'control-integrity',
        severity: 'high',
        subject: record.id,
        claim: 'An invocation is timestamped as closing before it started',
        detail: `${start.key} is ${start.value} and ${close.key} is ${close.value}.`,
        evidence: [
          nodeEvidence(record, `outcome.metrics.${start.key}`, start.value),
          nodeEvidence(record, `outcome.metrics.${close.key}`, close.value),
        ],
        recommendedAction: 'Correct the event ordering or retain clock-domain metadata.',
      }),
    )
  }

  const emittedCycles = new Set<string>()
  const resolved = new Set<string>()
  for (const start of unique) {
    if (resolved.has(start.id)) continue
    const path: string[] = []
    const positions = new Map<string, number>()
    let current: string | null = start.id
    while (current !== null) {
      if (resolved.has(current)) break
      const position = positions.get(current)
      if (position !== undefined) {
        const cycle = path.slice(position)
        const key = [...cycle].sort().join('\u0000')
        if (!emittedCycles.has(key)) {
          emittedCycles.add(key)
          out.push(
            issue({
              code: 'parent-cycle',
              area: 'control-integrity',
              severity: 'critical',
              subject: [...cycle].sort()[0] ?? 'cycle',
              claim: 'The supervisor tree contains a parent cycle',
              detail: `${cycle.join(' -> ')} -> ${cycle[0]}`,
              evidence: cycle.slice(0, MAX_EXAMPLES).flatMap((id) => {
                const rows = byId.get(id)
                const record = rows?.length === 1 ? rows[0] : undefined
                return record === undefined
                  ? []
                  : [nodeEvidence(record, 'parent_rollout_id', record.parent)]
              }),
              recommendedAction:
                'Correct parent ids at ingestion; a cyclic graph is not a run tree.',
            }),
          )
        }
        break
      }
      positions.set(current, path.length)
      path.push(current)
      const rows = byId.get(current)
      if (rows?.length !== 1) break
      const parent = rows[0]?.parent
      if (parent === undefined) break
      current = parent
    }
    for (const id of path) resolved.add(id)
  }

  if (root?.completed === true) {
    const missingTerminal = unique.filter(
      (record) => record.id !== root?.id && record.terminal === false,
    )
    if (missingTerminal.length > 0) {
      out.push(
        issue({
          code: 'child-terminal-unavailable',
          area: 'capture-integrity',
          severity: 'high',
          subject: 'child-terminal-outcomes',
          claim: 'A completed supervisor run has children with no captured terminal outcome',
          detail: `${missingTerminal.length}/${Math.max(0, unique.length - 1)} child node(s) are neither completed, truncated, nor errored.`,
          evidence: [
            evidence('children/missing-terminal/count', missingTerminal.length),
            ...missingTerminal
              .slice(0, MAX_EXAMPLES)
              .map((record) => nodeEvidence(record, 'outcome', record.raw.outcome)),
          ],
          recommendedAction: 'Retain each child settlement or cancellation event.',
          metadata: { assessment: 'unavailable', unavailable_count: missingTerminal.length },
        }),
      )
    }
  }

  const missingTranscripts = records.filter((record) => record.messages?.length === 0)
  if (missingTranscripts.length > 0) {
    out.push(
      issue({
        code: 'transcript-unavailable',
        area: 'capture-integrity',
        severity: 'medium',
        subject: 'decision-transcripts',
        claim: 'Decision transcripts are unavailable for some supervisor-tree invocations',
        detail: `${missingTranscripts.length}/${records.length} node row(s) have messages: [].`,
        evidence: [
          evidence('capture/missing-transcripts/count', missingTranscripts.length),
          ...missingTranscripts
            .slice(0, MAX_EXAMPLES)
            .map((record) => nodeEvidence(record, 'messages', [])),
        ],
        recommendedAction: 'Hydrate canonical messages from the retained session transcript.',
        metadata: { assessment: 'unavailable', unavailable_count: missingTranscripts.length },
      }),
    )
  }

  const missingProfiles = records.filter((record) => record.profileId === null)
  if (missingProfiles.length > 0) {
    out.push(
      issue({
        code: 'profile-id-unavailable',
        area: 'capture-integrity',
        severity: 'medium',
        subject: 'agent-profile-identity',
        claim:
          'Canonical agent-profile identity is unavailable for some supervisor-tree invocations',
        detail: `${missingProfiles.length}/${records.length} node row(s) omit policy.agent_profile_cell_id.`,
        evidence: [
          evidence('capture/missing-agent-profile-cell-id/count', missingProfiles.length),
          ...missingProfiles
            .slice(0, MAX_EXAMPLES)
            .map((record) => nodeEvidence(record, 'policy.agent_profile_cell_id', null)),
        ],
        recommendedAction:
          'Record policy.agent_profile_cell_id on every invocation at dispatch time.',
        metadata: { assessment: 'unavailable', unavailable_count: missingProfiles.length },
      }),
    )
  }

  return out
}
