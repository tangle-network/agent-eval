import { describe, expect, it } from 'vitest'
import {
  makePolicyEdit,
  makePolicyEditCandidateRecord,
  type PolicyEditAdmissionOptions,
} from '../../src/analyst/policy-edit'
import { type AnalystFinding, makeFinding } from '../../src/analyst/types'
import {
  llmPolicyEditProposer,
  projectPolicyEditHistory,
} from '../../src/campaign/proposers/llm-policy-edit'
import type {
  GenerationRecord,
  MutableSurface,
  ProposeContext,
  ProposedCandidate,
  ScoredSurfaceOutcome,
} from '../../src/campaign/types'

interface CapturedRequest {
  system?: string
  user?: Record<string, unknown>
  responseFormat?: Record<string, unknown>
}

function finding(): AnalystFinding {
  return makeFinding({
    analyst_id: 'trace-analyst',
    area: 'agent-reasoning',
    severity: 'high',
    claim: 'The agent skips repository instructions before editing.',
    evidence_refs: [{ kind: 'span', uri: 'span://trace-1/span-7', excerpt: 'edited first' }],
    recommended_action: 'Read repository instructions before editing.',
    confidence: 0.9,
  })
}

function authoredEdit(
  findingId: string,
  options: {
    path?: string
    axis?: 'representation' | 'agent_profile'
    mode?: 'set' | 'merge' | 'remove'
    value?: unknown
    expectedGain?: number
    confidence?: number
    risk?: 'low' | 'medium' | 'high' | 'unknown'
  } = {},
) {
  const path = options.path ?? 'prompt.systemPrompt'
  const mode = options.mode ?? 'set'
  const change =
    mode === 'remove'
      ? { kind: 'json', mode, path }
      : {
          kind: 'json',
          mode,
          path,
          value: options.value ?? 'Read repository instructions first.',
        }
  return {
    axis: options.axis ?? 'representation',
    target: { surface: 'agent-profile', path, label: null },
    change,
    claim: 'Reading repository instructions first should prevent avoidable edits.',
    expectedGain: {
      metric: 'holdout.composite',
      direction: 'increase',
      amount: options.expectedGain ?? 0.12,
      unit: 'score',
      rationale: null,
    },
    confidence: options.confidence ?? 0.9,
    risk: options.risk ?? 'low',
    source: { findingIds: [findingId] },
    rationale: 'The cited trace shows editing began before repository guidance was read.',
    validationPlan: 'Measure on disjoint repository tasks.',
  }
}

function fetchResponse(
  content: string,
  capture: CapturedRequest = {},
  finishReason: string | null = 'stop',
): typeof fetch {
  return (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as {
      messages?: Array<{ role?: string; content?: string }>
      response_format?: Record<string, unknown>
    }
    capture.system = body.messages?.find((message) => message.role === 'system')?.content
    const user = body.messages?.find((message) => message.role === 'user')?.content
    if (user) capture.user = JSON.parse(user) as Record<string, unknown>
    if (body.response_format) capture.responseFormat = body.response_format
    return new Response(
      JSON.stringify({
        choices: [{ message: { content }, finish_reason: finishReason }],
        usage: {},
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }) as unknown as typeof fetch
}

function context(input: {
  finding: AnalystFinding
  currentSurface?: string
  history?: GenerationRecord[]
  generation?: number
  populationSize?: number
  baselineOutcome?: ScoredSurfaceOutcome
  incumbentOutcome?: ScoredSurfaceOutcome
}): ProposeContext<AnalystFinding> {
  return {
    currentSurface:
      input.currentSurface ?? '{"prompt":{"systemPrompt":"Base"},"resources":{"keep":true}}',
    history: input.history ?? [],
    findings: [input.finding],
    populationSize: input.populationSize ?? 1,
    generation: input.generation ?? 0,
    signal: new AbortController().signal,
    ...(input.baselineOutcome ? { baselineOutcome: input.baselineOutcome } : {}),
    ...(input.incumbentOutcome ? { incumbentOutcome: input.incumbentOutcome } : {}),
  }
}

function proposer(input: {
  response: unknown
  capture?: CapturedRequest
  allowedJsonPaths?: string[]
  finishReason?: string | null
  maxHistoryGenerations?: number
  maxHistoryCandidatesPerGeneration?: number
  historyScenarioIdTransform?: (scenarioId: string) => string
  admissionMode?: 'evidence-only' | 'strict'
  admission?: PolicyEditAdmissionOptions
}) {
  return llmPolicyEditProposer({
    llm: {
      apiKey: 'test-key',
      baseUrl: 'https://router.test/v1',
      fetch: fetchResponse(
        typeof input.response === 'string' ? input.response : JSON.stringify(input.response),
        input.capture,
        input.finishReason,
      ),
    },
    model: 'test-model-snapshot',
    target: 'canonical agent profile JSON',
    targetSurface: 'agent-profile',
    allowedJsonPaths: input.allowedJsonPaths ?? ['prompt.systemPrompt'],
    ...(input.maxHistoryGenerations === undefined
      ? {}
      : { maxHistoryGenerations: input.maxHistoryGenerations }),
    ...(input.maxHistoryCandidatesPerGeneration === undefined
      ? {}
      : { maxHistoryCandidatesPerGeneration: input.maxHistoryCandidatesPerGeneration }),
    ...(input.historyScenarioIdTransform === undefined
      ? {}
      : { historyScenarioIdTransform: input.historyScenarioIdTransform }),
    ...(input.admissionMode === undefined ? {} : { admissionMode: input.admissionMode }),
    ...(input.admission === undefined ? {} : { admission: input.admission }),
  })
}

function candidateSurface(candidate: MutableSurface | ProposedCandidate): string {
  return String(
    typeof candidate === 'object' && 'surface' in candidate ? candidate.surface : candidate,
  )
}

function measuredOutcome(
  surfaceHash: string,
  composite: number,
  scenarioId: string,
): ScoredSurfaceOutcome {
  return {
    surfaceHash,
    composite,
    dimensions: { correctness: composite },
    scenarios: [{ scenarioId, composite, notes: `${scenarioId} measured task result` }],
    coverage: { expectedCells: 1, scorableCells: 1 },
  }
}

describe('llmPolicyEditProposer', () => {
  it('authors a generation-zero edit from exact cited findings and typed JSON operations', async () => {
    const source = finding()
    const capture: CapturedRequest = {}
    const edit = authoredEdit(source.finding_id)
    const out = await proposer({ response: { edits: [edit] }, capture }).propose(
      context({ finding: source }),
    )

    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ rationale: expect.stringContaining(source.finding_id) })
    expect(JSON.parse(candidateSurface(out[0]!))).toEqual({
      prompt: { systemPrompt: 'Read repository instructions first.' },
      resources: { keep: true },
    })
    expect(capture.user).toMatchObject({
      generation: 0,
      currentSurface: { prompt: { systemPrompt: 'Base' }, resources: { keep: true } },
      history: [],
      findings: [
        {
          findingId: source.finding_id,
          evidenceRefs: source.evidence_refs,
        },
      ],
    })
    expect(capture.system).toContain('"mode":"set"')
    expect(capture.system).toContain('"mode":"merge"')
    expect(capture.system).toContain('"mode":"remove"')
    expect(capture.system).toContain('source.findingIds')
    expect(capture.responseFormat).toMatchObject({
      type: 'json_schema',
      json_schema: {
        name: 'policy_edit_author',
        strict: true,
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { edits: { maxItems: 1 } },
        },
      },
    })
    const providerSchema = JSON.stringify(capture.responseFormat)
    expect(providerSchema).toContain('"kind":{"const":"json"}')
    expect(providerSchema).toContain('"mode":{"const":"set"}')
    expect(providerSchema).toContain('"mode":{"const":"merge"}')
    expect(providerSchema).toContain('"mode":{"const":"remove"}')
  })

  it('shows the author measured baseline, incumbent, and exact parent deltas', async () => {
    const source = finding()
    const capture: CapturedRequest = {}
    const history: GenerationRecord[] = [
      {
        generationIndex: 0,
        promoted: ['candidate-a'],
        candidates: [
          {
            surfaceHash: 'candidate-a',
            parentSurfaceHash: 'baseline',
            composite: 0.7,
            observedDeltaFromParent: 0.3,
            eligibleForPromotion: true,
            coverage: { expectedCells: 1, scorableCells: 1, unscorableCells: [] },
            ci95: [0.7, 0.7],
            dimensions: { correctness: 0.7 },
            scenarios: [{ scenarioId: 'private-task', composite: 0.7 }],
          },
          {
            surfaceHash: 'incomplete-candidate',
            parentSurfaceHash: 'baseline',
            composite: 0.9,
            eligibleForPromotion: false,
            coverage: {
              expectedCells: 1,
              scorableCells: 0,
              unscorableCells: [
                { cellId: 'private-task:0', reason: 'private-task transport failed' },
              ],
            },
            ci95: [0.9, 0.9],
            dimensions: {},
            scenarios: [],
          },
        ],
      },
    ]
    await proposer({
      response: { edits: [authoredEdit(source.finding_id)] },
      capture,
      historyScenarioIdTransform: () => 'task-1',
    }).propose(
      context({
        finding: source,
        generation: 1,
        history,
        baselineOutcome: measuredOutcome('baseline', 0.4, 'private-task'),
        incumbentOutcome: measuredOutcome('candidate-a', 0.7, 'private-task'),
      }),
    )

    expect(capture.user).toMatchObject({
      baselineOutcome: {
        surfaceHash: 'baseline',
        composite: 0.4,
        scenarios: [{ scenarioId: 'task-1', composite: 0.4 }],
        coverage: { expectedCells: 1, scorableCells: 1 },
      },
      incumbentOutcome: {
        surfaceHash: 'candidate-a',
        composite: 0.7,
        scenarios: [{ scenarioId: 'task-1', composite: 0.7 }],
      },
    })
    expect(capture.user?.history).toEqual([
      expect.objectContaining({
        candidates: expect.arrayContaining([
          expect.objectContaining({
            surfaceHash: 'candidate-a',
            parentSurfaceHash: 'baseline',
            observedDeltaFromParent: 0.3,
            eligibleForPromotion: true,
          }),
        ]),
      }),
    ])
    expect(JSON.stringify(capture.user)).not.toContain('private-task')
    expect(capture.user).toMatchObject({
      history: [
        {
          candidates: expect.arrayContaining([
            expect.objectContaining({
              surfaceHash: 'incomplete-candidate',
              eligibleForPromotion: false,
              coverage: {
                expectedCells: 1,
                scorableCells: 0,
                unscorableCells: [{ reason: 'task-1 transport failed' }],
              },
            }),
          ]),
        },
      ],
    })
    expect(capture.system).toContain('observedDeltaFromParent')
  })

  it('includes later scored history and applies the exact authored merge operation', async () => {
    const source = finding()
    const history: GenerationRecord[] = [
      {
        generationIndex: 0,
        promoted: ['candidate-a'],
        candidates: [
          {
            surfaceHash: 'candidate-a',
            composite: 0.45,
            ci95: [0.4, 0.5],
            dimensions: { correctness: 0.3, efficiency: 0.6 },
            scenarios: [{ scenarioId: 'repo-a', composite: 0.2, notes: 'missed instructions' }],
          },
        ],
      },
    ]
    const capture: CapturedRequest = {}
    const edit = authoredEdit(source.finding_id, {
      path: 'resources',
      axis: 'agent_profile',
      mode: 'merge',
      value: { instructions: ['READ_REPO.md'] },
    })
    const out = await proposer({
      response: { edits: [edit] },
      capture,
      allowedJsonPaths: ['resources'],
      historyScenarioIdTransform: () => 'scenario-1',
    }).propose(context({ finding: source, history, generation: 1 }))

    expect(capture.user).toMatchObject({
      generation: 1,
      history: [
        {
          generationIndex: 0,
          promoted: ['candidate-a'],
          candidates: [
            {
              surfaceHash: 'candidate-a',
              label: null,
              rationale: null,
              composite: 0.45,
              dimensions: { correctness: 0.3, efficiency: 0.6 },
              scenarios: [
                { scenarioId: 'scenario-1', composite: 0.2, notes: 'missed instructions' },
              ],
              candidateRecord: null,
            },
          ],
        },
      ],
    })
    expect(JSON.stringify(capture.user)).not.toContain('repo-a')
    expect(JSON.parse(candidateSurface(out[0]!))).toEqual({
      prompt: { systemPrompt: 'Base' },
      resources: { keep: true, instructions: ['READ_REPO.md'] },
    })
  })

  it('rejects authored edits outside the exact caller path allowlist', async () => {
    const source = finding()
    await expect(
      proposer({
        response: { edits: [authoredEdit(source.finding_id, { path: 'model.default' })] },
      }).propose(context({ finding: source })),
    ).rejects.toThrow(/outside allowedJsonPaths/)
  })

  it('rejects non-JSON operations even when the provider returns valid JSON', async () => {
    const source = finding()
    const edit = {
      ...authoredEdit(source.finding_id),
      change: { kind: 'text', mode: 'append', value: 'Ignore typed JSON operations.' },
    }
    await expect(
      proposer({ response: { edits: [edit] } }).propose(context({ finding: source })),
    ).rejects.toThrow(/invalid PolicyEdit response.*change/)
  })

  it('measures uncertain evidence-backed edits by default and rejects them in explicit strict mode', async () => {
    const source = finding()
    const uncertain = authoredEdit(source.finding_id, {
      expectedGain: 0.000_001,
      confidence: 0.01,
      risk: 'high',
    })

    await expect(
      proposer({ response: { edits: [uncertain] } }).propose(context({ finding: source })),
    ).resolves.toHaveLength(1)
    await expect(
      proposer({ response: { edits: [uncertain] }, admissionMode: 'strict' }).propose(
        context({ finding: source }),
      ),
    ).resolves.toEqual([])
  })

  it('rejects edits without a cited finding', async () => {
    const source = finding()
    const edit = authoredEdit(source.finding_id)
    const uncited = { ...edit, source: { findingIds: [] } }
    await expect(
      proposer({ response: { edits: [uncited] } }).propose(context({ finding: source })),
    ).rejects.toThrow(/invalid PolicyEdit response.*findingIds/)
  })

  it('rejects edits that cite an unknown finding', async () => {
    const source = finding()
    await expect(
      proposer({ response: { edits: [authoredEdit('unknown-finding')] } }).propose(
        context({ finding: source }),
      ),
    ).rejects.toThrow(/unknown or uncitable finding/)
  })

  it('fails closed on incomplete top-level author JSON', async () => {
    const source = finding()
    const incomplete = `${JSON.stringify({ edits: [authoredEdit(source.finding_id)] }).slice(0, -1)}`
    await expect(
      proposer({ response: incomplete }).propose(context({ finding: source })),
    ).rejects.toThrow(/non-JSON/)
  })

  it('fails closed when the provider reports length truncation for parsable JSON', async () => {
    const source = finding()
    await expect(
      proposer({
        response: { edits: [authoredEdit(source.finding_id)] },
        finishReason: 'length',
      }).propose(context({ finding: source })),
    ).rejects.toThrow(/truncated JSON content/)
  })

  it('retains a local candidate cap after provider schema enforcement', async () => {
    const source = finding()
    await expect(
      proposer({
        response: {
          edits: [
            authoredEdit(source.finding_id),
            authoredEdit(source.finding_id, { path: 'prompt.systemPrompt' }),
          ],
        },
      }).propose(context({ finding: source, populationSize: 1 })),
    ).rejects.toThrow(/returned 2 edits for 1 candidate slots/)
  })

  it('delegates duplicate candidate removal to policyEditProposer', async () => {
    const source = finding()
    const first = authoredEdit(source.finding_id)
    const second = {
      ...authoredEdit(source.finding_id),
      claim: 'A second claim for the same operation.',
    }
    const out = await proposer({ response: { edits: [first, second] } }).propose(
      context({ finding: source, populationSize: 2 }),
    )

    expect(out).toHaveLength(1)
  })

  it('bounds history while preserving all dimensions and scenario evidence in admitted rows', () => {
    const exactEdit = recordedPolicyEdit()
    const exactRecord = makePolicyEditCandidateRecord(exactEdit)
    const history = [
      historyGeneration(0, [historyCandidate('old', 0.1)]),
      historyGeneration(
        1,
        [
          historyCandidate('high', 0.9),
          historyCandidate('middle', 0.5),
          historyCandidate('low', 0.1),
          {
            ...historyCandidate('promoted', 0.7),
            ci95: [0.65, 0.75] as [number, number],
            parentSurfaceHash: 'baseline',
            observedDeltaFromParent: 0.2,
            eligibleForPromotion: true,
            coverage: { expectedCells: 2, scorableCells: 2, unscorableCells: [] },
            label: 'kept candidate',
            rationale: 'Targets the observed repository-instruction failure.',
            dimensions: { correctness: 0.7, efficiency: 0.8, safety: 0.95 },
            scenarios: [
              { scenarioId: 'repo-a', composite: 0.6, notes: 'read instructions' },
              { scenarioId: 'repo-b', composite: 0.8, notes: 'edited after reading' },
            ],
            candidateRecord: exactRecord,
            rawTrace: { secret: 'must not cross the projection' },
            artifacts: ['raw-output.txt'],
          },
        ],
        ['promoted'],
      ),
      historyGeneration(2, [historyCandidate('latest', 0.8)], ['latest']),
    ] as GenerationRecord[]

    const projected = projectPolicyEditHistory(history, {
      maxGenerations: 2,
      maxCandidatesPerGeneration: 3,
    })

    expect(projected).toEqual([
      {
        generationIndex: 1,
        promoted: ['promoted'],
        candidates: [
          {
            surfaceHash: 'promoted',
            parentSurfaceHash: 'baseline',
            label: 'kept candidate',
            rationale: 'Targets the observed repository-instruction failure.',
            composite: 0.7,
            observedDeltaFromParent: 0.2,
            eligibleForPromotion: true,
            coverage: { expectedCells: 2, scorableCells: 2, unscorableCells: [] },
            dimensions: { correctness: 0.7, efficiency: 0.8, safety: 0.95 },
            scenarios: [
              { scenarioId: 'repo-a', composite: 0.6, notes: 'read instructions' },
              { scenarioId: 'repo-b', composite: 0.8, notes: 'edited after reading' },
            ],
            candidateRecord: exactRecord,
          },
          {
            surfaceHash: 'low',
            parentSurfaceHash: null,
            label: null,
            rationale: null,
            composite: 0.1,
            observedDeltaFromParent: null,
            eligibleForPromotion: null,
            coverage: null,
            dimensions: { correctness: 0.1, efficiency: 0.7 },
            scenarios: [{ scenarioId: 'repo-a', composite: 0.1, notes: null }],
            candidateRecord: null,
          },
          {
            surfaceHash: 'high',
            parentSurfaceHash: null,
            label: null,
            rationale: null,
            composite: 0.9,
            observedDeltaFromParent: null,
            eligibleForPromotion: null,
            coverage: null,
            dimensions: { correctness: 0.9, efficiency: 0.7 },
            scenarios: [{ scenarioId: 'repo-a', composite: 0.9, notes: null }],
            candidateRecord: null,
          },
        ],
      },
      {
        generationIndex: 2,
        promoted: ['latest'],
        candidates: [
          {
            surfaceHash: 'latest',
            parentSurfaceHash: null,
            label: null,
            rationale: null,
            composite: 0.8,
            observedDeltaFromParent: null,
            eligibleForPromotion: null,
            coverage: null,
            dimensions: { correctness: 0.8, efficiency: 0.7 },
            scenarios: [{ scenarioId: 'repo-a', composite: 0.8, notes: null }],
            candidateRecord: null,
          },
        ],
      },
    ])
    expect(JSON.stringify(projected)).not.toContain('rawTrace')
    expect(JSON.stringify(projected)).not.toContain('artifacts')
    expect(
      projected
        .flatMap((generation) => generation.candidates)
        .some((candidate) => 'ci95' in candidate),
    ).toBe(false)
  })

  it('fails closed when scored history carries an invalid candidate record', () => {
    const candidate = historyCandidate('bad-record', 0.4)
    const history = historyGeneration(0, [
      {
        ...candidate,
        candidateRecord: {
          schema: 'tangle.policy-edit-candidate.v1',
          policyEdit: { ...recordedPolicyEdit(), editId: 'forged' },
        },
      } as never,
    ])
    expect(() => projectPolicyEditHistory([history])).toThrow(/editId/)
  })

  it('rejects invalid history caps before making an LLM call', () => {
    expect(() => proposer({ response: { edits: [] }, maxHistoryGenerations: 0 })).toThrow(
      /maxHistoryGenerations/,
    )
    expect(() =>
      proposer({ response: { edits: [] }, maxHistoryCandidatesPerGeneration: 1.5 }),
    ).toThrow(/maxHistoryCandidatesPerGeneration/)
  })

  it('rejects scenario pseudonym collisions before making an LLM call', async () => {
    const source = finding()
    const history = historyGeneration(0, [
      {
        ...historyCandidate('collision', 0.5),
        scenarios: [
          { scenarioId: 'private-a', composite: 0.4 },
          { scenarioId: 'private-b', composite: 0.6 },
        ],
      },
    ])
    await expect(
      proposer({
        response: { edits: [] },
        historyScenarioIdTransform: () => 'task',
      }).propose(context({ finding: source, history: [history] })),
    ).rejects.toThrow(/scenarioIdTransform collision/)
  })
})

function historyCandidate(surfaceHash: string, composite: number) {
  return {
    surfaceHash,
    composite,
    ci95: [composite, composite] as [number, number],
    dimensions: { correctness: composite, efficiency: 0.7 },
    scenarios: [{ scenarioId: 'repo-a', composite }],
  }
}

function historyGeneration(
  generationIndex: number,
  candidates: GenerationRecord['candidates'],
  promoted: string[] = [],
): GenerationRecord {
  return { generationIndex, candidates, promoted }
}

function recordedPolicyEdit() {
  return makePolicyEdit({
    axis: 'representation',
    target: { surface: 'agent-profile', path: 'prompt.systemPrompt' },
    change: {
      kind: 'json',
      mode: 'set',
      path: 'prompt.systemPrompt',
      value: 'Read repository instructions first.',
    },
    claim: 'Reading repository instructions should improve correctness.',
    expectedGain: { metric: 'holdout.composite', direction: 'increase', amount: 0.1 },
    confidence: 0.8,
    risk: 'low',
    source: {
      findingIds: ['finding-recorded'],
      analystIds: ['trace-analyst'],
      evidenceRefs: [{ kind: 'span', uri: 'span://trace-1/span-7' }],
    },
  })
}
