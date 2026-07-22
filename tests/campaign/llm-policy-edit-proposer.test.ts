import { describe, expect, it } from 'vitest'
import type { AgentProfileJsonObject } from '../../src/agent-profile-cell'
import {
  makePolicyEdit,
  makePolicyEditCandidateRecord,
  type PolicyEditAdmissionOptions,
} from '../../src/analyst/policy-edit'
import { type AnalystFinding, makeFinding } from '../../src/analyst/types'
import {
  llmPolicyEditProposer,
  type PolicyEditFindingInput,
  type PolicyEditFindingSource,
  type PolicyEditObjective,
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

const OBJECTIVES: PolicyEditObjective[] = [
  {
    key: 'search.composite',
    split: 'search',
    direction: 'increase',
    scale: { min: 0, max: 1 },
    unit: 'score',
  },
]

function authoredEdit(
  findingKey: string,
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
      metric: 'search.composite',
      direction: 'increase',
      amount: options.expectedGain ?? 0.12,
      unit: 'score',
      rationale: null,
    },
    confidence: options.confidence ?? 0.9,
    risk: options.risk ?? 'low',
    source: { findingKeys: [findingKey] },
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
  findingSource?: PolicyEditFindingSource
}): ProposeContext<PolicyEditFindingInput> {
  return {
    currentSurface:
      input.currentSurface ?? '{"prompt":{"systemPrompt":"Base"},"resources":{"keep":true}}',
    history: input.history ?? [],
    findings: [
      {
        finding: input.finding,
        source: input.findingSource ?? { kind: 'global', label: 'test doctrine' },
      },
    ],
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
  scenarioIdTransform?: (scenarioId: string) => string
  maxScenariosPerCandidate?: number
  maxFindings?: number
  maxAuthorContextChars?: number
  objectives?: PolicyEditObjective[]
  targetSurface?: 'agent-profile' | 'code'
  admissionMode?: 'evidence-only' | 'strict'
  admission?: PolicyEditAdmissionOptions
  redactCurrentSurfaceForModel?: (surface: AgentProfileJsonObject) => AgentProfileJsonObject
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
    targetSurface: (input.targetSurface ?? 'agent-profile') as 'agent-profile',
    allowedJsonPaths: input.allowedJsonPaths ?? ['prompt.systemPrompt'],
    objectives: input.objectives ?? OBJECTIVES,
    ...(input.maxHistoryGenerations === undefined
      ? {}
      : { maxHistoryGenerations: input.maxHistoryGenerations }),
    ...(input.maxHistoryCandidatesPerGeneration === undefined
      ? {}
      : { maxHistoryCandidatesPerGeneration: input.maxHistoryCandidatesPerGeneration }),
    ...(input.scenarioIdTransform === undefined
      ? {}
      : { scenarioIdTransform: input.scenarioIdTransform }),
    ...(input.maxScenariosPerCandidate === undefined
      ? {}
      : { maxScenariosPerCandidate: input.maxScenariosPerCandidate }),
    ...(input.maxFindings === undefined ? {} : { maxFindings: input.maxFindings }),
    ...(input.maxAuthorContextChars === undefined
      ? {}
      : { maxAuthorContextChars: input.maxAuthorContextChars }),
    ...(input.admissionMode === undefined ? {} : { admissionMode: input.admissionMode }),
    ...(input.admission === undefined ? {} : { admission: input.admission }),
    ...(input.redactCurrentSurfaceForModel === undefined
      ? {}
      : { redactCurrentSurfaceForModel: input.redactCurrentSurfaceForModel }),
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
  generation = -1,
): ScoredSurfaceOutcome {
  return {
    split: 'search',
    generation,
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
    const edit = authoredEdit('finding-1')
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
          findingKey: 'finding-1',
          sources: [{ kind: 'global', label: 'test doctrine' }],
          evidenceRefs: [
            expect.objectContaining({
              kind: source.evidence_refs[0]!.kind,
              uri: source.evidence_refs[0]!.uri,
            }),
          ],
        },
      ],
    })
    expect(capture.system).toContain('"mode":"set"')
    expect(capture.system).toContain('"mode":"merge"')
    expect(capture.system).toContain('"mode":"remove"')
    expect(capture.system).toContain('source.findingKeys')
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

  it('redacts private fields from model input and applies edits to the complete surface', async () => {
    const capture: CapturedRequest = {}
    const out = await proposer({
      response: { edits: [authoredEdit('finding-1')] },
      capture,
      redactCurrentSurfaceForModel: (surface) => ({ prompt: surface.prompt }),
    }).propose(
      context({
        finding: finding(),
        currentSurface: JSON.stringify({
          prompt: { systemPrompt: 'Base' },
          mcp: {
            linear: {
              transport: 'http',
              url: 'https://mcp.example.test',
              headers: { Authorization: 'Bearer private-token' },
            },
          },
        }),
      }),
    )

    expect(capture.user?.currentSurface).toEqual({ prompt: { systemPrompt: 'Base' } })
    expect(JSON.stringify(capture.user)).not.toContain('private-token')
    expect(JSON.parse(candidateSurface(out[0]!))).toEqual({
      prompt: { systemPrompt: 'Read repository instructions first.' },
      mcp: {
        linear: {
          transport: 'http',
          url: 'https://mcp.example.test',
          headers: { Authorization: 'Bearer private-token' },
        },
      },
    })
  })

  it('rejects a non-object redaction result before model dispatch', async () => {
    const capture: CapturedRequest = {}
    const configured = proposer({
      response: { edits: [] },
      capture,
      redactCurrentSurfaceForModel: () => [] as unknown as AgentProfileJsonObject,
    })

    await expect(configured.propose(context({ finding: finding() }))).rejects.toThrow(
      /redactCurrentSurfaceForModel must return a JSON object/,
    )
    expect(capture.user).toBeUndefined()
  })

  it('rejects redaction that hides an editable subtree before model dispatch', async () => {
    const capture: CapturedRequest = {}
    const configured = proposer({
      response: { edits: [] },
      capture,
      allowedJsonPaths: ['mcp.linear'],
      redactCurrentSurfaceForModel: (surface) => ({ prompt: surface.prompt }),
    })

    await expect(
      configured.propose(
        context({
          finding: finding(),
          currentSurface: JSON.stringify({
            prompt: { systemPrompt: 'Base' },
            mcp: {
              linear: {
                transport: 'http',
                headers: { Authorization: 'Bearer private-token' },
              },
            },
          }),
        }),
      ),
    ).rejects.toThrow(/must not change or hide editable JSON path 'mcp\.linear'/)
    expect(capture.user).toBeUndefined()
  })

  it('does not let a mutating redaction callback alter the executable surface', async () => {
    const out = await proposer({
      response: { edits: [authoredEdit('finding-1')] },
      redactCurrentSurfaceForModel: (surface) => {
        delete surface.mcp
        return { prompt: surface.prompt }
      },
    }).propose(
      context({
        finding: finding(),
        currentSurface: JSON.stringify({
          prompt: { systemPrompt: 'Base' },
          mcp: { linear: { headers: { Authorization: 'Bearer private-token' } } },
        }),
      }),
    )

    expect(JSON.parse(candidateSurface(out[0]!))).toMatchObject({
      mcp: { linear: { headers: { Authorization: 'Bearer private-token' } } },
    })
  })

  it('rejects redacted JSON keys that validation would otherwise rewrite', async () => {
    const configured = proposer({
      response: { edits: [] },
      redactCurrentSurfaceForModel: (surface) => ({ ...surface, ' mcp': {} }),
    })

    await expect(configured.propose(context({ finding: finding() }))).rejects.toThrow(
      /redactCurrentSurfaceForModel returned invalid JSON.*surrounding whitespace/,
    )
  })

  it('rejects task identifiers introduced by model-surface redaction', async () => {
    let redactionCalled = false
    const configured = proposer({
      response: { edits: [authoredEdit('finding-1')] },
      scenarioIdTransform: () => 'task-1',
      redactCurrentSurfaceForModel: (surface) => {
        redactionCalled = true
        return { ...surface, modelContext: { note: 'Handle private-task' } }
      },
    })

    await expect(
      configured.propose(
        context({
          finding: finding(),
          currentSurface: '{"prompt":{"systemPrompt":"Base"}}',
          baselineOutcome: measuredOutcome('baseline', 0.4, 'private-task'),
        }),
      ),
    ).rejects.toThrow(/raw scenario identifier/)
    expect(redactionCalled).toBe(true)
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
            parentComposite: 0.4,
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
            parentComposite: 0.4,
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
      response: { edits: [authoredEdit('finding-1')] },
      capture,
      scenarioIdTransform: () => 'task-1',
    }).propose(
      context({
        finding: source,
        generation: 1,
        history,
        baselineOutcome: measuredOutcome('baseline', 0.4, 'private-task'),
        incumbentOutcome: measuredOutcome('candidate-a', 0.7, 'private-task', 0),
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
            parentComposite: 0.4,
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
    const edit = authoredEdit('finding-1', {
      path: 'resources',
      axis: 'agent_profile',
      mode: 'merge',
      value: { instructions: ['READ_REPO.md'] },
    })
    const out = await proposer({
      response: { edits: [edit] },
      capture,
      allowedJsonPaths: ['resources'],
      scenarioIdTransform: () => 'scenario-1',
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
              candidateEdit: null,
              forecastCalibration: null,
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
        response: { edits: [authoredEdit('finding-1', { path: 'model.default' })] },
      }).propose(context({ finding: source })),
    ).rejects.toThrow(/outside allowedJsonPaths/)
  })

  it('rejects non-JSON operations even when the provider returns valid JSON', async () => {
    const source = finding()
    const edit = {
      ...authoredEdit('finding-1'),
      change: { kind: 'text', mode: 'append', value: 'Ignore typed JSON operations.' },
    }
    await expect(
      proposer({ response: { edits: [edit] } }).propose(context({ finding: source })),
    ).rejects.toThrow(/invalid PolicyEdit response.*change/)
  })

  it('measures uncertain evidence-backed edits by default and rejects them in explicit strict mode', async () => {
    const source = finding()
    const uncertain = authoredEdit('finding-1', {
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
    const edit = authoredEdit('finding-1')
    const uncited = { ...edit, source: { findingKeys: [] } }
    await expect(
      proposer({ response: { edits: [uncited] } }).propose(context({ finding: source })),
    ).rejects.toThrow(/invalid PolicyEdit response.*findingKeys/)
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
    const incomplete = `${JSON.stringify({ edits: [authoredEdit('finding-1')] }).slice(0, -1)}`
    await expect(
      proposer({ response: incomplete }).propose(context({ finding: source })),
    ).rejects.toThrow(/non-JSON/)
  })

  it('fails closed when the provider reports length truncation for parsable JSON', async () => {
    const source = finding()
    await expect(
      proposer({
        response: { edits: [authoredEdit('finding-1')] },
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
            authoredEdit('finding-1'),
            authoredEdit('finding-1', { path: 'prompt.systemPrompt' }),
          ],
        },
      }).propose(context({ finding: source, populationSize: 1 })),
    ).rejects.toThrow(/returned 2 edits for 1 candidate slots/)
  })

  it('delegates duplicate candidate removal to policyEditProposer', async () => {
    const source = finding()
    const first = authoredEdit('finding-1')
    const second = {
      ...authoredEdit('finding-1'),
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
            parentComposite: 0.5,
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
      objectives: OBJECTIVES,
    })

    expect(projected).toEqual([
      {
        generationIndex: 1,
        promoted: ['promoted'],
        candidates: [
          {
            surfaceHash: 'promoted',
            parentSurfaceHash: 'baseline',
            parentComposite: 0.5,
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
            candidateEdit: expect.objectContaining({
              editId: exactEdit.editId,
              change: exactEdit.change,
              sourceFindingIds: ['finding-recorded'],
            }),
            forecastCalibration: {
              objectiveKey: 'search.composite',
              predictedDelta: 0.1,
              observedDelta: 0.2,
              residual: 0.1,
            },
          },
          {
            surfaceHash: 'low',
            parentSurfaceHash: null,
            parentComposite: null,
            label: null,
            rationale: null,
            composite: 0.1,
            observedDeltaFromParent: null,
            eligibleForPromotion: null,
            coverage: null,
            dimensions: { correctness: 0.1, efficiency: 0.7 },
            scenarios: [{ scenarioId: 'repo-a', composite: 0.1, notes: null }],
            candidateEdit: null,
            forecastCalibration: null,
          },
          {
            surfaceHash: 'high',
            parentSurfaceHash: null,
            parentComposite: null,
            label: null,
            rationale: null,
            composite: 0.9,
            observedDeltaFromParent: null,
            eligibleForPromotion: null,
            coverage: null,
            dimensions: { correctness: 0.9, efficiency: 0.7 },
            scenarios: [{ scenarioId: 'repo-a', composite: 0.9, notes: null }],
            candidateEdit: null,
            forecastCalibration: null,
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
            parentComposite: null,
            label: null,
            rationale: null,
            composite: 0.8,
            observedDeltaFromParent: null,
            eligibleForPromotion: null,
            coverage: null,
            dimensions: { correctness: 0.8, efficiency: 0.7 },
            scenarios: [{ scenarioId: 'repo-a', composite: 0.8, notes: null }],
            candidateEdit: null,
            forecastCalibration: null,
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

  it('does not compare historical forecasts in a different unit or outside the score scale', () => {
    const { editId: _editId, schemaVersion: _schemaVersion, ...base } = recordedPolicyEdit()
    void _editId
    void _schemaVersion
    const calibration = (unit: 'percent' | 'score', amount: number) => {
      const edit = makePolicyEdit({
        ...base,
        expectedGain: {
          metric: 'search.composite',
          direction: 'increase',
          amount,
          unit,
        },
      })
      const candidate = {
        ...historyCandidate('candidate', 0.7),
        parentComposite: 0.5,
        observedDeltaFromParent: 0.2,
        candidateRecord: makePolicyEditCandidateRecord(edit),
      }
      return projectPolicyEditHistory([historyGeneration(0, [candidate])], {
        objectives: OBJECTIVES,
      })[0]?.candidates[0]?.forecastCalibration
    }

    expect(calibration('percent', 10)).toBeNull()
    expect(calibration('score', 10)).toBeNull()
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
        scenarioIdTransform: () => 'task',
      }).propose(context({ finding: source, history: [history] })),
    ).rejects.toThrow(/scenarioIdTransform collision/)
  })

  it('scrubs one-letter scenario IDs without corrupting ordinary prose', () => {
    const history = historyGeneration(0, [
      {
        ...historyCandidate('short-ids', 0.5),
        coverage: {
          expectedCells: 2,
          scorableCells: 0,
          unscorableCells: [
            { cellId: 'a:0', reason: 'a transport failed' },
            { cellId: 'b:0', reason: 'transport failed for b' },
          ],
        },
        scenarios: [
          { scenarioId: 'a', composite: 0.4, notes: 'a transport failed' },
          { scenarioId: 'b', composite: 0.6, notes: 'transport failed for b' },
        ],
      },
    ])

    const projected = projectPolicyEditHistory([history], {
      scenarioIdTransform: (scenarioId) => `task-${scenarioId}`,
    })
    const serialized = JSON.stringify(projected)

    expect(serialized).toContain('task-a transport failed')
    expect(serialized).toContain('transport failed for task-b')
    expect(serialized).not.toContain('trtask-ansport')
    expect(serialized).not.toContain('fatask-ailed')
  })

  it('bounds a 4 × 16 × 500-task history before the model call', async () => {
    const source = finding()
    const capture: CapturedRequest = {}
    const history: GenerationRecord[] = Array.from({ length: 4 }, (_, generationIndex) => ({
      generationIndex,
      promoted: [],
      candidates: Array.from({ length: 16 }, (_, candidateIndex) => ({
        surfaceHash: `surface-${generationIndex}-${candidateIndex}`,
        composite: 0.5,
        ci95: [0.5, 0.5] as [number, number],
        dimensions: { correctness: 0.5 },
        scenarios: Array.from({ length: 500 }, (_, scenarioIndex) => ({
          scenarioId: `task-${scenarioIndex.toString().padStart(3, '0')}`,
          composite: scenarioIndex / 500,
          notes: `measured task ${scenarioIndex}`,
        })),
      })),
    }))

    await proposer({ response: { edits: [] }, capture }).propose(
      context({ finding: source, history, generation: 4 }),
    )

    const serialized = JSON.stringify(capture.user)
    expect(serialized.length).toBeLessThan(200_000)
    const projected = capture.user?.history as Array<{
      candidates: Array<{ scenarios: Array<{ scenarioId: string }> }>
    }>
    expect(projected).toHaveLength(4)
    expect(projected.flatMap((generation) => generation.candidates)).toHaveLength(64)
    for (const candidate of projected.flatMap((generation) => generation.candidates)) {
      expect(candidate.scenarios).toHaveLength(12)
      expect(candidate.scenarios[0]?.scenarioId).toBe('task-000')
    }
  })

  it('keeps contradictory findings attached to their exact measured source surfaces', async () => {
    const winnerFinding = makeFinding({
      analyst_id: 'trace-analyst',
      area: 'tool-use',
      severity: 'high',
      subject: 'repository-read',
      claim: 'The winning profile reads repository instructions.',
      evidence_refs: [{ kind: 'span', uri: 'span://winner/read' }],
      confidence: 0.9,
    })
    const loserFinding = makeFinding({
      analyst_id: 'trace-analyst',
      area: 'tool-use',
      severity: 'high',
      subject: 'repository-read',
      claim: 'The losing profile skips repository instructions.',
      evidence_refs: [{ kind: 'span', uri: 'span://loser/skip' }],
      confidence: 0.9,
    })
    const history = historyGeneration(0, [
      historyCandidate('winner-surface', 0.8),
      historyCandidate('loser-surface', 0.2),
    ])
    const ctx = context({ finding: winnerFinding, history: [history], generation: 1 })
    ctx.findings = [
      {
        finding: winnerFinding,
        source: { kind: 'surface', surfaceHash: 'winner-surface', generation: 0 },
      },
      {
        finding: loserFinding,
        source: { kind: 'surface', surfaceHash: 'loser-surface', generation: 0 },
      },
    ]
    const capture: CapturedRequest = {}

    await proposer({ response: { edits: [] }, capture }).propose(ctx)

    const rendered = capture.user?.findings as Array<{
      claim: string
      subject: string
      sources: PolicyEditFindingSource[]
    }>
    expect(rendered).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          claim: winnerFinding.claim,
          subject: 'repository-read',
          sources: [
            expect.objectContaining({
              kind: 'surface',
              surfaceHash: 'winner-surface',
              generation: 0,
              composite: 0.8,
            }),
          ],
        }),
        expect.objectContaining({
          claim: loserFinding.claim,
          subject: 'repository-read',
          sources: [
            expect.objectContaining({
              kind: 'surface',
              surfaceHash: 'loser-surface',
              generation: 0,
              composite: 0.2,
            }),
          ],
        }),
      ]),
    )
  })

  it('uses the incumbent measurement generation instead of the current proposal index', async () => {
    const source = finding()
    const winner = historyCandidate('winner-surface', 0.8)
    const history: GenerationRecord[] = [
      historyGeneration(0, [winner], ['winner-surface']),
      historyGeneration(1, [historyCandidate('loser-1', 0.2)]),
      historyGeneration(2, [historyCandidate('loser-2', 0.3)]),
      historyGeneration(3, [historyCandidate('loser-3', 0.1)]),
    ]
    const incumbentOutcome = measuredOutcome('winner-surface', 0.8, 'task', 0)

    await expect(
      proposer({ response: { edits: [] } }).propose(
        context({
          finding: source,
          findingSource: { kind: 'surface', surfaceHash: 'winner-surface', generation: 0 },
          history,
          generation: 4,
          incumbentOutcome,
        }),
      ),
    ).resolves.toEqual([])

    await expect(
      proposer({ response: { edits: [] } }).propose(
        context({
          finding: source,
          findingSource: { kind: 'surface', surfaceHash: 'winner-surface', generation: 3 },
          history,
          generation: 4,
          incumbentOutcome,
        }),
      ),
    ).rejects.toThrow(/winner-surface@3 is not a measured surface/)
  })

  it('pseudonymizes every author-visible evidence and history field', async () => {
    const source = makeFinding({
      analyst_id: 'private-task',
      area: 'private-task',
      severity: 'high',
      subject: 'private-task',
      claim: 'private-task failed',
      rationale: 'private-task rationale',
      recommended_action: 'fix private-task',
      validation_plan: 'rerun private-task',
      evidence_refs: [
        {
          kind: 'span',
          uri: 'span://private-task/1',
          excerpt: 'private-task excerpt',
        },
      ],
      confidence: 0.9,
    })
    const priorEdit = makePolicyEdit({
      axis: 'agent_profile',
      target: { surface: 'agent-profile', path: 'prompt.systemPrompt' },
      change: {
        kind: 'json',
        mode: 'set',
        path: 'prompt.systemPrompt',
        value: 'private-task instruction',
      },
      claim: 'private-task edit',
      expectedGain: {
        metric: 'search.composite',
        direction: 'increase',
        amount: 0.1,
        unit: 'score',
      },
      confidence: 0.8,
      risk: 'low',
      source: {
        findingIds: ['private-task'],
        analystIds: ['private-task'],
        evidenceRefs: [{ kind: 'span', uri: 'span://private-task/prior' }],
      },
    })
    const history = historyGeneration(0, [
      {
        ...historyCandidate('private-task', 0.2),
        label: 'private-task label',
        rationale: 'private-task rationale',
        dimensions: { 'private-task': 0.2 },
        scenarios: [{ scenarioId: 'private-task', composite: 0.2, notes: 'private-task note' }],
        candidateRecord: makePolicyEditCandidateRecord(priorEdit),
      },
    ])
    const capture: CapturedRequest = {}

    await proposer({
      response: { edits: [] },
      capture,
      scenarioIdTransform: () => 'task-1',
    }).propose(
      context({
        finding: source,
        findingSource: { kind: 'global', label: 'private-task doctrine' },
        history: [history],
        baselineOutcome: {
          ...measuredOutcome('baseline', 0.3, 'private-task'),
          dimensions: { 'private-task': 0.3 },
        },
      }),
    )

    expect(
      JSON.stringify({
        system: capture.system,
        user: capture.user,
        responseFormat: capture.responseFormat,
      }),
    ).not.toContain('private-task')
  })

  it('rejects unattributed findings and unknown measured sources before a model call', async () => {
    const source = finding()
    const capture: CapturedRequest = {}
    const unwrapped = context({ finding: source })
    unwrapped.findings = [source as never]
    await expect(proposer({ response: { edits: [] }, capture }).propose(unwrapped)).rejects.toThrow(
      /attributed PolicyEditFindingInput/,
    )
    expect(capture.user).toBeUndefined()

    const unknown = context({
      finding: source,
      findingSource: { kind: 'surface', surfaceHash: 'not-measured', generation: 0 },
    })
    await expect(proposer({ response: { edits: [] }, capture }).propose(unknown)).rejects.toThrow(
      /is not a measured surface/,
    )
  })

  it('rejects held-out outcomes, non-JSON targets, and unmeasurable forecast objectives', async () => {
    const source = finding()
    const badSplit = context({
      finding: source,
      baselineOutcome: { ...measuredOutcome('baseline', 0.4, 'task'), split: 'holdout' } as never,
    })
    await expect(proposer({ response: { edits: [] } }).propose(badSplit)).rejects.toThrow(
      /baselineOutcome must be a search-split outcome/,
    )

    expect(() => proposer({ response: { edits: [] }, targetSurface: 'code' })).toThrow(
      /not a JSON-backed surface/,
    )
    expect(() =>
      proposer({
        response: { edits: [] },
        objectives: [
          {
            ...OBJECTIVES[0]!,
            key: 'holdout.composite',
          },
        ],
      }),
    ).toThrow(/not yet measurable/)
  })

  it('rejects objective meanings that disagree with raw score maximization', () => {
    expect(() =>
      proposer({
        response: { edits: [] },
        objectives: [
          {
            ...OBJECTIVES[0]!,
            direction: 'decrease',
          },
        ] as never,
      }),
    ).toThrow(/must increase/)
    for (const unit of ['percent', 'relative', 'absolute'] as const) {
      expect(() =>
        proposer({
          response: { edits: [] },
          objectives: [{ ...OBJECTIVES[0]!, unit }] as never,
        }),
      ).toThrow(/must use raw score deltas/)
    }
  })

  it('rejects measured composites outside the declared score scale before a model call', async () => {
    const capture: CapturedRequest = {}
    await expect(
      proposer({ response: { edits: [] }, capture }).propose(
        context({
          finding: finding(),
          baselineOutcome: measuredOutcome('baseline', 1.01, 'task'),
        }),
      ),
    ).rejects.toThrow(/baselineOutcome\.composite 1\.01 is outside objective/)
    expect(capture.user).toBeUndefined()
  })

  it('rejects forecast direction, unit, and magnitude outside the declared objective', async () => {
    const source = finding()
    await expect(
      proposer({
        response: {
          edits: [
            {
              ...authoredEdit('finding-1'),
              expectedGain: {
                ...authoredEdit('finding-1').expectedGain,
                direction: 'decrease',
              },
            },
          ],
        },
      }).propose(context({ finding: source })),
    ).rejects.toThrow(/forecast direction/)
    await expect(
      proposer({
        response: {
          edits: [
            {
              ...authoredEdit('finding-1'),
              expectedGain: { ...authoredEdit('finding-1').expectedGain, unit: 'percent' },
            },
          ],
        },
      }).propose(context({ finding: source })),
    ).rejects.toThrow(/forecast unit/)
    await expect(
      proposer({
        response: {
          edits: [
            {
              ...authoredEdit('finding-1'),
              expectedGain: { ...authoredEdit('finding-1').expectedGain, amount: 2 },
            },
          ],
        },
      }).propose(context({ finding: source })),
    ).rejects.toThrow(/exceeds the available score headroom/)

    await expect(
      proposer({
        response: {
          edits: [authoredEdit('finding-1', { expectedGain: 0.12 })],
        },
      }).propose(
        context({
          finding: source,
          baselineOutcome: measuredOutcome('baseline', 0.95, 'task'),
        }),
      ),
    ).rejects.toThrow(/exceeds the available score headroom/)
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
    expectedGain: {
      metric: 'search.composite',
      direction: 'increase',
      amount: 0.1,
      unit: 'score',
    },
    confidence: 0.8,
    risk: 'low',
    source: {
      findingIds: ['finding-recorded'],
      analystIds: ['trace-analyst'],
      evidenceRefs: [{ kind: 'span', uri: 'span://trace-1/span-7' }],
    },
  })
}
