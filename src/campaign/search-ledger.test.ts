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
  type SearchCompletedEvent,
  type SearchCostAccounting,
  SearchLedgerConflictError,
  SearchLedgerIntegrityError,
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

function candidate(
  candidateId = 'candidate-a',
  options: {
    eventId?: string
    lineageNodeId?: string
    parents?: string[]
    generation?: number
  } = {},
): SearchCandidateRegisteredEvent {
  return {
    kind: 'candidate-registered',
    eventId: options.eventId ?? `candidate:${candidateId}`,
    occurredAt: '2026-07-11T12:00:00.000Z',
    artifacts: [artifact('proposal-receipt', HASHES.proposal)],
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
    await first.append(candidate())
    await first.append(attempt())
    await first.append(decision('candidate-a', 'selected'))
    await first.append(completion('selected'))

    const resumed = await openSearchLedger({ path, campaignId: 'campaign-resume' }).replay()
    expect(resumed.entries).toHaveLength(4)
    expect(resumed.entries.map((entry) => entry.sequence)).toEqual([0, 1, 2, 3])
    expect(resumed.entries[1]!.previousHash).toBe(resumed.entries[0]!.entryHash)
    expect(resumed.attempts[0]!.identity.model.snapshot).toBe('gpt-5.4@2026-06-01')
    expect(resumed.attempts[0]!.surfaceEvidence).toHaveLength(2)
    expect(resumed.audit).toMatchObject({
      eventCount: 4,
      candidateCount: 1,
      attemptCount: 1,
      outcomes: { passed: 0, failed: 1, errored: 0 },
      decisions: { selected: 1, rejected: 0, pending: 0 },
      status: 'selected',
      selectedCandidateId: 'candidate-a',
      accounting: {
        status: 'known',
        inputTokens: 1_000,
        outputTokens: 200,
        cachedTokens: 100,
        costUsd: 0.12,
      },
    })
    expect(readFileSync(path, 'utf8').trim().split('\n')).toHaveLength(4)
  })

  it('treats an exact duplicate as idempotent and rejects conflicting content', async () => {
    const path = await ledgerPath('duplicate')
    const ledger = openSearchLedger({ path, campaignId: 'campaign-duplicate' })
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
    expect(readFileSync(path, 'utf8').trim().split('\n')).toHaveLength(1)

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
    await ledger.append(candidate())
    appendFileSync(path, '{"schema":"tangle.search-ledger.v1"', 'utf8')

    await expect(ledger.replay()).rejects.toThrow(/truncated final record/)
    await expect(ledger.append(attempt())).rejects.toBeInstanceOf(SearchLedgerIntegrityError)
  })

  it('rejects a complete malformed row instead of skipping it', async () => {
    const path = await ledgerPath('malformed')
    const ledger = openSearchLedger({ path, campaignId: 'campaign-malformed' })
    await ledger.append(candidate())
    appendFileSync(path, '{}\n', 'utf8')

    await expect(ledger.replay()).rejects.toThrow(/malformed entry at line 2/)
  })

  it('writes byte-identical logs for identical events', async () => {
    const firstPath = await ledgerPath('deterministic-a')
    const secondPath = await ledgerPath('deterministic-b')
    const first = openSearchLedger({ path: firstPath, campaignId: 'campaign-deterministic' })
    const second = openSearchLedger({ path: secondPath, campaignId: 'campaign-deterministic' })
    for (const event of [candidate(), attempt(), decision()] as const) {
      await first.append(event)
      await second.append(event)
    }

    expect(readFileSync(firstPath)).toEqual(readFileSync(secondPath))
  })

  it('detects content tampering through the hash chain', async () => {
    const path = await ledgerPath('tamper')
    const ledger = openSearchLedger({ path, campaignId: 'campaign-tamper' })
    await ledger.append(candidate())
    const row = JSON.parse(readFileSync(path, 'utf8')) as {
      event: { candidateId: string }
    }
    row.event.candidateId = 'tampered-candidate'
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

    const result = await ledger.append(candidate())
    expect(result.appended).toBe(true)
    expect(result.replay.audit.eventCount).toBe(1)
  })
})

describe('search ledger evidence completeness', () => {
  it('records unknown cost explicitly as a partial total, never a fake zero', async () => {
    const path = await ledgerPath('unknown-cost')
    const ledger = openSearchLedger({ path, campaignId: 'campaign-cost' })
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
      knownInputTokens: 1_000,
      knownOutputTokens: 200,
      knownCachedTokens: 100,
      knownCostUsd: 0.04,
      unknownTokenEventIds: [],
      unknownCostEventIds: [unknownCostAttempt.eventId],
    })
  })

  it('preserves a failed task attempt, its denominator, and its failure reason', async () => {
    const path = await ledgerPath('failed-attempt')
    const ledger = openSearchLedger({ path, campaignId: 'campaign-failure' })
    await ledger.append(candidate())
    await ledger.append(attempt())

    const replay = await ledger.replay()
    expect(replay.audit.attemptCount).toBe(1)
    expect(replay.audit.outcomes).toEqual({ passed: 0, failed: 1, errored: 0 })
    expect(replay.attempts[0]!.outcome).toEqual(failedOutcome())
    expect(replay.attempts[0]!.surfaceEvidence).toEqual(surfaceEvidence())
  })

  it('requires evidence for every declared surface on every task attempt', async () => {
    const path = await ledgerPath('surface-coverage')
    const ledger = openSearchLedger({ path, campaignId: 'campaign-surfaces' })
    await ledger.append(candidate())

    await expect(
      ledger.append(attempt('candidate-a', { evidence: surfaceEvidence().slice(0, 1) })),
    ).rejects.toThrow(/does not exactly cover candidate/)
    expect((await ledger.replay()).audit.eventCount).toBe(1)
  })

  it('rejects bare model aliases and mutable source refs before touching disk', async () => {
    const path = await ledgerPath('immutable-identities')
    const ledger = openSearchLedger({ path, campaignId: 'campaign-identities' })
    await ledger.append(candidate())
    const invalid = attempt()
    invalid.identity.model.snapshot = 'gpt-5.4'
    invalid.identity.benchmark.revision = 'main'

    await expect(ledger.append(invalid)).rejects.toThrow(/immutable snapshot|Invalid/)
    expect((await ledger.replay()).audit.eventCount).toBe(1)
  })

  it('represents an all-rejected search as a terminal audited outcome', async () => {
    const path = await ledgerPath('all-rejected')
    const ledger = openSearchLedger({ path, campaignId: 'campaign-all-rejected' })
    await ledger.append(candidate('candidate-a'))
    await ledger.append(
      candidate('candidate-b', { eventId: 'candidate:candidate-b', lineageNodeId: 'f'.repeat(16) }),
    )
    await ledger.append(attempt('candidate-a'))
    await ledger.append(decision('candidate-a', 'rejected'))
    await ledger.append(decision('candidate-b', 'rejected'))
    const terminal = await ledger.append(completion('all-rejected'))

    expect(terminal.replay.audit).toMatchObject({
      status: 'all-rejected',
      selectedCandidateId: null,
      candidateCount: 2,
      attemptCount: 1,
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
