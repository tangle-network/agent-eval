import { describe, expect, it } from 'vitest'
import { ROLLOUT_SCHEMA, type RolloutLine } from '../../rollout/schema'
import {
  fixtureJournal,
  fixtureSources,
  fixtureState,
  fixtureWorker,
} from '../../supervisor-run/fixtures'
import type { SupervisorRunTree } from '../../supervisor-run/types'
import { AnalystRegistry } from '../registry'
import type { AnalystFinding } from '../types'
import { CONTROL_INTEGRITY_ANALYST, emitControlIntegrityFindings } from './control-integrity'

const AT = '2026-07-29T18:00:00.000Z'

function node(
  rolloutId: string,
  over: Partial<RolloutLine> & Pick<RolloutLine, 'parent_rollout_id' | 'role'>,
): RolloutLine {
  const { parent_rollout_id, role, ...rest } = over
  return {
    schema: ROLLOUT_SCHEMA,
    rollout_id: rolloutId,
    parent_rollout_id,
    run_id: 'run-1',
    experiment_id: null,
    candidate_id: null,
    generation: null,
    candidate_index: null,
    role,
    task: {
      suite: 'supervisor-run',
      instance_id: 'instance-1',
      split: 'search',
      seed: 7,
      rep: 0,
    },
    policy: {
      harness: 'test',
      harness_version: '1',
      model: 'test/model@1',
      provider: 'test',
      profile_commit: 'profile-commit',
      agent_profile_cell_id: `profile:${rolloutId}`,
      sampling: {},
    },
    messages: [{ role: 'user', content: `task for ${rolloutId}` }],
    tool_defs: [],
    outcome: {
      reward: null,
      reward_source: null,
      verdict: null,
      metrics: {},
      is_completed: false,
      is_truncated: false,
      error: null,
      realness_gated: false,
    },
    cost: {
      usd: null,
      tokens_in: null,
      tokens_out: null,
      tokens_reasoning: null,
      cache_read: null,
      cache_write: null,
      wall_s: null,
    },
    artifacts: { patch_path: null, run_dir: null, transcript_ref: `session:${rolloutId}` },
    provenance: { captured_at: AT, capture: 'settle-time' },
    ...rest,
  }
}

function tree(
  nodes: RolloutLine[],
  rootId: string | null = 'root',
  gaps: string[] = [],
): SupervisorRunTree {
  return { rootId, nodes, gaps }
}

function claims(findings: AnalystFinding[]): string[] {
  return findings.map((finding) => finding.claim)
}

describe('control-integrity analyst', () => {
  it('emits no false positives for one complete, connected, ordered tree', () => {
    const root = node('root', {
      parent_rollout_id: null,
      role: 'supervisor',
      outcome: {
        ...node('unused', { parent_rollout_id: null, role: 'supervisor' }).outcome,
        metrics: { started_at: 100, completed_at: 300 },
        is_completed: true,
      },
    })
    const worker = node('worker', {
      parent_rollout_id: 'root',
      role: 'worker',
      outcome: {
        ...node('unused', { parent_rollout_id: null, role: 'worker' }).outcome,
        metrics: { spawned_at: 120, settled_at: 250 },
        is_completed: true,
      },
    })

    expect(emitControlIntegrityFindings(tree([root, worker]), AT)).toEqual([])
  })

  it('reports absent capture as unavailable instead of a zero or a safe result', () => {
    const findings = emitControlIntegrityFindings(
      fixtureSources({
        supRunDir: null,
        journal: null,
        workers: null,
        workersMissingReason: 'worker store was not retained',
      }),
      AT,
    )

    expect(claims(findings)).toContain('The supervisor-tree root is unavailable')
    expect(claims(findings)).toContain(
      'Steer delivery integrity is unavailable because worker control logs were not captured',
    )
    expect(findings.some((finding) => finding.metadata?.assessment === 'unavailable')).toBe(true)
    expect(claims(findings).some((claim) => /safe|zero steers|no violation/i.test(claim))).toBe(
      false,
    )
  })

  it('detects duplicate identity and a dangling parent with exact field evidence', () => {
    const root = node('root', { parent_rollout_id: null, role: 'supervisor' })
    const duplicateA = node('same', { parent_rollout_id: 'root', role: 'worker' })
    const duplicateB = node('same', { parent_rollout_id: 'root', role: 'worker' })
    const orphan = node('orphan', { parent_rollout_id: 'missing', role: 'worker' })
    const findings = emitControlIntegrityFindings(tree([root, duplicateA, duplicateB, orphan]), AT)

    const duplicate = findings.find((finding) => finding.claim.includes('rollout id is duplicated'))
    const dangling = findings.find((finding) => finding.claim.includes('parent absent'))
    expect(duplicate?.severity).toBe('critical')
    expect(duplicate?.evidence_refs).toHaveLength(3)
    expect(dangling?.severity).toBe('critical')
    expect(dangling?.evidence_refs[0]?.uri).toContain('parent_rollout_id')
    expect(dangling?.evidence_refs[0]?.excerpt).toBe('"missing"')
  })

  it('detects recursive role corruption and parent cycles without guessing intent', () => {
    const root = node('root', { parent_rollout_id: null, role: 'supervisor' })
    const workerParent = node('worker-parent', {
      parent_rollout_id: 'root',
      role: 'worker',
    })
    const child = node('child', { parent_rollout_id: 'worker-parent', role: 'worker' })
    const sibling = node('sibling', { parent_rollout_id: 'worker-parent', role: 'worker' })
    const cycleA = node('cycle-a', { parent_rollout_id: 'cycle-b', role: 'supervisor' })
    const cycleB = node('cycle-b', { parent_rollout_id: 'cycle-a', role: 'supervisor' })
    const findings = emitControlIntegrityFindings(
      tree([root, workerParent, child, sibling, cycleA, cycleB]),
      AT,
    )

    expect(claims(findings)).toContain(
      'An invocation not labeled as a supervisor is recorded as the parent of another invocation',
    )
    expect(claims(findings)).toContain('The supervisor tree contains a parent cycle')
    expect(new Set(findings.map((finding) => finding.finding_id)).size).toBe(findings.length)
    expect(claims(findings).some((claim) => /who chose|authorized|hardcoded/i.test(claim))).toBe(
      false,
    )
  })

  it('walks a 10,000-node recursive chain without recursion or repeated ancestry scans', () => {
    const nodes: RolloutLine[] = [node('root', { parent_rollout_id: null, role: 'supervisor' })]
    for (let index = 1; index < 10_000; index += 1) {
      nodes.push(
        node(`node-${index}`, {
          parent_rollout_id: index === 1 ? 'root' : `node-${index - 1}`,
          role: index === 9_999 ? 'worker' : 'supervisor',
        }),
      )
    }

    expect(emitControlIntegrityFindings(tree(nodes), AT)).toEqual([])
  })

  it('detects cross-run and impossible temporal parent edges', () => {
    const root = node('root', {
      parent_rollout_id: null,
      role: 'supervisor',
      outcome: {
        ...node('unused', { parent_rollout_id: null, role: 'supervisor' }).outcome,
        metrics: { started_at: 100, completed_at: 200 },
      },
    })
    const child = node('child', {
      parent_rollout_id: 'root',
      role: 'worker',
      run_id: 'run-2',
      outcome: {
        ...node('unused', { parent_rollout_id: null, role: 'worker' }).outcome,
        metrics: { started_at: 250, settled_at: 240 },
      },
    })
    const findings = emitControlIntegrityFindings(tree([root, child]), AT)

    expect(claims(findings)).toEqual(
      expect.arrayContaining([
        'A parent-child edge crosses supervisor-run identities',
        'A child invocation is timestamped after its parent closed',
        'An invocation is timestamped as closing before it started',
      ]),
    )
    const afterClose = findings.find((finding) =>
      finding.claim.includes('timestamped after its parent closed'),
    )
    expect(afterClose?.evidence_refs.map((ref) => ref.uri)).toEqual([
      'supervisor-run://root/nodes/child/outcome.metrics.started_at',
      'supervisor-run://root/nodes/root/outcome.metrics.completed_at',
    ])
  })

  it('does not turn missing worker control artifacts into zero steers', () => {
    const worker = fixtureWorker('worker', { startSec: 1, finishSec: 4, patchBytes: 10 })
    const findings = emitControlIntegrityFindings(
      fixtureSources({
        journal: fixtureJournal({ workers: [['worker', 1, 4]] }),
        state: fixtureState({ startSec: 0, endSec: 5 }),
        workers: [{ ...worker, inbox: null }],
      }),
      AT,
    )

    expect(claims(findings)).toContain(
      'Steer delivery integrity is unavailable for workers with missing control artifacts',
    )
    expect(
      claims(findings).some((claim) => claim.includes('queued steers without delivered')),
    ).toBe(false)
  })

  it('does not assess steer delivery from a partial worker-log join', () => {
    const findings = emitControlIntegrityFindings(
      fixtureSources({
        journal: fixtureJournal({
          workers: [
            ['worker-a', 1, 4],
            ['worker-b', 2, 5],
          ],
        }),
        state: fixtureState({ startSec: 0, endSec: 6 }),
        workers: [
          {
            ...fixtureWorker('worker-a', { startSec: 1, finishSec: 4, steers: ['change'] }),
          },
        ],
      }),
      AT,
    )

    expect(claims(findings)).toContain(
      'Worker control-log coverage does not match the recorded child invocations',
    )
    expect(
      claims(findings).some((claim) => claim.includes('queued steers without delivered')),
    ).toBe(false)
  })

  it('detects a queued steer without a delivered acknowledgement only after completion', () => {
    const worker = fixtureWorker('worker', {
      startSec: 1,
      finishSec: 4,
      patchBytes: 10,
      steers: ['change direction'],
    })
    const findings = emitControlIntegrityFindings(
      fixtureSources({
        journal: fixtureJournal({ workers: [['worker', 1, 4]] }),
        state: fixtureState({ startSec: 0, endSec: 5 }),
        workers: [
          {
            ...worker,
            events: worker.events?.replace('"delivered":true', '"delivered":false') ?? null,
          },
        ],
      }),
      AT,
    )

    const lost = findings.find((finding) =>
      finding.claim.includes('queued steers without delivered acknowledgements'),
    )
    expect(lost?.severity).toBe('high')
    expect(lost?.rationale).toContain('1 of 1')
    expect(lost?.evidence_refs.map((ref) => ref.excerpt)).toEqual(['1', '0'])
  })

  it('detects orphan and duplicate terminal journal events', () => {
    const journal = [
      fixtureJournal({ workers: [['worker', 1, 4]] }).trim(),
      JSON.stringify({ kind: 'settled', id: 'orphan', status: 'done', at: AT }),
      JSON.stringify({ kind: 'settled', id: 'orphan', status: 'done', at: AT }),
    ].join('\n')
    const findings = emitControlIntegrityFindings(
      fixtureSources({
        journal,
        workers: [fixtureWorker('worker', { startSec: 1, finishSec: 4 })],
      }),
      AT,
    )

    expect(claims(findings)).toEqual(
      expect.arrayContaining([
        'A terminal control event names an invocation that was never spawned',
        'An invocation has more than one terminal control event',
      ]),
    )
  })

  it('routes through AnalystRegistry as a zero-cost custom analyst with stable ids', async () => {
    const input = tree([], null, ['journal unavailable'])
    const registry = new AnalystRegistry()
    registry.register(CONTROL_INTEGRITY_ANALYST)
    const result = await registry.run(
      'run-1',
      { custom: { 'control-integrity': input } },
      { tags: { producedAt: AT } },
    )
    const repeated = emitControlIntegrityFindings(input, '2099-01-01T00:00:00.000Z')

    expect(result.per_analyst).toEqual([
      expect.objectContaining({
        analyst_id: 'control-integrity',
        status: 'ok',
        usage: expect.objectContaining({ cost: { kind: 'observed', usd: 0 } }),
      }),
    ])
    expect(result.findings[0]?.finding_id).toBe(repeated[0]?.finding_id)
    expect(result.findings.every((finding) => finding.schema_version === '1.0.0')).toBe(true)
  })
})
