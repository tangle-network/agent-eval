import { describe, expect, it } from 'vitest'
import { toSftRows } from '../exporters'
import { fixtureRolloutLine, malformedRolloutLine } from '../fixtures'
import type { RolloutLine } from '../schema'
import { assertMinted, validateRolloutLine } from '../schema'
import {
  ATIF_SCHEMA_VERSION,
  fromHarborTrajectory,
  HARBOR_IMPORT_GAP,
  type HarborTrajectory,
  relabelImportedSplit,
  toHarborTrajectories,
  toHarborTrajectory,
} from './harbor'

const CAPTURED_AT = '2026-07-23T00:00:00.000Z'
const now = () => new Date(CAPTURED_AT)

/** A supervisor with two workers — the multi-agent shape ATIF embeds and we flatten. */
function episode(): RolloutLine[] {
  const base = fixtureRolloutLine()
  const supervisor = fixtureRolloutLine({
    rollout_id: 'sup-1',
    parent_rollout_id: null,
    role: 'supervisor',
    messages: [
      { role: 'system', content: 'You supervise two coding workers.' },
      { role: 'user', content: 'Fix astropy__astropy-13033.' },
      { role: 'assistant', content: 'Delegating to workers.' },
    ],
  })
  const workerA = fixtureRolloutLine({ rollout_id: 'w-a', parent_rollout_id: 'sup-1' })
  const workerB = fixtureRolloutLine({
    rollout_id: 'w-b',
    parent_rollout_id: 'sup-1',
    messages: base.messages.slice(0, 2),
    outcome: { ...base.outcome, reward: 0 },
  })
  return [supervisor, workerA, workerB]
}

describe('ATIF export', () => {
  it('emits an ATIF-v1.7 document with sequential step ids and the folded tool observation', () => {
    const line = fixtureRolloutLine()
    const trajectory = toHarborTrajectory([line])

    expect(trajectory.schema_version).toBe(ATIF_SCHEMA_VERSION)
    expect(trajectory.trajectory_id).toBe(line.rollout_id)
    // Run-scoped, not invocation-scoped: ATIF session_id carries our run_id.
    expect(trajectory.session_id).toBe(line.run_id)
    expect(trajectory.session_id).not.toBe(line.rollout_id)
    expect(trajectory.agent).toMatchObject({
      name: 'opencode',
      version: '1.0.0',
      model_name: 'glm-5.2',
      tool_definitions: line.tool_defs,
    })

    // 5 chat messages fold to 4 ATIF steps: the tool result has no ATIF
    // `source`, so it rides the preceding agent step's observation.
    expect(trajectory.steps.map((s) => s.source)).toEqual(['system', 'user', 'agent', 'agent'])
    expect(trajectory.steps.map((s) => s.step_id)).toEqual([1, 2, 3, 4])

    const delegating = trajectory.steps[2]!
    expect(delegating.message).toBe('')
    expect(delegating.reasoning_content).toBe('I should read the core module first.')
    expect(delegating.model_name).toBe('glm-5.2')
    expect(delegating.tool_calls).toEqual([
      {
        tool_call_id: 'call_1',
        function_name: 'read',
        arguments: { filePath: 'astropy/timeseries/core.py' },
        extra: { tangle: { arguments_raw: '{"filePath":"astropy/timeseries/core.py"}' } },
      },
    ])
    expect(delegating.observation).toEqual({
      results: [
        {
          source_call_id: 'call_1',
          content: 'class BaseTimeSeries: ...',
          extra: { tangle: { name: 'read' } },
        },
      ],
    })
  })

  it('maps cost to final_metrics, keeping the fields ATIF lacks in extra', () => {
    const trajectory = toHarborTrajectory([fixtureRolloutLine()])
    expect(trajectory.final_metrics).toEqual({
      total_prompt_tokens: 79554,
      total_completion_tokens: 19784,
      total_cached_tokens: 6784,
      total_cost_usd: 0.05,
      total_steps: 4,
      extra: { reasoning_tokens: 1200, cache_write_tokens: 0, wall_s: 549 },
    })
  })

  it('omits total_cost_usd rather than emitting a fake 0 when cost was not captured', () => {
    const line = fixtureRolloutLine({
      cost: { ...fixtureRolloutLine().cost, usd: null, tokens_in: null },
    })
    const trajectory = toHarborTrajectory([line])
    expect('total_cost_usd' in trajectory.final_metrics!).toBe(false)
    expect('total_prompt_tokens' in trajectory.final_metrics!).toBe(false)
  })

  it('drops reward, reward_source and verdict entirely — ATIF models none of them', () => {
    // STRUCTURAL, not textual. A substring scan for 'reward' passes only while
    // the fixture happens to have no reward-shaped key in `outcome.metrics`; it
    // says nothing about WHERE a match is and false-positives on any metric
    // whose name contains the word. This walks the document and names the path
    // of every label-shaped key instead.
    const gated = fixtureRolloutLine({
      outcome: {
        ...fixtureRolloutLine().outcome,
        metrics: { verify_pass: true, reward_hack_rate: 0.3, judge_reward: 1 },
      },
    })
    const trajectory = toHarborTrajectory([gated])
    expect(labelPaths(trajectory)).toEqual([])
    // The metrics bag is NOT the label and survives the round trip intact.
    expect(escrow(trajectory).outcome).toEqual({
      metrics: { verify_pass: true, reward_hack_rate: 0.3, judge_reward: 1 },
      is_completed: true,
      is_truncated: false,
      error: null,
      realness_gated: false,
    })
    // Exactly these keys: a new outcome field is not silently escrowed.
    expect(Object.keys(escrow(trajectory).outcome!).sort()).toEqual([
      'error',
      'is_completed',
      'is_truncated',
      'metrics',
      'realness_gated',
    ])
    // The check the substring version was standing in for, stated exactly.
    expect(JSON.stringify(trajectory)).toContain('reward_hack_rate')
  })

  it('states the realness gate in notes, since ATIF has no field for it', () => {
    // reward 0, because a gated line at a positive reward is now invalid —
    // `fixtureRolloutLine` validates, and 1-with-the-flag never existed on any
    // line the gate actually produced.
    const gated = fixtureRolloutLine({
      outcome: { ...fixtureRolloutLine().outcome, reward: 0, realness_gated: true },
    })
    const trajectory = toHarborTrajectory([gated])
    expect(trajectory.notes).toContain('realness-gated')
    expect(escrow(trajectory).outcome).toMatchObject({ realness_gated: true })
  })

  it('assembles the flat parent_rollout_id edges into embedded subagent_trajectories', () => {
    const trajectory = toHarborTrajectory(episode())
    expect(trajectory.trajectory_id).toBe('sup-1')
    expect(trajectory.subagent_trajectories?.map((t) => t.trajectory_id)).toEqual(['w-a', 'w-b'])
    // Every embedded subagent MUST carry a trajectory_id, unique in the array.
    const ids = trajectory.subagent_trajectories!.map((t) => t.trajectory_id)
    expect(new Set(ids).size).toBe(ids.length)
    // session_id is RUN-scoped: every node carries run_id, not its own rollout_id.
    const runId = fixtureRolloutLine().run_id
    expect(trajectory.session_id).toBe(runId)
    expect(trajectory.subagent_trajectories!.every((t) => t.session_id === runId)).toBe(true)
  })

  it('gives two roots of the SAME run the same session_id', () => {
    // The defect this replaces: session_id was the root LINE's rollout_id, so
    // two independent invocations of one run grouped as two different sessions.
    const rootA = fixtureRolloutLine({ rollout_id: 'root-a', parent_rollout_id: null })
    const rootB = fixtureRolloutLine({ rollout_id: 'root-b', parent_rollout_id: null })
    const [a, b] = toHarborTrajectories([rootA, rootB])
    expect(a!.session_id).toBe(b!.session_id)
    expect(a!.session_id).toBe(rootA.run_id)
    expect(a!.trajectory_id).not.toBe(b!.trajectory_id)
  })

  it('gives two roots of DIFFERENT runs different session_ids', () => {
    const other = fixtureRolloutLine({ rollout_id: 'root-c', run_id: '/tmp/run#456' })
    const [a, c] = toHarborTrajectories([fixtureRolloutLine(), other])
    expect(a!.session_id).not.toBe(c!.session_id)
    expect(c!.session_id).toBe('/tmp/run#456')
  })

  it('refuses a forest in one document and points at the plural entry point', () => {
    const [supervisor, workerA] = episode()
    const orphan = fixtureRolloutLine({ rollout_id: 'other', parent_rollout_id: null })
    expect(() => toHarborTrajectory([supervisor!, workerA!, orphan])).toThrow(/2 roots/)
    expect(toHarborTrajectories([supervisor!, workerA!, orphan])).toHaveLength(2)
  })

  it('rejects a parent_rollout_id cycle instead of recursing forever', () => {
    const a = fixtureRolloutLine({ rollout_id: 'a', parent_rollout_id: 'b' })
    const b = fixtureRolloutLine({ rollout_id: 'b', parent_rollout_id: 'a' })
    expect(() => toHarborTrajectories([a, b])).toThrow(/cycle/)
  })
})

const escrow = (t: HarborTrajectory): Record<string, Record<string, unknown>> =>
  (t.extra as { tangle: Record<string, Record<string, unknown>> }).tangle

/**
 * RFC 0001 MUST rule 2, checked over the whole tree: every `source_call_id` in
 * an `ObservationResult` matches a `tool_call_id` in THAT step's `tool_calls`.
 * Returns the offending `trajectory#step:call` triples.
 */
function ruleTwoViolations(trajectory: HarborTrajectory): string[] {
  const bad: string[] = []
  for (const step of trajectory.steps) {
    const declared = new Set((step.tool_calls ?? []).map((call) => call.tool_call_id))
    for (const result of step.observation?.results ?? []) {
      if (result.source_call_id !== undefined && !declared.has(result.source_call_id)) {
        bad.push(`${trajectory.trajectory_id}#${step.step_id}:${result.source_call_id}`)
      }
    }
  }
  for (const child of trajectory.subagent_trajectories ?? []) {
    bad.push(...ruleTwoViolations(child))
  }
  return bad
}

/** The three fields ATIF does not model and we refuse to smuggle into `extra`. */
const LABEL_KEYS = new Set(['reward', 'reward_source', 'verdict'])

/**
 * Every path in the document at which a label-shaped key appears — the
 * structural form of "the verdict is not in this file".
 *
 * `extra.tangle.outcome.metrics` is exempt by path, not by name: it is the
 * run's own measurement bag, a metric may legitimately be called
 * `reward_model_score`, and import reads it back as metrics, never as a label.
 */
function labelPaths(value: unknown, path = '$'): string[] {
  if (Array.isArray(value)) return value.flatMap((item, i) => labelPaths(item, `${path}[${i}]`))
  if (typeof value !== 'object' || value === null) return []
  const found: string[] = []
  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}.${key}`
    if (LABEL_KEYS.has(key)) found.push(childPath)
    if (childPath === '$.extra.tangle.outcome.metrics') continue
    found.push(...labelPaths(child, childPath))
  }
  return found
}

describe('ATIF round-trip', () => {
  const original = fixtureRolloutLine()
  const [restored] = fromHarborTrajectory(toHarborTrajectory([original]), { now })

  it('produces a valid rollout line', () => {
    expect(validateRolloutLine(restored)).toEqual([])
  })

  it('preserves everything ATIF plus the escrow can represent', () => {
    expect(restored!.rollout_id).toBe(original.rollout_id)
    expect(restored!.parent_rollout_id).toBe(original.parent_rollout_id)
    expect(restored!.run_id).toBe(original.run_id)
    expect(restored!.experiment_id).toBe(original.experiment_id)
    expect(restored!.candidate_id).toBe(original.candidate_id)
    expect(restored!.generation).toBe(original.generation)
    expect(restored!.candidate_index).toBe(original.candidate_index)
    expect(restored!.role).toBe(original.role)
    // Everything about the task EXCEPT its trainability, which no document may
    // assert about itself — see the escrowed-split test below.
    expect(restored!.task).toEqual({ ...original.task, split: 'holdout' })
    expect(restored!.policy).toEqual(original.policy)
    expect(restored!.messages).toEqual(original.messages)
    expect(restored!.tool_defs).toEqual(original.tool_defs)
    expect(restored!.cost).toEqual(original.cost)
    expect(restored!.artifacts).toEqual(original.artifacts)
    expect(restored!.outcome.metrics).toEqual(original.outcome.metrics)
    expect(restored!.outcome.is_completed).toBe(original.outcome.is_completed)
    expect(restored!.outcome.is_truncated).toBe(original.outcome.is_truncated)
    expect(restored!.outcome.realness_gated).toBe(false)
    expect(restored!.provenance.captured_at).toBe(original.provenance.captured_at)
    expect(restored!.provenance.capture).toBe(original.provenance.capture)
  })

  it('returns the fields ATIF cannot carry as an explicit unlabeled gap, never invented', () => {
    expect(original.outcome.reward).toBe(1)
    expect(restored!.outcome.reward).toBeNull()
    expect(restored!.outcome.reward_source).toBeNull()
    expect(restored!.outcome.verdict).toBeNull()
    expect(restored!.provenance.gap).toBe(HARBOR_IMPORT_GAP)
  })

  it('round-trips a null policy.harness through the placeholder ATIF requires', () => {
    const nulled = fixtureRolloutLine({
      policy: { ...original.policy, harness: null, harness_version: null },
    })
    const trajectory = toHarborTrajectory([nulled])
    expect(trajectory.agent.name).toBe('unknown')
    expect(trajectory.agent.version).toBe('0.0.0')
    const [back] = fromHarborTrajectory(trajectory, { now })
    expect(back!.policy.harness).toBeNull()
    expect(back!.policy.harness_version).toBeNull()
  })

  it('round-trips the ATIF-lifted step fields (logprobs, token ids, llm_call_count)', () => {
    const withMetrics = fixtureRolloutLine({
      steps: [
        {
          kind: 'llm',
          name: 'chat',
          llm_call_count: 1,
          prompt_token_ids: [1, 2, 3],
          completion_token_ids: [4, 5],
          logprobs: [-0.1, -1.25],
        },
      ],
      cost: { ...original.cost, llm_call_count: 3 },
    })
    const trajectory = toHarborTrajectory([withMetrics])
    // On the NATIVE ATIF channel, not only in the escrow: a field a foreign
    // consumer cannot see is not an interchange field. The first agent step is
    // steps[2] (system, user, agent, agent).
    expect(trajectory.steps[2]!.llm_call_count).toBe(1)
    expect(trajectory.steps[2]!.metrics).toEqual({
      prompt_token_ids: [1, 2, 3],
      completion_token_ids: [4, 5],
      logprobs: [-0.1, -1.25],
    })
    const [back] = fromHarborTrajectory(trajectory, { now })
    expect(back!.steps).toEqual(withMetrics.steps)
    expect(back!.cost.llm_call_count).toBe(3)
  })

  it('reads the four fields back off the native channel when there is no escrow', () => {
    // A Harbor-native producer: no `extra.tangle` anywhere. Before this was
    // wired, every logprob and token id in such a file was validated and dropped.
    const native: HarborTrajectory = {
      schema_version: ATIF_SCHEMA_VERSION,
      session_id: 'run-9',
      trajectory_id: 'traj-9',
      agent: { name: 'harbor-agent', version: '2.1.0' },
      steps: [
        { step_id: 1, source: 'user', message: 'go' },
        {
          step_id: 2,
          source: 'agent',
          model_name: 'gpt-x',
          message: 'done',
          llm_call_count: 2,
          metrics: {
            prompt_tokens: 10,
            prompt_token_ids: [11, 12],
            completion_token_ids: [13],
            logprobs: [-0.25],
          },
        },
        // No metrics at all → no span invented for it.
        { step_id: 3, source: 'agent', message: 'and again' },
      ],
    }
    const [line] = fromHarborTrajectory(native, { now })
    expect(line!.steps).toEqual([
      {
        kind: 'llm',
        name: 'gpt-x',
        llm_call_count: 2,
        prompt_token_ids: [11, 12],
        completion_token_ids: [13],
        logprobs: [-0.25],
      },
    ])
  })

  it('rejects malformed native metrics instead of importing them', () => {
    const bad: HarborTrajectory = {
      schema_version: ATIF_SCHEMA_VERSION,
      trajectory_id: 'traj-bad',
      agent: { name: 'a', version: '1' },
      steps: [
        {
          step_id: 1,
          source: 'agent',
          message: 'x',
          metrics: { prompt_token_ids: [1.5], logprobs: ['nope'] as never },
        },
      ],
    }
    // Not integers / not numbers → not carried, rather than carried and failing
    // validation deep inside a trainer.
    expect(fromHarborTrajectory(bad, { now })[0]!.steps).toBeUndefined()
  })

  it('round-trips an assistant turn whose content is null and whose arguments are malformed', () => {
    const malformed = fixtureRolloutLine({
      messages: [
        { role: 'user', content: 'go' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'c1', type: 'function', function: { name: 'read', arguments: '{"path": ' } },
          ],
        },
        { role: 'tool', tool_call_id: 'c1', content: null },
      ],
    })
    const trajectory = toHarborTrajectory([malformed])
    expect(trajectory.steps[1]!.tool_calls![0]!.arguments).toEqual({})
    const [back] = fromHarborTrajectory(trajectory, { now })
    expect(back!.messages).toEqual(malformed.messages)
  })

  it('round-trips a tool result that answers no assistant turn', () => {
    const orphan = fixtureRolloutLine({
      messages: [
        { role: 'tool', tool_call_id: 'c9', content: 'late result' },
        { role: 'assistant', content: 'done' },
      ],
    })
    const trajectory = toHarborTrajectory([orphan])
    // The carrier declares no calls, so it must state no source_call_id: the id
    // rides the escrow instead, and the link survives without an illegal claim.
    expect(trajectory.steps[0]!.observation!.results[0]!.source_call_id).toBeUndefined()
    expect(trajectory.steps[0]!.observation!.results[0]!.extra).toEqual({
      tangle: { source_call_id: 'c9' },
    })
    expect(ruleTwoViolations(trajectory)).toEqual([])
    const [back] = fromHarborTrajectory(trajectory, { now })
    expect(back!.messages).toEqual(orphan.messages)
  })

  it('is idempotent — a second round trip changes no byte', () => {
    const first = fromHarborTrajectory(toHarborTrajectory([original]), { now })
    const firstDocument = toHarborTrajectory(first)
    const second = fromHarborTrajectory(firstDocument, { now })
    expect(JSON.stringify(second)).toBe(JSON.stringify(first))
    expect(JSON.stringify(toHarborTrajectory(second))).toBe(JSON.stringify(firstDocument))
    // The specific regression: the gap note accreted one copy per pass.
    expect(first[0]!.provenance.gap).toBe(HARBOR_IMPORT_GAP)
    expect(second[0]!.provenance.gap).toBe(HARBOR_IMPORT_GAP)
  })

  it('is idempotent for a line that already carried a gap of its own', () => {
    const gap = fixtureRolloutLine({
      messages: [],
      provenance: { captured_at: CAPTURED_AT, capture: 'mint', gap: 'store unavailable' },
    })
    const first = fromHarborTrajectory(toHarborTrajectory([gap]), { now })
    const second = fromHarborTrajectory(toHarborTrajectory(first), { now })
    expect(first[0]!.provenance.gap).toBe(`store unavailable | ${HARBOR_IMPORT_GAP}`)
    expect(second[0]!.provenance.gap).toBe(first[0]!.provenance.gap)
    expect(JSON.stringify(second)).toBe(JSON.stringify(first))
  })

  it('round-trips a gap line, composing the missing-transcript and missing-label reasons', () => {
    const gap = fixtureRolloutLine({
      messages: [],
      provenance: { captured_at: CAPTURED_AT, capture: 'mint', gap: 'store unavailable' },
    })
    const trajectory = toHarborTrajectory([gap])
    expect(trajectory.steps).toEqual([])
    expect(trajectory.notes).toBe('store unavailable')
    const [back] = fromHarborTrajectory(trajectory, { now })
    expect(back!.messages).toEqual([])
    expect(back!.provenance.gap).toBe(`store unavailable | ${HARBOR_IMPORT_GAP}`)
  })

  it('flattens the embedded tree back to lines with parent edges, parent first', () => {
    const lines = episode()
    const back = fromHarborTrajectory(toHarborTrajectory(lines), { now })
    expect(back.map((l) => l.rollout_id)).toEqual(['sup-1', 'w-a', 'w-b'])
    expect(back.map((l) => l.parent_rollout_id)).toEqual([null, 'sup-1', 'sup-1'])
    expect(back.map((l) => l.messages.length)).toEqual([3, 5, 2])
    expect(back.every((l) => l.outcome.reward === null)).toBe(true)
  })
})

describe('ATIF MUST rule 2 — observations link by id, not by adjacency', () => {
  it('holds on the fixture and on the multi-agent episode', () => {
    expect(ruleTwoViolations(toHarborTrajectory([fixtureRolloutLine()]))).toEqual([])
    expect(ruleTwoViolations(toHarborTrajectory(episode()))).toEqual([])
  })

  it('does not hang a result on an assistant turn that declared no tool calls', () => {
    const line = fixtureRolloutLine({
      messages: [
        { role: 'assistant', content: 'no calls here' },
        { role: 'tool', tool_call_id: 'c1', content: 'result' },
      ],
    })
    const trajectory = toHarborTrajectory([line])
    expect(ruleTwoViolations(trajectory)).toEqual([])
    expect(trajectory.steps[0]!.observation).toBeUndefined()
    expect(trajectory.steps).toHaveLength(2)
    expect(fromHarborTrajectory(trajectory, { now })[0]!.messages).toEqual(line.messages)
  })

  it('does not hang a result on an assistant turn that declared a DIFFERENT call', () => {
    const line = fixtureRolloutLine({
      messages: [
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read', arguments: '{}' } }],
        },
        { role: 'tool', tool_call_id: 'c2', content: 'answers a call this step never made' },
      ],
    })
    const trajectory = toHarborTrajectory([line])
    expect(ruleTwoViolations(trajectory)).toEqual([])
    expect(trajectory.steps[0]!.observation).toBeUndefined()
    expect(fromHarborTrajectory(trajectory, { now })[0]!.messages).toEqual(line.messages)
  })

  it('links to the declaring step, not the preceding one, and keeps message order', () => {
    const line = fixtureRolloutLine({
      messages: [
        {
          role: 'assistant',
          content: 'calling',
          tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read', arguments: '{}' } }],
        },
        { role: 'assistant', content: 'still thinking' },
        { role: 'tool', tool_call_id: 'c1', content: 'late answer to c1' },
      ],
    })
    const trajectory = toHarborTrajectory([line])
    expect(ruleTwoViolations(trajectory)).toEqual([])
    // The intervening turn means the result cannot legally ride step 2, so it
    // becomes its own carrier rather than being mis-attributed.
    expect(trajectory.steps.map((s) => s.source)).toEqual(['agent', 'agent', 'system'])
    expect(fromHarborTrajectory(trajectory, { now })[0]!.messages).toEqual(line.messages)
  })

  it('folds several results onto the one step that declared all of them', () => {
    const line = fixtureRolloutLine({
      messages: [
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'c1', type: 'function', function: { name: 'read', arguments: '{}' } },
            { id: 'c2', type: 'function', function: { name: 'grep', arguments: '{}' } },
          ],
        },
        { role: 'tool', tool_call_id: 'c2', content: 'second first' },
        { role: 'tool', tool_call_id: 'c1', content: 'first second' },
      ],
    })
    const trajectory = toHarborTrajectory([line])
    expect(ruleTwoViolations(trajectory)).toEqual([])
    expect(trajectory.steps).toHaveLength(1)
    expect(trajectory.steps[0]!.observation!.results.map((r) => r.source_call_id)).toEqual([
      'c2',
      'c1',
    ])
    expect(fromHarborTrajectory(trajectory, { now })[0]!.messages).toEqual(line.messages)
  })
})

describe('ATIF is_copied_context — RFC 0001 rule 7', () => {
  const withCopied = fixtureRolloutLine({
    messages: [
      { role: 'system', content: 'You are a coding worker.' },
      { role: 'user', content: 'context pasted from the supervisor', is_copied_context: true },
      { role: 'assistant', content: 'my own work' },
    ],
  })

  it('travels on the native ATIF step field, both directions', () => {
    const trajectory = toHarborTrajectory([withCopied])
    expect(trajectory.steps.map((s) => s.is_copied_context)).toEqual([undefined, true, undefined])
    const [back] = fromHarborTrajectory(trajectory, { now })
    expect(back!.messages).toEqual(withCopied.messages)
  })

  it('survives on a tool result carried by an observation', () => {
    const line = fixtureRolloutLine({
      messages: [
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read', arguments: '{}' } }],
        },
        { role: 'tool', tool_call_id: 'c1', content: 'pasted', is_copied_context: true },
      ],
    })
    const [back] = fromHarborTrajectory(toHarborTrajectory([line]), { now })
    expect(back!.messages).toEqual(line.messages)
  })

  it('is excluded from the SFT export — the MUST the RFC actually states', () => {
    const [row] = toSftRows([withCopied])
    expect(row!.messages.map((m) => m.content)).toEqual(['You are a coding worker.', 'my own work'])
    expect(row!.messages.some((m) => m.is_copied_context === true)).toBe(false)
  })

  it('drops a line whose transcript is nothing but copied context', () => {
    const allCopied = fixtureRolloutLine({
      messages: [{ role: 'user', content: 'all borrowed', is_copied_context: true }],
    })
    expect(toSftRows([allCopied])).toEqual([])
  })
})

describe('ATIF escrowed split is a claim, not authority', () => {
  const claimsTrainable: HarborTrajectory = {
    schema_version: ATIF_SCHEMA_VERSION,
    trajectory_id: 'third-party-1',
    agent: { name: 'someone-else', version: '1.0.0' },
    steps: [{ step_id: 1, source: 'user', message: 'hand-written' }],
    // Namespaced, not authenticated: anyone can write this block.
    extra: {
      tangle: {
        task: { suite: 'swe-bench-verified', instance_id: 'astropy-1', split: 'search', rep: 2 },
      },
    },
  }

  it('imports a self-declared trainable split as holdout', () => {
    const [imported] = fromHarborTrajectory(claimsTrainable, { now })
    expect(imported!.task.split).toBe('holdout')
    // The rest of the escrowed task is still read — only trainability is refused.
    expect(imported!.task.suite).toBe('swe-bench-verified')
    expect(imported!.task.instance_id).toBe('astropy-1')
    expect(imported!.task.rep).toBe(2)
  })

  it('keeps the forged line out of the SFT export it was aimed at', () => {
    const [imported] = fromHarborTrajectory(claimsTrainable, { now })
    // Give it the one thing import refuses to: a positive reward. Even then the
    // forced split keeps it out — the escrow bought the attacker nothing.
    const scored = assertMinted(
      {
        ...imported,
        outcome: { ...imported!.outcome, reward: 1, reward_source: 'forged' },
      },
      'forged import',
    )
    expect(toSftRows([scored])).toEqual([])
  })

  it('re-labels only through the explicit, greppable step', () => {
    const [imported] = fromHarborTrajectory(claimsTrainable, { now })
    const [relabeled] = relabelImportedSplit([imported!], 'search')
    expect(relabeled!.task.split).toBe('search')
    expect(relabeled!.task.suite).toBe(imported!.task.suite)
    // The source line is not mutated by the re-label.
    expect(imported!.task.split).toBe('holdout')
    expect(() => relabelImportedSplit([imported!], 'production' as never)).toThrow(/unknown split/)
  })

  it('forces holdout on our OWN export too, not just a foreign one', () => {
    const ours = fixtureRolloutLine()
    expect(ours.task.split).toBe('search')
    const [back] = fromHarborTrajectory(toHarborTrajectory([ours]), { now })
    expect(back!.task.split).toBe('holdout')
  })
})

describe('ATIF import from a foreign producer', () => {
  const foreign: HarborTrajectory = {
    schema_version: ATIF_SCHEMA_VERSION,
    session_id: 'harbor-session-1',
    trajectory_id: 'harbor-traj-1',
    agent: { name: 'harbor-agent', version: '2.1.0', model_name: 'gpt-x' },
    steps: [
      { step_id: 1, source: 'user', message: [{ type: 'text', text: 'do the thing' }] },
      {
        step_id: 2,
        source: 'agent',
        message: 'on it',
        tool_calls: [{ tool_call_id: 't1', function_name: 'bash', arguments: { cmd: 'ls' } }],
        observation: { results: [{ source_call_id: 't1', content: 'a.txt' }] },
        metrics: { prompt_tokens: 10, completion_tokens: 4 },
      },
    ],
    final_metrics: { total_prompt_tokens: 10, total_completion_tokens: 4, total_cost_usd: 0.001 },
  }

  const [line] = fromHarborTrajectory(foreign, { now })

  it('mints a valid unlabeled line', () => {
    expect(validateRolloutLine(line)).toEqual([])
    expect(line!.outcome.reward).toBeNull()
    expect(line!.provenance.gap).toBe(HARBOR_IMPORT_GAP)
    expect(line!.provenance.captured_at).toBe(CAPTURED_AT)
  })

  it('lands on holdout — a trajectory with no split coordinate is never trainable', () => {
    expect(line!.task.split).toBe('holdout')
    expect(line!.task.suite).toBe('harbor-atif-import')
    expect(line!.task.instance_id).toBe('harbor-traj-1')
  })

  it('reads identity and policy from the ATIF-native fields when no escrow exists', () => {
    expect(line!.rollout_id).toBe('harbor-traj-1')
    expect(line!.run_id).toBe('harbor-session-1')
    expect(line!.policy).toEqual({
      harness: 'harbor-agent',
      harness_version: '2.1.0',
      model: 'gpt-x',
      provider: null,
      profile_commit: null,
      sampling: null,
    })
    expect(line!.cost.usd).toBe(0.001)
    expect(line!.cost.tokens_in).toBe(10)
    expect(line!.cost.wall_s).toBeNull()
  })

  it('flattens multimodal content to text and keeps the tool link', () => {
    expect(line!.messages).toEqual([
      { role: 'user', content: 'do the thing' },
      {
        role: 'assistant',
        content: 'on it',
        tool_calls: [
          { id: 't1', type: 'function', function: { name: 'bash', arguments: '{"cmd":"ls"}' } },
        ],
      },
      { role: 'tool', content: 'a.txt', tool_call_id: 't1' },
    ])
  })

  it('refuses a trajectory with no id rather than inventing one', () => {
    expect(() =>
      fromHarborTrajectory({ ...foreign, trajectory_id: undefined, session_id: undefined }),
    ).toThrow(/cannot mint a joinable rollout_id/)
  })
})

describe('schema back-compatibility for the ATIF-lifted optional fields', () => {
  it('validates a line that predates them', () => {
    expect(validateRolloutLine(fixtureRolloutLine())).toEqual([])
  })

  it('validates a line that carries them', () => {
    const line = fixtureRolloutLine({
      steps: [
        {
          kind: 'llm',
          name: 'chat',
          llm_call_count: 0,
          prompt_token_ids: [7],
          completion_token_ids: [8],
          logprobs: [-0.5],
        },
      ],
      cost: { ...fixtureRolloutLine().cost, llm_call_count: 2 },
    })
    expect(validateRolloutLine(line)).toEqual([])
  })

  it('rejects malformed values for them', () => {
    const bad = malformedRolloutLine({
      steps: [
        {
          kind: 'llm',
          name: 'chat',
          llm_call_count: 1.5,
          prompt_token_ids: [1.5],
          logprobs: ['x'],
        } as never,
      ],
      cost: { ...malformedRolloutLine().cost, llm_call_count: 'two' as never },
    })
    expect(validateRolloutLine(bad)).toEqual([
      'steps[0].llm_call_count: expected integer when present',
      'steps[0].prompt_token_ids: expected integer[] when present',
      'steps[0].logprobs: expected number[] when present',
      'cost.llm_call_count: expected integer|null when present',
    ])
  })

  it('validates and rejects the copied-context flag', () => {
    expect(
      validateRolloutLine(
        fixtureRolloutLine({
          messages: [{ role: 'user', content: 'pasted', is_copied_context: true }],
        }),
      ),
    ).toEqual([])
    expect(
      validateRolloutLine(
        malformedRolloutLine({
          messages: [{ role: 'user', content: 'pasted', is_copied_context: 'yes' as never }],
        }),
      ),
    ).toEqual(['messages[0].is_copied_context: must be boolean when present'])
  })
})

describe('package surface', () => {
  it('exports the interchange from the published /rollout subpath', async () => {
    // `import { toHarborTrajectory } from '@tangle-network/agent-eval/rollout'`
    // — the specifier external consumers use for every rollout symbol.
    const rollout = await import('../index')
    expect(typeof rollout.toHarborTrajectory).toBe('function')
    expect(typeof rollout.toHarborTrajectories).toBe('function')
    expect(typeof rollout.fromHarborTrajectory).toBe('function')
    expect(typeof rollout.relabelImportedSplit).toBe('function')
    expect(rollout.ATIF_SCHEMA_VERSION).toBe(ATIF_SCHEMA_VERSION)
    expect(rollout.HARBOR_IMPORT_GAP).toBe(HARBOR_IMPORT_GAP)
    // Same function object as the module's, not a re-implementation.
    expect(rollout.toHarborTrajectory).toBe(toHarborTrajectory)
  }, 60_000)
})
