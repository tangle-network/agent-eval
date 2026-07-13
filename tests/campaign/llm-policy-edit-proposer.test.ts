import { describe, expect, it } from 'vitest'
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
      amount: 0.12,
      unit: 'score',
      rationale: null,
    },
    confidence: 0.9,
    risk: 'low',
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
}): ProposeContext<AnalystFinding> {
  return {
    currentSurface:
      input.currentSurface ?? '{"prompt":{"systemPrompt":"Base"},"resources":{"keep":true}}',
    history: input.history ?? [],
    findings: [input.finding],
    populationSize: input.populationSize ?? 1,
    generation: input.generation ?? 0,
    signal: new AbortController().signal,
  }
}

function proposer(input: {
  response: unknown
  capture?: CapturedRequest
  allowedJsonPaths?: string[]
  finishReason?: string | null
  maxHistoryGenerations?: number
  maxHistoryCandidatesPerGeneration?: number
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
  })
}

function candidateSurface(candidate: MutableSurface | ProposedCandidate): string {
  return String(
    typeof candidate === 'object' && 'surface' in candidate ? candidate.surface : candidate,
  )
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
        schema: { type: 'object', additionalProperties: false },
      },
    })
    const providerSchema = JSON.stringify(capture.responseFormat)
    expect(providerSchema).toContain('"kind":{"const":"json"}')
    expect(providerSchema).toContain('"mode":{"const":"set"}')
    expect(providerSchema).toContain('"mode":{"const":"merge"}')
    expect(providerSchema).toContain('"mode":{"const":"remove"}')
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
              scenarios: [{ scenarioId: 'repo-a', composite: 0.2, notes: 'missed instructions' }],
            },
          ],
        },
      ],
    })
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
    const history = [
      historyGeneration(0, [historyCandidate('old', 0.1)]),
      historyGeneration(
        1,
        [
          historyCandidate('high', 0.9),
          {
            ...historyCandidate('promoted', 0.2),
            label: 'kept candidate',
            rationale: 'Targets the observed repository-instruction failure.',
            dimensions: { correctness: 0.2, efficiency: 0.7, safety: 0.95 },
            scenarios: [
              { scenarioId: 'repo-a', composite: 0.1, notes: 'skipped instructions' },
              { scenarioId: 'repo-b', composite: 0.3, notes: 'read after editing' },
            ],
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
      maxCandidatesPerGeneration: 1,
    })

    expect(projected).toEqual([
      {
        generationIndex: 1,
        promoted: ['promoted'],
        candidates: [
          {
            surfaceHash: 'promoted',
            label: 'kept candidate',
            rationale: 'Targets the observed repository-instruction failure.',
            composite: 0.2,
            dimensions: { correctness: 0.2, efficiency: 0.7, safety: 0.95 },
            scenarios: [
              { scenarioId: 'repo-a', composite: 0.1, notes: 'skipped instructions' },
              { scenarioId: 'repo-b', composite: 0.3, notes: 'read after editing' },
            ],
          },
        ],
      },
      {
        generationIndex: 2,
        promoted: ['latest'],
        candidates: [
          {
            surfaceHash: 'latest',
            label: null,
            rationale: null,
            composite: 0.8,
            dimensions: { correctness: 0.8, efficiency: 0.7 },
            scenarios: [{ scenarioId: 'repo-a', composite: 0.8, notes: null }],
          },
        ],
      },
    ])
    expect(JSON.stringify(projected)).not.toContain('rawTrace')
    expect(JSON.stringify(projected)).not.toContain('artifacts')
  })

  it('rejects invalid history caps before making an LLM call', () => {
    expect(() => proposer({ response: { edits: [] }, maxHistoryGenerations: 0 })).toThrow(
      /maxHistoryGenerations/,
    )
    expect(() =>
      proposer({ response: { edits: [] }, maxHistoryCandidatesPerGeneration: 1.5 }),
    ).toThrow(/maxHistoryCandidatesPerGeneration/)
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
