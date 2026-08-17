import { describe, expect, it } from 'vitest'
import type {
  SearchArtifactRef,
  SearchLedgerEntry,
  SearchLedgerHash,
  SearchLedgerReplay,
} from './search-ledger'
import {
  assertCompleteSearchHistory,
  assertSearchHistoryMatchesReplay,
  createSearchHistoryReceipt,
  SearchHistoryRequiredError,
  searchHistoryCoverageRow,
  verifySearchHistoryReceipt,
} from './search-history-receipt'

const hash = (character: string): SearchLedgerHash => `sha256:${character.repeat(64)}`
const source = { uri: 'git+https://example.test/repo.git', revision: 'a'.repeat(40) }
const artifact = (role: string, character: string): SearchArtifactRef => ({
  role,
  uri: `artifact://fixture/${role}`,
  sha256: hash(character),
  byteLength: 10,
})

function append(
  entries: SearchLedgerEntry[],
  character: string,
  event: SearchLedgerEntry['event'],
): void {
  entries.push({
    schema: 'tangle.search-ledger.v1',
    campaignId: 'campaign-1',
    sequence: entries.length,
    previousHash: entries.at(-1)?.entryHash ?? null,
    event,
    entryHash: hash(character),
  })
}

function completeReplay(): SearchLedgerReplay {
  const entries: SearchLedgerEntry[] = []
  append(entries, '1', {
    kind: 'search-planned',
    eventId: 'plan-1',
    occurredAt: '2026-08-17T00:00:00.000Z',
    artifacts: [artifact('plan', 'a')],
    plan: {
      candidateSlots: [{ slotId: 'slot-1', generationOperationId: 'generate-1' }],
      tasks: [
        {
          taskId: 'task-1',
          source,
          benchmark: source,
          maxAttempts: 1,
        },
      ],
      operations: [{ operationId: 'generate-1', kind: 'candidate-generation' }],
    },
  })
  append(entries, '2', {
    kind: 'candidate-registered',
    eventId: 'candidate-1',
    occurredAt: '2026-08-17T00:00:01.000Z',
    artifacts: [artifact('candidate', 'b')],
    slotId: 'slot-1',
    generationOperationId: 'generate-1',
    candidateId: 'candidate-a',
    lineage: {
      lineageNodeId: '0123456789abcdef',
      parentCandidateIds: [],
      generation: 0,
      proposer: 'fixture-proposer',
      proposerSource: source,
    },
    surfaces: [
      {
        surfaceId: 'prompt-1',
        kind: 'prompt',
        artifact: artifact('surface', 'c'),
      },
    ],
  })
  append(entries, '3', {
    kind: 'search-operation-recorded',
    eventId: 'operation-1',
    occurredAt: '2026-08-17T00:00:02.000Z',
    artifacts: [artifact('operation', 'd')],
    operationId: 'generate-1',
    operationKind: 'candidate-generation',
    execution: { kind: 'deterministic', source },
    outcome: { status: 'completed' },
    accounting: {
      tokens: { status: 'known', inputTokens: 0, outputTokens: 0, cachedTokens: 0 },
      cost: { status: 'known', usd: 0, source: 'free' },
    },
  })
  append(entries, '4', {
    kind: 'task-attempted',
    eventId: 'attempt-1',
    occurredAt: '2026-08-17T00:00:03.000Z',
    artifacts: [artifact('run', 'e')],
    candidateId: 'candidate-a',
    runId: 'run-a',
    attemptIndex: 0,
    task: { taskId: 'task-1', source },
    identity: {
      model: { provider: 'fixture', snapshot: 'fixture/model@2026-08-17' },
      agent: source,
      benchmark: source,
    },
    outcome: { status: 'passed', score: 1, metrics: { quality: 1 } },
    accounting: {
      tokens: { status: 'known', inputTokens: 10, outputTokens: 2, cachedTokens: 0 },
      cost: { status: 'known', usd: 0.001, source: 'provider' },
    },
    surfaceEvidence: [
      {
        surfaceId: 'prompt-1',
        fired: true,
        firingCount: 1,
        effect: {
          status: 'measured',
          metric: 'quality',
          baselineValue: 0,
          candidateValue: 1,
          delta: 1,
        },
        evidence: [artifact('surface-evidence', 'f')],
      },
    ],
  })
  append(entries, '5', {
    kind: 'candidate-decided',
    eventId: 'decision-1',
    occurredAt: '2026-08-17T00:00:04.000Z',
    artifacts: [artifact('decision', '0')],
    candidateId: 'candidate-a',
    decision: { status: 'selected' },
  })
  append(entries, '6', {
    kind: 'search-completed',
    eventId: 'complete-1',
    occurredAt: '2026-08-17T00:00:05.000Z',
    artifacts: [artifact('completion', '9')],
    result: { status: 'selected', candidateId: 'candidate-a' },
  })

  return {
    entries,
    plan: entries[0]!.event as SearchLedgerReplay['plan'],
    candidates: [entries[1]!.event as SearchLedgerReplay['candidates'][number]],
    closedCandidateSlots: [],
    attempts: [entries[3]!.event as SearchLedgerReplay['attempts'][number]],
    operations: [entries[2]!.event as SearchLedgerReplay['operations'][number]],
    decisions: [entries[4]!.event as SearchLedgerReplay['decisions'][number]],
    completion: entries[5]!.event as SearchLedgerReplay['completion'],
    audit: {
      campaignId: 'campaign-1',
      eventCount: 6,
      candidateCount: 1,
      closedCandidateSlotCount: 0,
      attemptCount: 1,
      operationCount: 1,
      outcomes: { passed: 1, failed: 0, errored: 0 },
      operationOutcomes: { completed: 1, partial: 0, failed: 0 },
      decisions: { selected: 1, rejected: 0, pending: 0 },
      expected: {
        candidateSlots: 1,
        taskOutcomes: 1,
        operations: 1,
        missingCandidateSlots: [],
        missingTaskOutcomes: [],
        missingOperations: [],
      },
      status: 'selected',
      selectedCandidateId: 'candidate-a',
      accounting: {
        status: 'known',
        inputTokens: 10,
        outputTokens: 2,
        cachedTokens: 0,
        costUsd: 0.001,
      },
      headHash: entries.at(-1)!.entryHash,
    },
  }
}

function receipt(replay = completeReplay()) {
  return createSearchHistoryReceipt({
    producerId: 'fixture-method',
    runId: 'optimizer-run-1',
    ledger: {
      role: 'search-ledger',
      uri: 'artifact://optimizer-run-1/search-ledger.jsonl',
      sha256: hash('8'),
      byteLength: 1_024,
    },
    replay,
  })
}

describe('SearchHistoryReceipt', () => {
  it('indexes every canonical event and entity without copying rich history records', () => {
    const value = receipt()

    expect(verifySearchHistoryReceipt(value)).toBe(value)
    expect(value.complete).toBe(true)
    expect(value.incompleteReasons).toEqual([])
    expect(value.events.map((event) => [event.sequence, event.kind, event.eventId])).toEqual([
      [0, 'search-planned', 'plan-1'],
      [1, 'candidate-registered', 'candidate-1'],
      [2, 'search-operation-recorded', 'operation-1'],
      [3, 'task-attempted', 'attempt-1'],
      [4, 'candidate-decided', 'decision-1'],
      [5, 'search-completed', 'complete-1'],
    ])
    expect(value.entities).toEqual({
      candidateIds: ['candidate-a'],
      runIds: ['run-a'],
      operationIds: ['generate-1'],
      closedCandidateSlotIds: [],
      selectedCandidateIds: ['candidate-a'],
      rejectedCandidateIds: [],
    })
    expect(value.receiptDigest).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect(Object.isFrozen(value)).toBe(true)
    expect(Object.isFrozen(value.audit)).toBe(true)
  })

  it('states every unresolved denominator instead of calling an interrupted search complete', () => {
    const replay = completeReplay()
    replay.entries = replay.entries.slice(0, 2)
    replay.operations = []
    replay.attempts = []
    replay.decisions = []
    replay.completion = null
    replay.audit = {
      ...replay.audit,
      eventCount: 2,
      attemptCount: 0,
      operationCount: 0,
      decisions: { selected: 0, rejected: 0, pending: 1 },
      expected: {
        ...replay.audit.expected,
        missingTaskOutcomes: ['candidate-a/task-1'],
        missingOperations: ['generate-1'],
      },
      status: 'in-progress',
      selectedCandidateId: null,
      headHash: replay.entries.at(-1)!.entryHash,
    }

    const value = receipt(replay)

    expect(value.complete).toBe(false)
    expect(value.incompleteReasons).toEqual([
      'terminal search-completed event is missing',
      'search status is in-progress',
      'task outcomes are unresolved: candidate-a/task-1',
      'operations are unresolved: generate-1',
      '1 candidate decision(s) are pending',
    ])
    expect(() => assertCompleteSearchHistory('fixture-method', value)).toThrow(
      SearchHistoryRequiredError,
    )
    expect(searchHistoryCoverageRow('fixture-method', value).status).toBe('incomplete')
  })

  it('fails closed on missing or mismatched producer history', () => {
    expect(() => assertCompleteSearchHistory('fixture-method', undefined)).toThrow(
      /search history receipt is missing/,
    )
    expect(() => assertCompleteSearchHistory('another-method', receipt())).toThrow(
      /receipt belongs to producer 'fixture-method'/,
    )
  })

  it('detects receipt mutation and replay drift', () => {
    const value = receipt()
    expect(() =>
      verifySearchHistoryReceipt({
        ...value,
        entities: { ...value.entities, runIds: ['forged-run'] },
      }),
    ).toThrow(/receipt digest mismatch/)

    const replay = completeReplay()
    replay.audit = {
      ...replay.audit,
      accounting: {
        status: 'known',
        inputTokens: 10,
        outputTokens: 2,
        cachedTokens: 0,
        costUsd: 2,
      },
    }
    expect(() => assertSearchHistoryMatchesReplay(value, replay)).toThrow(
      /does not match the supplied SearchLedger replay/,
    )
  })

  it('refuses a replay whose sequence, campaign, chain, or audit head is inconsistent', () => {
    const wrongSequence = completeReplay()
    wrongSequence.entries = wrongSequence.entries.map((row, index) =>
      index === 2 ? { ...row, sequence: 8 } : row,
    )
    expect(() => receipt(wrongSequence)).toThrow(/expected 2, observed 8/)

    const wrongCampaign = completeReplay()
    wrongCampaign.entries = wrongCampaign.entries.map((row, index) =>
      index === 1 ? { ...row, campaignId: 'other-campaign' } : row,
    )
    expect(() => receipt(wrongCampaign)).toThrow(/belongs to another campaign/)

    const wrongChain = completeReplay()
    wrongChain.entries = wrongChain.entries.map((row, index) =>
      index === 3 ? { ...row, previousHash: hash('f') } : row,
    )
    expect(() => receipt(wrongChain)).toThrow(/does not extend the prior ledger head/)

    const wrongHead = completeReplay()
    wrongHead.audit = { ...wrongHead.audit, headHash: hash('7') }
    expect(() => receipt(wrongHead)).toThrow(/headHash does not match/)
  })
})
