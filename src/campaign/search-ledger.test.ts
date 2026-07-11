import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  openSearchLedger,
  type SearchArtifactRef,
  type SearchCandidateDecidedEvent,
  type SearchCandidateRegisteredEvent,
  type SearchCandidateSlotClosedEvent,
  type SearchCompletedEvent,
  type SearchCostAccounting,
  SearchLedgerConflictError,
  SearchLedgerIntegrityError,
  type SearchOperationRecordedEvent,
  type SearchPlannedEvent,
  type SearchSurfaceEvidence,
  type SearchTaskAttemptedEvent,
  type SearchTaskOutcome,
  validateSearchLedgerEvent,
} from './search-ledger'

const HASHES = {
  proposal: `sha256:${'1'.repeat(64)}` as const,
  profile: `sha256:${'2'.repeat(64)}` as const,
  code: `sha256:${'3'.repeat(64)}` as const,
  run: `sha256:${'4'.repeat(64)}` as const,
  trace: `sha256:${'5'.repeat(64)}` as const,
  decision: `sha256:${'6'.repeat(64)}` as const,
  report: `sha256:${'7'.repeat(64)}` as const,
}

const REVISIONS = {
  proposer: 'a'.repeat(40),
  agent: 'b'.repeat(40),
  benchmark: 'c'.repeat(40),
  task: 'd'.repeat(40),
}

function artifact(role: string, sha256: SearchArtifactRef['sha256']): SearchArtifactRef {
  return { role, uri: `artifact://${role}`, sha256, byteLength: 128 }
}

function plan(
  options: {
    candidateSlots?: string[]
    taskIds?: string[]
    operations?: Array<{ operationId: string; kind: 'candidate-generation' | 'analysis' }>
  } = {},
): SearchPlannedEvent {
  return {
    kind: 'search-planned',
    eventId: 'search:plan',
    occurredAt: '2026-07-11T11:59:00.000Z',
    artifacts: [artifact('search-manifest', HASHES.report)],
    plan: {
      candidateSlots: (options.candidateSlots ?? ['slot-a']).map((slotId) => ({
        slotId,
        generationOperationId: 'candidate-generation:a',
      })),
      tasks: (options.taskIds ?? ['task-1']).map((taskId) => ({
        taskId,
        source: {
          uri: 'git+https://github.com/example/task-repo.git',
          revision: REVISIONS.task,
        },
        benchmark: {
          uri: 'hf://datasets/example/repository-tasks',
          revision: REVISIONS.benchmark,
        },
        maxAttempts: 2,
      })),
      operations: options.operations ?? [
        { operationId: 'candidate-generation:a', kind: 'candidate-generation' },
      ],
    },
  }
}

function candidate(
  candidateId = 'candidate-a',
  options: {
    eventId?: string
    lineageNodeId?: string
    slotId?: string
    parents?: string[]
    generation?: number
    occurredAt?: string
    generationOperationId?: string
  } = {},
): SearchCandidateRegisteredEvent {
  return {
    kind: 'candidate-registered',
    eventId: options.eventId ?? `candidate:${candidateId}`,
    occurredAt: options.occurredAt ?? '2026-07-11T12:00:00.000Z',
    artifacts: [artifact('proposal-receipt', HASHES.proposal)],
    slotId: options.slotId ?? 'slot-a',
    generationOperationId: options.generationOperationId ?? 'candidate-generation:a',
    candidateId,
    lineage: {
      lineageNodeId: options.lineageNodeId ?? 'e'.repeat(16),
      parentCandidateIds: options.parents ?? [],
      generation: options.generation ?? 0,
      proposer: 'composite-proposer/v1',
      proposerSource: {
        uri: 'git+https://github.com/tangle-network/agent-eval.git',
        revision: REVISIONS.proposer,
      },
    },
    surfaces: [
      {
        surfaceId: 'agent-profile:behavior',
        kind: 'agent-profile',
        artifact: artifact('agent-profile', HASHES.profile),
      },
      {
        surfaceId: 'code:src/router.ts',
        kind: 'code',
        artifact: artifact('code-patch', HASHES.code),
      },
    ],
  }
}

function operation(
  cost: SearchCostAccounting = { status: 'known', usd: 0.02, source: 'provider' },
  outcome: SearchOperationRecordedEvent['outcome'] = { status: 'completed' },
  options: { operationId?: string; eventId?: string } = {},
): SearchOperationRecordedEvent {
  const operationId = options.operationId ?? 'candidate-generation:a'
  return {
    kind: 'search-operation-recorded',
    eventId: options.eventId ?? `operation:${operationId}`,
    occurredAt: '2026-07-11T11:59:30.000Z',
    artifacts: [artifact('operation-receipt', HASHES.proposal)],
    operationId,
    operationKind: 'candidate-generation',
    execution: {
      kind: 'model',
      model: { provider: 'openai', snapshot: 'gpt-5.4@2026-06-01' },
      source: {
        uri: 'git+https://github.com/tangle-network/agent-eval.git',
        revision: REVISIONS.proposer,
      },
    },
    outcome,
    accounting: {
      tokens: { status: 'known', inputTokens: 50, outputTokens: 10, cachedTokens: 0 },
      cost,
    },
  }
}

function slotClosure(): SearchCandidateSlotClosedEvent {
  return {
    kind: 'candidate-slot-closed',
    eventId: 'slot:slot-a:closed',
    occurredAt: '2026-07-11T12:02:00.000Z',
    artifacts: [artifact('candidate-generation-failure', HASHES.decision)],
    slotId: 'slot-a',
    generationOperationId: 'candidate-generation:a',
    reason: {
      code: 'proposal-failed',
      message: 'candidate generation returned no valid candidate',
    },
  }
}

function surfaceEvidence(): SearchSurfaceEvidence[] {
  return [
    {
      surfaceId: 'agent-profile:behavior',
      fired: true,
      firingCount: 3,
      effect: {
        status: 'measured',
        metric: 'task_reward',
        baselineValue: 0,
        candidateValue: 1,
        delta: 1,
      },
      evidence: [artifact('profile-trace', HASHES.trace)],
    },
    {
      surfaceId: 'code:src/router.ts',
      fired: false,
      firingCount: 0,
      effect: { status: 'not-measured', reason: 'the changed branch was not reached' },
      evidence: [artifact('coverage-trace', HASHES.trace)],
    },
  ]
}

function failedOutcome(): SearchTaskOutcome {
  return {
    status: 'failed',
    score: 0,
    metrics: { tests_passed: 18, tests_total: 19 },
    failure: { code: 'test-failure', message: 'one protected test failed' },
  }
}

function attempt(
  candidateId = 'candidate-a',
  options: {
    eventId?: string
    runId?: string
    attemptIndex?: number
    outcome?: SearchTaskOutcome
    cost?: SearchCostAccounting
    evidence?: SearchSurfaceEvidence[]
  } = {},
): SearchTaskAttemptedEvent {
  return {
    kind: 'task-attempted',
    eventId: options.eventId ?? `attempt:${candidateId}:task-1:${options.attemptIndex ?? 0}`,
    occurredAt: '2026-07-11T12:01:00.000Z',
    artifacts: [artifact('run-record', HASHES.run), artifact('trace', HASHES.trace)],
    candidateId,
    runId: options.runId ?? `run:${candidateId}:${options.attemptIndex ?? 0}`,
    attemptIndex: options.attemptIndex ?? 0,
    task: {
      taskId: 'task-1',
      source: { uri: 'git+https://github.com/example/task-repo.git', revision: REVISIONS.task },
    },
    identity: {
      model: { provider: 'openai', snapshot: 'gpt-5.4@2026-06-01' },
      agent: {
        uri: 'git+https://github.com/tangle-network/agent-runtime.git',
        revision: REVISIONS.agent,
      },
      benchmark: {
        uri: 'hf://datasets/example/repository-tasks',
        revision: REVISIONS.benchmark,
      },
    },
    outcome: options.outcome ?? failedOutcome(),
    accounting: {
      tokens: { status: 'known', inputTokens: 1_000, outputTokens: 200, cachedTokens: 100 },
      cost: options.cost ?? { status: 'known', usd: 0.12, source: 'provider' },
    },
    surfaceEvidence: options.evidence ?? surfaceEvidence(),
  }
}

function decision(
  candidateId = 'candidate-a',
  status: 'selected' | 'rejected' = 'rejected',
): SearchCandidateDecidedEvent {
  return {
    kind: 'candidate-decided',
    eventId: `decision:${candidateId}`,
    occurredAt: '2026-07-11T12:02:00.000Z',
    artifacts: [artifact('decision-receipt', HASHES.decision)],
    candidateId,
    decision:
      status === 'selected'
        ? { status: 'selected' }
        : {
            status: 'rejected',
            reason: { code: 'no-lift', message: 'candidate did not improve task reward' },
          },
  }
}

function completion(
  result: 'selected' | 'all-rejected',
  candidateId = 'candidate-a',
): SearchCompletedEvent {
  return {
    kind: 'search-completed',
    eventId: 'search:completed',
    occurredAt: '2026-07-11T12:03:00.000Z',
    artifacts: [artifact('search-report', HASHES.report)],
    result:
      result === 'selected'
        ? { status: 'selected', candidateId }
        : {
            status: 'all-rejected',
            reason: { code: 'no-eligible-candidate', message: 'every candidate was rejected' },
          },
  }
}

async function ledgerPath(name: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `search-ledger-${name}-`))
  return join(dir, 'nested', 'search.jsonl')
}

describe('search ledger persistence and replay', () => {
  it('resumes from durable state with the full candidate → attempt → decision chain', async () => {
    const path = await ledgerPath('resume')
    const first = openSearchLedger({ path, campaignId: 'campaign-resume' })
    await first.append(plan())
    await first.append(operation())
    await first.append(candidate())
    await first.append(attempt())
    await first.append(decision('candidate-a', 'selected'))
    await first.append(completion('selected'))

    const resumed = await openSearchLedger({ path, campaignId: 'campaign-resume' }).replay()
    expect(resumed.entries).toHaveLength(6)
    expect(resumed.entries.map((entry) => entry.sequence)).toEqual([0, 1, 2, 3, 4, 5])
    expect(resumed.entries[1]!.previousHash).toBe(resumed.entries[0]!.entryHash)
    expect(resumed.attempts[0]!.identity.model.snapshot).toBe('gpt-5.4@2026-06-01')
    expect(resumed.attempts[0]!.surfaceEvidence).toHaveLength(2)
    expect(resumed.audit).toMatchObject({
      eventCount: 6,
      candidateCount: 1,
      attemptCount: 1,
      operationCount: 1,
      outcomes: { passed: 0, failed: 1, errored: 0 },
      decisions: { selected: 1, rejected: 0, pending: 0 },
      status: 'selected',
      selectedCandidateId: 'candidate-a',
      accounting: {
        status: 'known',
        inputTokens: 1_050,
        outputTokens: 210,
        cachedTokens: 100,
      },
    })
    expect(resumed.audit.accounting.status).toBe('known')
    if (resumed.audit.accounting.status === 'known') {
      expect(resumed.audit.accounting.costUsd).toBeCloseTo(0.14)
    }
    expect(readFileSync(path, 'utf8').trim().split('\n')).toHaveLength(6)
  })

  it('treats an exact duplicate as idempotent and rejects conflicting content', async () => {
    const path = await ledgerPath('duplicate')
    const ledger = openSearchLedger({ path, campaignId: 'campaign-duplicate' })
    await ledger.append(plan())
    await ledger.append(operation())
    const event = candidate()
    const first = await ledger.append(event)
    const duplicate = await ledger.append({
      ...event,
      artifacts: [...event.artifacts].reverse(),
      surfaces: [...event.surfaces].reverse(),
    })
    expect(first.appended).toBe(true)
    expect(duplicate.appended).toBe(false)
    expect(duplicate.entry.entryHash).toBe(first.entry.entryHash)
    expect(readFileSync(path, 'utf8').trim().split('\n')).toHaveLength(3)

    await expect(
      ledger.append({
        ...event,
        lineage: { ...event.lineage, proposer: 'different-proposer/v2' },
      }),
    ).rejects.toBeInstanceOf(SearchLedgerConflictError)
  })

  it('detects a partial final write instead of silently dropping it', async () => {
    const path = await ledgerPath('partial')
    const ledger = openSearchLedger({ path, campaignId: 'campaign-partial' })
    await ledger.append(plan())
    await ledger.append(operation())
    await ledger.append(candidate())
    appendFileSync(path, '{"schema":"tangle.search-ledger.v1"', 'utf8')

    await expect(ledger.replay()).rejects.toThrow(/truncated final record/)
    await expect(ledger.append(attempt())).rejects.toBeInstanceOf(SearchLedgerIntegrityError)
  })

  it('rejects a complete malformed row instead of skipping it', async () => {
    const path = await ledgerPath('malformed')
    const ledger = openSearchLedger({ path, campaignId: 'campaign-malformed' })
    await ledger.append(plan())
    await ledger.append(operation())
    await ledger.append(candidate())
    appendFileSync(path, '{}\n', 'utf8')

    await expect(ledger.replay()).rejects.toThrow(/malformed entry at line 4/)
  })

  it('writes byte-identical logs for identical events', async () => {
    const firstPath = await ledgerPath('deterministic-a')
    const secondPath = await ledgerPath('deterministic-b')
    const first = openSearchLedger({ path: firstPath, campaignId: 'campaign-deterministic' })
    const second = openSearchLedger({ path: secondPath, campaignId: 'campaign-deterministic' })
    for (const event of [plan(), operation(), candidate(), attempt(), decision()] as const) {
      await first.append(event)
      await second.append(event)
    }

    expect(readFileSync(firstPath)).toEqual(readFileSync(secondPath))
  })

  it('detects content tampering through the hash chain', async () => {
    const path = await ledgerPath('tamper')
    const ledger = openSearchLedger({ path, campaignId: 'campaign-tamper' })
    await ledger.append(plan())
    const row = JSON.parse(readFileSync(path, 'utf8')) as {
      event: { plan: { candidateSlots: Array<{ slotId: string }> } }
    }
    row.event.plan.candidateSlots[0]!.slotId = 'tampered-slot'
    writeFileSync(path, `${JSON.stringify(row)}\n`, 'utf8')

    await expect(ledger.replay()).rejects.toThrow(/hash mismatch/)
  })

  it('reclaims a complete stale lock left by a crashed process', async () => {
    const path = await ledgerPath('stale-lock')
    const lockPath = `${path}.lock`
    const ledger = openSearchLedger({ path, campaignId: 'campaign-stale' })
    await ledger.replay()
    writeFileSync(
      lockPath,
      `${JSON.stringify({ host: hostname(), nonce: 'crashed-process', pid: 999_999_999 })}\n`,
      'utf8',
    )

    const result = await ledger.append(plan())
    expect(result.appended).toBe(true)
    expect(result.replay.audit.eventCount).toBe(1)
  })
})

describe('search ledger evidence completeness', () => {
  it('rejects a non-canonical campaign id before creating a file', async () => {
    const path = await ledgerPath('campaign-id')
    expect(() => openSearchLedger({ path, campaignId: ' campaign ' })).toThrow(
      /surrounding whitespace/,
    )
  })

  it('records unknown cost explicitly as a partial total, never a fake zero', async () => {
    const path = await ledgerPath('unknown-cost')
    const ledger = openSearchLedger({ path, campaignId: 'campaign-cost' })
    await ledger.append(plan())
    await ledger.append(operation())
    await ledger.append(candidate())
    const unknownCostAttempt = attempt('candidate-a', {
      cost: {
        status: 'unknown',
        knownLowerBoundUsd: 0.04,
        reason: 'provider omitted usage pricing for one tool call',
      },
    })
    const result = await ledger.append(unknownCostAttempt)

    expect(result.replay.attempts[0]!.accounting.cost).toEqual(unknownCostAttempt.accounting.cost)
    expect(result.replay.audit.accounting).toEqual({
      status: 'partial',
      knownInputTokens: 1_050,
      knownOutputTokens: 210,
      knownCachedTokens: 100,
      knownCostUsd: 0.06,
      unknownTokenEventIds: [],
      unknownCostEventIds: [unknownCostAttempt.eventId],
    })
  })

  it('preserves a failed task attempt, its denominator, and its failure reason', async () => {
    const path = await ledgerPath('failed-attempt')
    const ledger = openSearchLedger({ path, campaignId: 'campaign-failure' })
    await ledger.append(plan())
    await ledger.append(operation())
    await ledger.append(candidate())
    await ledger.append(attempt())

    const replay = await ledger.replay()
    expect(replay.audit.attemptCount).toBe(1)
    expect(replay.audit.outcomes).toEqual({ passed: 0, failed: 1, errored: 0 })
    expect(replay.attempts[0]!.outcome).toEqual(failedOutcome())
    expect(replay.attempts[0]!.surfaceEvidence).toEqual(surfaceEvidence())
  })

  it('does not select a candidate whose only attempt errored', async () => {
    const path = await ledgerPath('error-only')
    const ledger = openSearchLedger({ path, campaignId: 'campaign-error-only' })
    await ledger.append(plan())
    await ledger.append(operation())
    await ledger.append(candidate())
    await ledger.append(
      attempt('candidate-a', {
        outcome: {
          status: 'errored',
          metrics: {},
          error: { code: 'worker-crash', message: 'worker exited 137', retryable: true },
        },
      }),
    )

    await expect(ledger.append(decision('candidate-a', 'selected'))).rejects.toThrow(
      /without a measured task outcome/,
    )
  })

  it('rejects execution-identity drift between retries of one task', async () => {
    const path = await ledgerPath('retry-identity')
    const ledger = openSearchLedger({ path, campaignId: 'campaign-retry-identity' })
    await ledger.append(plan())
    await ledger.append(operation())
    await ledger.append(candidate())
    await ledger.append(
      attempt('candidate-a', {
        outcome: {
          status: 'errored',
          metrics: {},
          error: { code: 'transport', message: 'connection reset', retryable: true },
        },
      }),
    )
    const retry = attempt('candidate-a', { attemptIndex: 1 })
    retry.identity.model.snapshot = 'gpt-5.4@2026-07-01'

    await expect(ledger.append(retry)).rejects.toThrow(/changed immutable execution identity/)
    expect((await ledger.replay()).audit.attemptCount).toBe(1)
  })

  it('requires evidence for every declared surface on every task attempt', async () => {
    const path = await ledgerPath('surface-coverage')
    const ledger = openSearchLedger({ path, campaignId: 'campaign-surfaces' })
    await ledger.append(plan())
    await ledger.append(operation())
    await ledger.append(candidate())

    await expect(
      ledger.append(attempt('candidate-a', { evidence: surfaceEvidence().slice(0, 1) })),
    ).rejects.toThrow(/does not exactly cover candidate/)
    expect((await ledger.replay()).audit.eventCount).toBe(3)
  })

  it('rejects bare model aliases and mutable source refs before touching disk', async () => {
    const path = await ledgerPath('immutable-identities')
    const ledger = openSearchLedger({ path, campaignId: 'campaign-identities' })
    await ledger.append(plan())
    await ledger.append(operation())
    await ledger.append(candidate())
    const invalid = attempt()
    invalid.identity.model.snapshot = 'gpt-5.4'
    invalid.identity.benchmark.revision = 'main'

    await expect(ledger.append(invalid)).rejects.toThrow(/immutable snapshot|Invalid/)
    expect((await ledger.replay()).audit.eventCount).toBe(3)
  })

  it('requires each registered candidate to come from its completed planned generation call', async () => {
    const missingPath = await ledgerPath('candidate-generation-missing')
    const missing = openSearchLedger({
      path: missingPath,
      campaignId: 'campaign-generation-missing',
    })
    await missing.append(plan())
    await expect(missing.append(candidate())).rejects.toThrow(
      /precedes generation operation candidate-generation:a/,
    )

    const failedPath = await ledgerPath('candidate-generation-failed')
    const failed = openSearchLedger({
      path: failedPath,
      campaignId: 'campaign-generation-failed',
    })
    await failed.append(plan())
    await failed.append(
      operation(
        { status: 'known', usd: 0.02, source: 'provider' },
        {
          status: 'failed',
          failure: { code: 'invalid-candidate', message: 'proposal did not parse' },
        },
      ),
    )
    await expect(failed.append(candidate())).rejects.toThrow(
      /cannot bind failed generation operation/,
    )

    const wrongPath = await ledgerPath('candidate-generation-wrong')
    const wrong = openSearchLedger({ path: wrongPath, campaignId: 'campaign-generation-wrong' })
    await wrong.append(
      plan({
        operations: [
          { operationId: 'candidate-generation:a', kind: 'candidate-generation' },
          { operationId: 'candidate-generation:b', kind: 'candidate-generation' },
        ],
      }),
    )
    await wrong.append(operation(undefined, undefined, { operationId: 'candidate-generation:b' }))
    await expect(
      wrong.append(candidate('candidate-a', { generationOperationId: 'candidate-generation:b' })),
    ).rejects.toThrow(/does not match slot slot-a plan candidate-generation:a/)
  })

  it('rejects a slot mapped to an unplanned generation call in the frozen plan', async () => {
    const path = await ledgerPath('slot-generation-unplanned')
    const ledger = openSearchLedger({ path, campaignId: 'campaign-slot-generation-unplanned' })
    const invalidPlan = plan()
    invalidPlan.plan.candidateSlots[0]!.generationOperationId = 'candidate-generation:missing'

    await expect(ledger.append(invalidPlan)).rejects.toThrow(
      /slot slot-a references unplanned candidate-generation operation/,
    )
  })

  it('refuses completion when a predeclared candidate slot is missing', async () => {
    const path = await ledgerPath('missing-candidate-slot')
    const ledger = openSearchLedger({ path, campaignId: 'campaign-missing-candidate' })
    await ledger.append(plan({ candidateSlots: ['slot-a', 'slot-b'] }))
    await ledger.append(operation())
    await ledger.append(candidate())
    await ledger.append(attempt())
    await ledger.append(decision())

    await expect(ledger.append(completion('all-rejected'))).rejects.toThrow(
      /missing candidate slots: slot-b/,
    )
    expect((await ledger.replay()).audit.expected.missingCandidateSlots).toEqual(['slot-b'])
  })

  it('closes a failed proposal slot without inventing a candidate or task outcome', async () => {
    const path = await ledgerPath('failed-proposal')
    const ledger = openSearchLedger({ path, campaignId: 'campaign-failed-proposal' })
    const failedProposal = operation(
      { status: 'known', usd: 0.02, source: 'provider' },
      {
        status: 'failed',
        failure: { code: 'invalid-candidate', message: 'proposal did not parse' },
      },
    )
    await ledger.append(plan())
    await ledger.append(failedProposal)
    await ledger.append(slotClosure())
    const terminal = await ledger.append(completion('all-rejected'))

    expect(terminal.replay.closedCandidateSlots).toHaveLength(1)
    expect(terminal.replay.audit).toMatchObject({
      status: 'all-rejected',
      candidateCount: 0,
      closedCandidateSlotCount: 1,
      attemptCount: 0,
      operationOutcomes: { completed: 0, failed: 1 },
      expected: {
        candidateSlots: 1,
        taskOutcomes: 0,
        missingCandidateSlots: [],
        missingTaskOutcomes: [],
        missingOperations: [],
      },
      accounting: {
        status: 'known',
        inputTokens: 50,
        outputTokens: 10,
        cachedTokens: 0,
        costUsd: 0.02,
      },
    })
  })

  it('rejects binding a candidate to an already closed proposal slot', async () => {
    const path = await ledgerPath('closed-slot-double-use')
    const ledger = openSearchLedger({ path, campaignId: 'campaign-closed-slot-double-use' })
    await ledger.append(plan())
    await ledger.append(
      operation(
        { status: 'known', usd: 0.02, source: 'provider' },
        {
          status: 'failed',
          failure: { code: 'invalid-candidate', message: 'proposal did not parse' },
        },
      ),
    )
    await ledger.append(slotClosure())

    await expect(
      ledger.append(candidate('candidate-a', { occurredAt: '2026-07-11T12:02:30.000Z' })),
    ).rejects.toThrow(/slot slot-a was already closed/)
    expect((await ledger.replay()).audit.candidateCount).toBe(0)
  })

  it('rejects closing a slot from a different failed generation call', async () => {
    const path = await ledgerPath('slot-closure-wrong-generation')
    const ledger = openSearchLedger({
      path,
      campaignId: 'campaign-slot-closure-wrong-generation',
    })
    await ledger.append(
      plan({
        operations: [
          { operationId: 'candidate-generation:a', kind: 'candidate-generation' },
          { operationId: 'candidate-generation:b', kind: 'candidate-generation' },
        ],
      }),
    )
    await ledger.append(
      operation(
        { status: 'known', usd: 0.02, source: 'provider' },
        {
          status: 'failed',
          failure: { code: 'invalid-candidate', message: 'proposal did not parse' },
        },
        { operationId: 'candidate-generation:b' },
      ),
    )
    const wrongClosure = slotClosure()
    wrongClosure.generationOperationId = 'candidate-generation:b'

    await expect(ledger.append(wrongClosure)).rejects.toThrow(
      /does not match slot slot-a plan candidate-generation:a/,
    )
  })

  it('refuses completion when a predeclared task outcome is missing', async () => {
    const path = await ledgerPath('missing-task')
    const ledger = openSearchLedger({ path, campaignId: 'campaign-missing-task' })
    await ledger.append(plan({ taskIds: ['task-1', 'task-2'] }))
    await ledger.append(operation())
    await ledger.append(candidate())
    await ledger.append(attempt())
    await ledger.append(decision())

    await expect(ledger.append(completion('all-rejected'))).rejects.toThrow(
      /missing task outcomes: slot-a\/task-2/,
    )
    expect((await ledger.replay()).audit.expected.missingTaskOutcomes).toEqual(['slot-a/task-2'])
  })

  it('refuses completion when a predeclared non-task operation is missing', async () => {
    const path = await ledgerPath('missing-operation')
    const ledger = openSearchLedger({ path, campaignId: 'campaign-missing-operation' })
    await ledger.append(
      plan({
        operations: [
          { operationId: 'candidate-generation:a', kind: 'candidate-generation' },
          { operationId: 'analysis:a', kind: 'analysis' },
        ],
      }),
    )
    await ledger.append(operation())
    await ledger.append(candidate())
    await ledger.append(attempt())
    await ledger.append(decision())

    await expect(ledger.append(completion('all-rejected'))).rejects.toThrow(
      /missing search operations: analysis:a/,
    )
    expect((await ledger.replay()).audit.expected.missingOperations).toEqual(['analysis:a'])
  })

  it('includes unknown proposer spend in the total search-cost audit', async () => {
    const path = await ledgerPath('unknown-proposer-cost')
    const ledger = openSearchLedger({ path, campaignId: 'campaign-unknown-proposer-cost' })
    await ledger.append(plan())
    const proposer = operation({
      status: 'unknown',
      knownLowerBoundUsd: 0.03,
      reason: 'provider omitted candidate-generation price',
    })
    await ledger.append(proposer)
    await ledger.append(candidate())
    await ledger.append(attempt())
    await ledger.append(decision())
    const terminal = await ledger.append(completion('all-rejected'))

    expect(terminal.replay.audit.accounting).toEqual({
      status: 'partial',
      knownInputTokens: 1_050,
      knownOutputTokens: 210,
      knownCachedTokens: 100,
      knownCostUsd: 0.15,
      unknownTokenEventIds: [],
      unknownCostEventIds: [proposer.eventId],
    })
    expect(terminal.replay.audit.expected.missingOperations).toEqual([])
  })

  it('represents an all-rejected search as a terminal audited outcome', async () => {
    const path = await ledgerPath('all-rejected')
    const ledger = openSearchLedger({ path, campaignId: 'campaign-all-rejected' })
    await ledger.append(plan({ candidateSlots: ['slot-a', 'slot-b'] }))
    await ledger.append(operation())
    await ledger.append(candidate('candidate-a'))
    await ledger.append(
      candidate('candidate-b', {
        eventId: 'candidate:candidate-b',
        lineageNodeId: 'f'.repeat(16),
        slotId: 'slot-b',
      }),
    )
    await ledger.append(attempt('candidate-a'))
    await ledger.append(
      attempt('candidate-b', {
        eventId: 'attempt:candidate-b:task-1:0',
        runId: 'run:candidate-b:0',
      }),
    )
    await ledger.append(decision('candidate-a', 'rejected'))
    await ledger.append(decision('candidate-b', 'rejected'))
    const terminal = await ledger.append(completion('all-rejected'))

    expect(terminal.replay.audit).toMatchObject({
      status: 'all-rejected',
      selectedCandidateId: null,
      candidateCount: 2,
      attemptCount: 2,
      operationCount: 1,
      decisions: { selected: 0, rejected: 2, pending: 0 },
    })
    expect(terminal.replay.completion?.result.status).toBe('all-rejected')
    await expect(ledger.append(candidate('candidate-c'))).rejects.toThrow(/after terminal event/)
  })

  it('canonicalizes unordered evidence without changing identity', () => {
    const event = candidate()
    const normalized = validateSearchLedgerEvent({
      ...event,
      artifacts: [...event.artifacts].reverse(),
      surfaces: [...event.surfaces].reverse(),
    }) as SearchCandidateRegisteredEvent
    expect(normalized.surfaces.map((surface) => surface.surfaceId)).toEqual([
      'agent-profile:behavior',
      'code:src/router.ts',
    ])
  })
})
