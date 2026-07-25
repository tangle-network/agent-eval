/**
 * Harbor ATIF-v1.7 interchange — `tangle.rollout.v1` ⇄ Agent Trajectory
 * Interchange Format.
 *
 * ATIF is the portability format (spec:
 * https://www.harborframework.com/docs/agents/trajectory-format, normative
 * RFC: harbor-framework/harbor `rfcs/0001-trajectory-format.md`). It sits
 * BELOW the waist of the rollout hourglass in both directions — export reads
 * `RolloutLine[]`, import writes `RolloutLine[]` — and it is never a source
 * of training labels:
 *
 *   ATIF models NO reward, NO judge verdict, NO task/split coordinates.
 *
 * Consequences, both deliberate:
 *   - EXPORT drops `outcome.reward`, `outcome.reward_source` and
 *     `outcome.verdict` entirely. They are not smuggled into `extra`: a
 *     third-party reading our ATIF file must not be able to mistake an
 *     agent-eval judge score for something ATIF sanctioned.
 *   - IMPORT therefore mints UNLABELED lines: `reward: null` (the existing
 *     "null reward is a labeled gap, never 0" semantics), `verdict: null`,
 *     and a `provenance.gap` naming the missing label. An imported
 *     trajectory is not a training example until a judge scores it.
 *
 * Everything else we own that ATIF has no field for travels in a namespaced
 * escrow at `extra.tangle.*`, so our own round-trip is exact while a foreign
 * reader can ignore it. Fields that neither ATIF nor the escrow can carry
 * come back explicitly null / fail-closed, never invented.
 *
 * THE ESCROW IS NAMESPACED, NOT AUTHENTICATED. Anyone can write
 * `extra.tangle.*` into a file. So the escrow may restore what a value IS, but
 * never what a line is ALLOWED to do: `task.split` is forced to `holdout` on
 * every import regardless of what the document claims, and promoting an
 * imported trajectory to a trainable split is an explicit, greppable act
 * (`relabelImportedSplit`) rather than a property of the file. The document
 * keeps its claim — the claim just is not authority.
 *
 * Multi-agent shape differs on purpose. ATIF EMBEDS children in
 * `subagent_trajectories`; we keep a flat ledger with a normalized
 * `parent_rollout_id` edge. Export assembles the tree, import flattens it.
 * `session_id` is RUN-scoped in ATIF, so it carries `run_id` — the coordinate
 * that is shared by every invocation of one run — not `rollout_id`, which
 * identifies a single invocation and would split one run across session ids.
 *
 * ROUND-TRIPPING IS IDEMPOTENT: `import(export(import(export(x))))` is
 * byte-identical to `import(export(x))`. Import composes `provenance.gap` as a
 * de-duplicated ordered set rather than appending, and it emits every
 * `ChatMessage` with keys in the canonical schema order (role, content,
 * reasoning_content, tool_calls, tool_call_id, name, is_copied_context), so a
 * ledger hashed on serialized bytes sees no diff across further passes. The
 * FIRST import may re-order a producer's keys — that is the canonicalization.
 *
 * NOT building a Letta converter. Letta's trajectory-v1 is a strict subset of
 * what we need from ATIF here — no per-step or aggregate cost, no
 * multi-agent/subagent structure, no token-id or logprob channel — so a Letta
 * sink would carry less than this one and add a second format to keep
 * correct. Decision recorded in docs/rollout.md; do not re-litigate without a
 * concrete consumer that reads Letta and cannot read ATIF.
 */

import {
  assertRolloutLine,
  type ChatMessage,
  type ChatRole,
  type ChatToolCall,
  type GatedEvidence,
  ROLLOUT_CAPTURES,
  ROLLOUT_ROLES,
  ROLLOUT_SCHEMA,
  ROLLOUT_SPLITS,
  type RolloutArtifacts,
  type RolloutCapture,
  type RolloutCostBlock,
  type RolloutLine,
  type RolloutPolicy,
  type RolloutRole,
  type RolloutSplit,
  type RolloutStep,
  type RolloutTask,
  type ToolDef,
} from '../schema'

export const ATIF_SCHEMA_VERSION = 'ATIF-v1.7'

/** Gap note on every imported line — ATIF carries no verdict, so nothing is scored. */
export const HARBOR_IMPORT_GAP = 'imported from Harbor ATIF; no verdict'

/** Namespaced escrow key for everything ATIF does not model but we must not lose. */
const ESCROW = 'tangle'

/**
 * Marks a step we synthesized purely to hold tool results that answered no
 * assistant turn IN THIS DOCUMENT. ATIF has no `tool` source, so such results
 * need a carrier step; the marker lets import drop the carrier instead of
 * inventing a turn.
 *
 * A carrier's results carry NO `source_call_id`. RFC 0001 rule 2 requires every
 * `source_call_id` to match a `tool_call_id` in the same step's `tool_calls`,
 * and a carrier declares no calls (a `system` step cannot legally make one), so
 * emitting the id there would produce an invalid document. The id is escrowed
 * instead and restored verbatim on import — the link survives without the
 * document lying about who made the call.
 */
const TOOL_RESULTS_ONLY = 'tool-results-only'

// ---------------------------------------------------------------------------
// ATIF-v1.7 wire types (RFC 0001). Optional fields are optional here too.
// ---------------------------------------------------------------------------

export type HarborStepSource = 'system' | 'user' | 'agent'

export interface HarborImageSource {
  media_type: string
  path: string
}

export interface HarborContentPart {
  type: 'text' | 'image'
  text?: string
  source?: HarborImageSource
}

export interface HarborToolCall {
  tool_call_id: string
  function_name: string
  /** ATIF requires a decoded JSON object here, unlike our raw argument string. */
  arguments: Record<string, unknown>
  extra?: Record<string, unknown>
}

export interface HarborSubagentTrajectoryRef {
  trajectory_id?: string
  trajectory_path?: string
  /** Informational only since v1.7 — never a resolution key. */
  session_id?: string
  extra?: Record<string, unknown>
}

export interface HarborObservationResult {
  source_call_id?: string
  content?: string | HarborContentPart[]
  subagent_trajectory_ref?: HarborSubagentTrajectoryRef[]
  extra?: Record<string, unknown>
}

export interface HarborObservation {
  results: HarborObservationResult[]
}

export interface HarborMetrics {
  prompt_tokens?: number
  completion_tokens?: number
  cached_tokens?: number
  cost_usd?: number
  prompt_token_ids?: number[]
  completion_token_ids?: number[]
  logprobs?: number[]
  extra?: Record<string, unknown>
}

export interface HarborStep {
  /** Ordinal, sequential from 1. */
  step_id: number
  timestamp?: string
  source: HarborStepSource
  model_name?: string
  reasoning_effort?: string | number
  message: string | HarborContentPart[]
  reasoning_content?: string
  tool_calls?: HarborToolCall[]
  observation?: HarborObservation
  metrics?: HarborMetrics
  llm_call_count?: number
  is_copied_context?: boolean
  extra?: Record<string, unknown>
}

export interface HarborAgent {
  name: string
  version: string
  model_name?: string
  /** OpenAI function-calling schema — byte-identical to our `ToolDef`. */
  tool_definitions?: ToolDef[]
  extra?: Record<string, unknown>
}

export interface HarborFinalMetrics {
  total_prompt_tokens?: number
  total_completion_tokens?: number
  total_cached_tokens?: number
  total_cost_usd?: number
  total_steps?: number
  extra?: Record<string, unknown>
}

export interface HarborTrajectory {
  schema_version: string
  session_id?: string
  /** Required on embedded subagents; we always set it so lines stay joinable. */
  trajectory_id?: string
  agent: HarborAgent
  steps: HarborStep[]
  notes?: string
  final_metrics?: HarborFinalMetrics
  continued_trajectory_ref?: string
  subagent_trajectories?: HarborTrajectory[]
  extra?: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const asString = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

const asNumberOrNull = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null

const asIntegerOrUndefined = (v: unknown): number | undefined =>
  Number.isInteger(v) ? (v as number) : undefined

const asNumberArray = (v: unknown): number[] | undefined =>
  Array.isArray(v) && v.every((n) => typeof n === 'number' && Number.isFinite(n))
    ? (v as number[])
    : undefined

const asIntegerArray = (v: unknown): number[] | undefined =>
  Array.isArray(v) && v.every((n) => Number.isInteger(n)) ? (v as number[]) : undefined

/**
 * Builds a `ChatMessage` with keys in the schema's declaration order.
 *
 * Object key order is insertion order in JS, so a message assembled
 * conditionally field-by-field serializes differently depending on which
 * optional fields were present — which makes a byte-hashed ledger see a diff
 * across an import that changed nothing. One builder, one order, stable bytes.
 */
function canonicalChatMessage(parts: {
  role: ChatRole
  content: string | null
  reasoning_content?: string
  tool_calls?: ChatToolCall[]
  tool_call_id?: string
  name?: string
  is_copied_context?: boolean
}): ChatMessage {
  const message: ChatMessage = { role: parts.role, content: parts.content }
  if (parts.reasoning_content !== undefined) message.reasoning_content = parts.reasoning_content
  if (parts.tool_calls !== undefined) message.tool_calls = parts.tool_calls
  if (parts.tool_call_id !== undefined) message.tool_call_id = parts.tool_call_id
  if (parts.name !== undefined) message.name = parts.name
  if (parts.is_copied_context === true) message.is_copied_context = true
  return message
}

/** Reads the `extra.tangle` escrow, tolerating a foreign file that has none. */
function escrowOf(extra: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!isRecord(extra)) return undefined
  const value = extra[ESCROW]
  return isRecord(value) ? value : undefined
}

function escrowSection(
  escrow: Record<string, unknown> | undefined,
  key: string,
): Record<string, unknown> | undefined {
  if (escrow === undefined) return undefined
  const value = escrow[key]
  return isRecord(value) ? value : undefined
}

// ---------------------------------------------------------------------------
// Export: RolloutLine[] → ATIF trajectory tree
// ---------------------------------------------------------------------------

function toHarborToolCall(call: ChatToolCall): HarborToolCall {
  // ATIF requires `arguments` to be a JSON object; ours is the raw
  // JSON-encoded string the model emitted, and models really do emit
  // malformed ones. Keep the exact bytes in `extra` so import restores the
  // string verbatim instead of re-serializing a normalized parse.
  let parsed: Record<string, unknown> | undefined
  try {
    const decoded: unknown = JSON.parse(call.function.arguments)
    if (isRecord(decoded)) parsed = decoded
  } catch {
    parsed = undefined
  }
  return {
    tool_call_id: call.id,
    function_name: call.function.name,
    arguments: parsed ?? {},
    extra: { [ESCROW]: { arguments_raw: call.function.arguments } },
  }
}

/**
 * `linked` = this result is attached to the step that actually declared the
 * call, so `source_call_id` is legal (RFC 0001 rule 2). When it is not, the id
 * goes to escrow instead of onto the wire.
 */
function toObservationResult(message: ChatMessage, linked: boolean): HarborObservationResult {
  const result: HarborObservationResult = {}
  if (linked && message.tool_call_id !== undefined) result.source_call_id = message.tool_call_id
  if (message.content !== null) result.content = message.content
  const escrow: Record<string, unknown> = {}
  if (!linked && message.tool_call_id !== undefined) escrow.source_call_id = message.tool_call_id
  if (message.name !== undefined) escrow.name = message.name
  // `content: null` on a tool turn is meaningful (a tool that returned
  // nothing) and is not the same as the empty string ATIF would round-trip it to.
  if (message.content === null) escrow.content_null = true
  if (message.reasoning_content !== undefined) escrow.reasoning_content = message.reasoning_content
  if (message.is_copied_context === true) escrow.is_copied_context = true
  if (Object.keys(escrow).length > 0) result.extra = { [ESCROW]: escrow }
  return result
}

/** True when `step` is the agent turn that declared `callId` — the rule-2 test. */
function declaresCall(step: HarborStep, callId: string | undefined): boolean {
  if (callId === undefined) return false
  return step.tool_calls?.some((call) => call.tool_call_id === callId) === true
}

/**
 * Attaches the four RL fields lifted from ATIF onto the agent step the span
 * describes. They are ALSO escrowed with the whole span under `extra.tangle`,
 * on purpose: the escrow is how our own round-trip stays exact, and these
 * native fields are how a foreign consumer — which never reads our escrow —
 * gets the logprobs and token ids at all. A field carried only in the escrow is
 * not an interchange field.
 */
function applySpanMetrics(step: HarborStep, span: RolloutStep | undefined): void {
  if (span === undefined) return
  if (span.llm_call_count !== undefined) step.llm_call_count = span.llm_call_count
  const metrics: HarborMetrics = {}
  if (span.prompt_token_ids !== undefined) metrics.prompt_token_ids = span.prompt_token_ids
  if (span.completion_token_ids !== undefined) {
    metrics.completion_token_ids = span.completion_token_ids
  }
  if (span.logprobs !== undefined) metrics.logprobs = span.logprobs
  if (Object.keys(metrics).length > 0) step.metrics = metrics
}

/**
 * Coalescing fold, not a 1:1 map: ATIF has no `tool` source, so a tool result
 * becomes an `observation.results[]` entry on the agent step THAT DECLARED ITS
 * `tool_call_id`.
 *
 * Linking by id, not by adjacency. Adjacency emitted invalid documents in three
 * shapes the RFC forbids — an assistant turn with no `tool_calls` swallowing the
 * results that followed it, a result whose id matched none of the preceding
 * step's calls, and an unanswered result riding a `system` step that carried a
 * `source_call_id` it could never declare. Attaching only to the step that owns
 * the id also preserves message order exactly: a result either joins the step
 * immediately before it or becomes its own carrier at its own position.
 *
 * `line.steps` span projections are matched to agent steps in order (k-th llm
 * span → k-th agent step) purely to fill ATIF's native per-step `metrics`;
 * extra spans on either side are simply not matched, never invented.
 */
function messagesToSteps(line: RolloutLine): HarborStep[] {
  const steps: HarborStep[] = []
  const llmSpans = (line.steps ?? []).filter((span) => span.kind === 'llm')
  let nextSpan = 0
  for (const message of line.messages) {
    if (message.role === 'tool') {
      const previous = steps[steps.length - 1]
      if (previous !== undefined && declaresCall(previous, message.tool_call_id)) {
        if (previous.observation === undefined) previous.observation = { results: [] }
        previous.observation.results.push(toObservationResult(message, true))
        continue
      }
      // A tool result answering no assistant turn in this document (truncated or
      // reconstructed transcript). It still has to survive, so it rides a marked
      // carrier step whose observation states no call id.
      const carrier: HarborStep = {
        step_id: steps.length + 1,
        source: 'system',
        message: '',
        observation: { results: [toObservationResult(message, false)] },
        extra: { [ESCROW]: { synthetic: TOOL_RESULTS_ONLY } },
      }
      if (message.is_copied_context === true) carrier.is_copied_context = true
      steps.push(carrier)
      continue
    }
    const step: HarborStep = {
      step_id: steps.length + 1,
      source: message.role === 'assistant' ? 'agent' : message.role,
      message: message.content ?? '',
    }
    const escrow: Record<string, unknown> = {}
    if (message.content === null) escrow.content_null = true
    if (message.name !== undefined) escrow.name = message.name
    if (message.role === 'assistant') {
      if (line.policy.model !== null) step.model_name = line.policy.model
      if (message.reasoning_content !== undefined) {
        step.reasoning_content = message.reasoning_content
      }
      if (message.tool_calls !== undefined && message.tool_calls.length > 0) {
        step.tool_calls = message.tool_calls.map(toHarborToolCall)
      }
      applySpanMetrics(step, llmSpans[nextSpan])
      nextSpan += 1
    } else if (message.reasoning_content !== undefined) {
      // ATIF confines `reasoning_content` to agent steps; ours is not confined.
      escrow.reasoning_content = message.reasoning_content
    }
    // RFC 0001 rule 7: a copied-context turn was not authored by this agent, and
    // an SFT pipeline MUST exclude it. Native ATIF field, both directions.
    if (message.is_copied_context === true) step.is_copied_context = true
    if (Object.keys(escrow).length > 0) step.extra = { [ESCROW]: escrow }
    steps.push(step)
  }
  return steps
}

function finalMetricsOf(line: RolloutLine, stepCount: number): HarborFinalMetrics {
  const metrics: HarborFinalMetrics = {}
  if (line.cost.tokens_in !== null) metrics.total_prompt_tokens = line.cost.tokens_in
  if (line.cost.tokens_out !== null) metrics.total_completion_tokens = line.cost.tokens_out
  if (line.cost.cache_read !== null) metrics.total_cached_tokens = line.cost.cache_read
  // Omitted, never 0, when cost was not captured — a fake 0 is a lie about spend.
  if (line.cost.usd !== null) metrics.total_cost_usd = line.cost.usd
  metrics.total_steps = stepCount
  // ATIF has no aggregate field for these three; `reasoning_tokens` under
  // `extra` is the key the RFC's own worked example uses.
  const extra: Record<string, unknown> = {}
  if (line.cost.tokens_reasoning !== null) extra.reasoning_tokens = line.cost.tokens_reasoning
  if (line.cost.cache_write !== null) extra.cache_write_tokens = line.cost.cache_write
  if (line.cost.wall_s !== null) extra.wall_s = line.cost.wall_s
  if (line.cost.llm_call_count !== undefined && line.cost.llm_call_count !== null) {
    extra.llm_call_count = line.cost.llm_call_count
  }
  if (Object.keys(extra).length > 0) metrics.extra = extra
  return metrics
}

function notesOf(line: RolloutLine): string | undefined {
  const parts: string[] = []
  if (line.provenance.gap !== undefined) parts.push(line.provenance.gap)
  if (line.outcome.realness_gated === true) {
    // ATIF has no gate field. A third-party consumer that ignores `extra`
    // would otherwise see a gamed trajectory with nothing marking it, so the
    // flag is stated in prose as well. This export carries no reward at all,
    // so it is not a training-data door — but it is an audit record.
    parts.push('realness-gated: this run faked its success signal (anti-Goodhart gate fired)')
  }
  return parts.length > 0 ? parts.join(' | ') : undefined
}

function toTrajectoryNode(line: RolloutLine): HarborTrajectory {
  const steps = messagesToSteps(line)
  const trajectory: HarborTrajectory = {
    schema_version: ATIF_SCHEMA_VERSION,
    // RUN-scoped, per the spec — so it is `run_id`, the coordinate every
    // invocation of one run shares. `rollout_id` identifies a single
    // invocation: using it gave two roots of the same run different session
    // ids, and foreign tooling that groups by session_id would split the run.
    session_id: line.run_id,
    trajectory_id: line.rollout_id,
    agent: {
      // ATIF requires both; ours are nullable, so a null is substituted here
      // and restored on import from the escrowed policy — never guessed back.
      name: line.policy.harness ?? 'unknown',
      version: line.policy.harness_version ?? '0.0.0',
      ...(line.policy.model !== null ? { model_name: line.policy.model } : {}),
      ...(line.tool_defs.length > 0 ? { tool_definitions: line.tool_defs } : {}),
    },
    steps,
    final_metrics: finalMetricsOf(line, steps.length),
    extra: {
      [ESCROW]: {
        schema: line.schema,
        rollout_id: line.rollout_id,
        parent_rollout_id: line.parent_rollout_id,
        run_id: line.run_id,
        ...(line.experiment_id !== undefined ? { experiment_id: line.experiment_id } : {}),
        ...(line.candidate_id !== undefined ? { candidate_id: line.candidate_id } : {}),
        generation: line.generation,
        candidate_index: line.candidate_index,
        role: line.role,
        task: line.task,
        policy: line.policy,
        // Span projections overlap the same turns as `steps[]`; folding them
        // into ATIF steps would double-count the run, so they stay escrowed.
        ...(line.steps !== undefined ? { spans: line.steps } : {}),
        outcome: {
          // reward / reward_source / verdict are deliberately absent — see the
          // module header. Only the non-scalar outcome fields travel.
          metrics: line.outcome.metrics,
          is_completed: line.outcome.is_completed,
          is_truncated: line.outcome.is_truncated,
          error: line.outcome.error,
          ...(line.outcome.realness_gated !== undefined
            ? { realness_gated: line.outcome.realness_gated }
            : {}),
        },
        artifacts: line.artifacts,
        provenance: line.provenance,
      },
    },
  }
  const notes = notesOf(line)
  if (notes !== undefined) trajectory.notes = notes
  return trajectory
}

interface Forest {
  roots: RolloutLine[]
  childrenOf: Map<string, RolloutLine[]>
}

function buildForest(lines: RolloutLine[]): Forest {
  const byId = new Map<string, RolloutLine>()
  for (const line of lines) {
    if (byId.has(line.rollout_id)) {
      throw new Error(`duplicate rollout_id in input: ${line.rollout_id}`)
    }
    byId.set(line.rollout_id, line)
  }
  const roots: RolloutLine[] = []
  const childrenOf = new Map<string, RolloutLine[]>()
  for (const line of lines) {
    const parent = line.parent_rollout_id
    // A parent outside this set is a root OF WHAT WE HAVE: the edge is kept in
    // escrow so a later import restores the dangling pointer instead of nulling it.
    if (parent === null || !byId.has(parent)) {
      roots.push(line)
      continue
    }
    const siblings = childrenOf.get(parent)
    if (siblings === undefined) childrenOf.set(parent, [line])
    else siblings.push(line)
  }
  // Every line has a parent inside the set: the edges form a cycle with no
  // root. Returning zero documents would drop the whole episode silently.
  if (lines.length > 0 && roots.length === 0) {
    throw new Error(
      `parent_rollout_id cycle: no root among ${lines.length} lines (${lines.map((l) => l.rollout_id).join(', ')})`,
    )
  }
  return { roots, childrenOf }
}

function assemble(line: RolloutLine, forest: Forest, onPath: Set<string>): HarborTrajectory {
  if (onPath.has(line.rollout_id)) {
    throw new Error(`parent_rollout_id cycle through rollout_id ${line.rollout_id}`)
  }
  onPath.add(line.rollout_id)
  const node = toTrajectoryNode(line)
  const children = forest.childrenOf.get(line.rollout_id)
  if (children !== undefined && children.length > 0) {
    node.subagent_trajectories = children.map((child) => assemble(child, forest, onPath))
  }
  onPath.delete(line.rollout_id)
  return node
}

/**
 * Assemble one episode's flat lines into a single ATIF trajectory tree,
 * linked by `parent_rollout_id`.
 *
 * Reward, verdict and split are NOT emitted (ATIF models none of them); the
 * split and the rest of the task coordinates survive only in `extra.tangle`.
 *
 * We deliberately do NOT synthesize an `observation.subagent_trajectory_ref`
 * pointing at each child: our ledger records WHICH invocation spawned a
 * worker, not which STEP did, and attaching the ref to a guessed step would
 * fabricate a causal claim. Children are embedded in `subagent_trajectories`
 * (each with the `trajectory_id` the spec requires) and the edge is stated in
 * the child's escrowed `parent_rollout_id`.
 *
 * Throws when the lines are not one tree — use `toHarborTrajectories` for a forest.
 */
export function toHarborTrajectory(lines: RolloutLine[]): HarborTrajectory {
  const trees = toHarborTrajectories(lines)
  if (trees.length === 0) throw new Error('toHarborTrajectory: no lines')
  if (trees.length > 1) {
    const ids = trees.map((t) => t.trajectory_id ?? '?').join(', ')
    throw new Error(
      `toHarborTrajectory: ${trees.length} roots (${ids}) — ATIF is one tree per document; use toHarborTrajectories`,
    )
  }
  return trees[0]!
}

/** Every independent tree in the input, one ATIF document each. */
export function toHarborTrajectories(lines: RolloutLine[]): HarborTrajectory[] {
  const forest = buildForest(lines)
  return forest.roots.map((root) => assemble(root, forest, new Set()))
}

// ---------------------------------------------------------------------------
// Import: ATIF trajectory tree → RolloutLine[]
// ---------------------------------------------------------------------------

function contentToString(message: string | HarborContentPart[]): string {
  if (typeof message === 'string') return message
  return message
    .map((part) =>
      part.type === 'image'
        ? // Our chat content is text-only. Describing the image is honest about
          // what the source held; dropping it silently would not be.
          `[image ${part.source?.media_type ?? 'unknown'} ${part.source?.path ?? ''}]`.trim()
        : (part.text ?? ''),
    )
    .join('\n')
}

function fromHarborToolCall(call: HarborToolCall): ChatToolCall {
  const raw = asString(escrowOf(call.extra)?.arguments_raw)
  return {
    id: call.tool_call_id,
    type: 'function',
    function: { name: call.function_name, arguments: raw ?? JSON.stringify(call.arguments ?? {}) },
  }
}

function fromObservationResult(
  result: HarborObservationResult,
  callId: string | undefined,
): ChatMessage {
  const escrow = escrowOf(result.extra)
  return canonicalChatMessage({
    role: 'tool',
    content:
      escrow?.content_null === true
        ? null
        : result.content === undefined
          ? ''
          : contentToString(result.content),
    reasoning_content: asString(escrow?.reasoning_content),
    tool_call_id: callId,
    name: asString(escrow?.name),
    is_copied_context: escrow?.is_copied_context === true,
  })
}

function stepsToMessages(steps: HarborStep[]): ChatMessage[] {
  const messages: ChatMessage[] = []
  for (const step of steps) {
    const escrow = escrowOf(step.extra)
    const carrierOnly = escrow?.synthetic === TOOL_RESULTS_ONLY
    if (!carrierOnly) {
      messages.push(
        canonicalChatMessage({
          role: step.source === 'agent' ? 'assistant' : step.source,
          content: escrow?.content_null === true ? null : contentToString(step.message),
          reasoning_content: step.reasoning_content ?? asString(escrow?.reasoning_content),
          tool_calls:
            step.tool_calls !== undefined && step.tool_calls.length > 0
              ? step.tool_calls.map(fromHarborToolCall)
              : undefined,
          name: asString(escrow?.name),
          is_copied_context: step.is_copied_context === true,
        }),
      )
    }
    for (const result of step.observation?.results ?? []) {
      const resultEscrow = escrowOf(result.extra)
      const callId = result.source_call_id ?? asString(resultEscrow?.source_call_id)
      if (carrierOnly) {
        // Our own carrier: every result on it was a tool turn, and its call id
        // (if the transcript had one) is in escrow, not on the wire.
        messages.push(fromObservationResult(result, callId))
        continue
      }
      if (typeof callId === 'string') {
        messages.push(fromObservationResult(result, callId))
        continue
      }
      // ATIF allows a result from a non-tool-calling action. Our chat schema
      // requires `tool_call_id` on a tool turn, so inventing one would forge a
      // link; the text is preserved as a system observation instead.
      if (result.content !== undefined) {
        messages.push(
          canonicalChatMessage({ role: 'system', content: contentToString(result.content) }),
        )
      }
    }
  }
  return messages
}

function taskFrom(escrow: Record<string, unknown> | undefined, fallbackId: string): RolloutTask {
  const task = escrowSection(escrow, 'task')
  return {
    suite: asString(task?.suite) ?? 'harbor-atif-import',
    instance_id: asString(task?.instance_id) ?? fallbackId,
    // ALWAYS holdout — the escrowed claim is read for nothing here.
    //
    // `extra.tangle.task.split` is a namespaced key, not an authenticated one:
    // a hand-written or third-party document can set `split: 'search'` as
    // easily as our own exporter can, and honouring it made "this file says so"
    // sufficient to walk into a training export. Trainability is a decision
    // about a file, so it is made by an operator through
    // `relabelImportedSplit`, never by the file about itself. The claim is not
    // destroyed — it stays readable in the source document.
    split: 'holdout',
    seed: asNumberOrNull(task?.seed),
    rep: asIntegerOrUndefined(task?.rep) ?? 0,
  }
}

function policyFrom(
  escrow: Record<string, unknown> | undefined,
  agent: HarborAgent,
): RolloutPolicy {
  const escrowed = escrowSection(escrow, 'policy')
  if (escrowed !== undefined) {
    // Our own export: restore verbatim, including the nulls ATIF forced us to
    // substitute placeholders for in `agent.name` / `agent.version`.
    return {
      harness: asString(escrowed.harness) ?? null,
      harness_version: asString(escrowed.harness_version) ?? null,
      model: asString(escrowed.model) ?? null,
      provider: asString(escrowed.provider) ?? null,
      profile_commit: asString(escrowed.profile_commit) ?? null,
      ...(escrowed.prompt_hash !== undefined
        ? { prompt_hash: asString(escrowed.prompt_hash) ?? null }
        : {}),
      ...(escrowed.config_hash !== undefined
        ? { config_hash: asString(escrowed.config_hash) ?? null }
        : {}),
      ...(escrowed.agent_profile_cell_id !== undefined
        ? { agent_profile_cell_id: asString(escrowed.agent_profile_cell_id) ?? null }
        : {}),
      sampling: isRecord(escrowed.sampling) ? escrowed.sampling : null,
    }
  }
  return {
    harness: agent.name,
    harness_version: agent.version,
    model: agent.model_name ?? null,
    provider: null,
    profile_commit: null,
    sampling: null,
  }
}

function artifactsFrom(escrow: Record<string, unknown> | undefined): RolloutArtifacts {
  const artifacts = escrowSection(escrow, 'artifacts')
  return {
    patch_path: asString(artifacts?.patch_path) ?? null,
    run_dir: asString(artifacts?.run_dir) ?? null,
    transcript_ref: asString(artifacts?.transcript_ref) ?? null,
  }
}

function costFrom(final: HarborFinalMetrics | undefined): RolloutCostBlock {
  const rawExtra = final?.extra
  const extra = isRecord(rawExtra) ? rawExtra : undefined
  const calls = asIntegerOrUndefined(extra?.llm_call_count)
  return {
    usd: asNumberOrNull(final?.total_cost_usd),
    tokens_in: asNumberOrNull(final?.total_prompt_tokens),
    tokens_out: asNumberOrNull(final?.total_completion_tokens),
    tokens_reasoning: asNumberOrNull(extra?.reasoning_tokens),
    cache_read: asNumberOrNull(final?.total_cached_tokens),
    cache_write: asNumberOrNull(extra?.cache_write_tokens),
    wall_s: asNumberOrNull(extra?.wall_s),
    ...(calls !== undefined ? { llm_call_count: calls } : {}),
  }
}

/**
 * Recovers span projections from ATIF's NATIVE per-step channel, for documents
 * with no `extra.tangle.spans` escrow — i.e. everything a foreign producer
 * writes. Without this the logprobs and token ids a Harbor-native trainer
 * records would be read, validated, and then dropped on the floor.
 *
 * Only steps that actually carry one of the four fields produce a span: an
 * agent step with no metrics means "not captured", and inventing an empty span
 * for it would claim the run had a shape we did not observe.
 */
function spansFromSteps(steps: HarborStep[]): RolloutStep[] {
  const spans: RolloutStep[] = []
  for (const step of steps) {
    if (step.source !== 'agent') continue
    const calls = asIntegerOrUndefined(step.llm_call_count)
    const promptIds = asIntegerArray(step.metrics?.prompt_token_ids)
    const completionIds = asIntegerArray(step.metrics?.completion_token_ids)
    const logprobs = asNumberArray(step.metrics?.logprobs)
    if (
      calls === undefined &&
      promptIds === undefined &&
      completionIds === undefined &&
      logprobs === undefined
    ) {
      continue
    }
    spans.push({
      kind: 'llm',
      name: step.model_name ?? 'chat',
      ...(calls !== undefined ? { llm_call_count: calls } : {}),
      ...(promptIds !== undefined ? { prompt_token_ids: promptIds } : {}),
      ...(completionIds !== undefined ? { completion_token_ids: completionIds } : {}),
      ...(logprobs !== undefined ? { logprobs } : {}),
    })
  }
  return spans
}

/**
 * Composes `provenance.gap` as an ordered SET of reasons.
 *
 * Appending made the note accrete on every pass ("…no verdict | …no verdict"),
 * which both grows without bound and breaks byte-level idempotency for a ledger
 * hashed on its serialized lines.
 */
function composeGap(escrowedGap: string | undefined, added: readonly string[]): string {
  const parts: string[] = []
  const seen = new Set<string>()
  for (const raw of [...(escrowedGap?.split(' | ') ?? []), ...added]) {
    const reason = raw.trim()
    if (reason.length === 0 || seen.has(reason)) continue
    seen.add(reason)
    parts.push(reason)
  }
  return parts.join(' | ')
}

export interface FromHarborOptions {
  /** Injected clock for deterministic output when the source carries no capture time. */
  now?: () => Date
}

function nodeToLine(
  trajectory: HarborTrajectory,
  parentId: string | null,
  capturedAt: string,
): RolloutLine {
  const escrow = escrowOf(trajectory.extra)
  const rolloutId =
    asString(escrow?.rollout_id) ?? trajectory.trajectory_id ?? trajectory.session_id
  if (rolloutId === undefined || rolloutId.length === 0) {
    throw new Error(
      'fromHarborTrajectory: trajectory has no trajectory_id or session_id — cannot mint a joinable rollout_id without inventing one',
    )
  }
  const outcome = escrowSection(escrow, 'outcome')
  const provenance = escrowSection(escrow, 'provenance')
  const capture = provenance?.capture
  const escrowedGap = asString(provenance?.gap)
  const role = escrow?.role
  const escrowedSpans = escrow?.spans
  // The escrow wins when it exists (our own export: exact, including an empty
  // array, which claims "captured, none" rather than "not captured"), and the
  // native per-step channel is the fallback (a foreign export: still signal).
  const nativeSpans = spansFromSteps(trajectory.steps)
  const spans: RolloutStep[] | undefined = Array.isArray(escrowedSpans)
    ? (escrowedSpans as RolloutStep[])
    : nativeSpans.length > 0
      ? nativeSpans
      : undefined
  const messages = stepsToMessages(trajectory.steps)
  const line: RolloutLine = {
    schema: ROLLOUT_SCHEMA,
    rollout_id: rolloutId,
    // The tree edge wins for embedded children; for a root, the escrowed
    // pointer may reference a line outside this document and is preserved.
    parent_rollout_id: parentId ?? asString(escrow?.parent_rollout_id) ?? null,
    run_id: asString(escrow?.run_id) ?? trajectory.session_id ?? rolloutId,
    // Required keys on the wire (0.127.0): a foreign document that never
    // stated them imports as explicit `null`, not as an absent field.
    experiment_id: asString(escrow?.experiment_id) ?? null,
    candidate_id: asString(escrow?.candidate_id) ?? null,
    generation: asIntegerOrUndefined(escrow?.generation) ?? null,
    candidate_index: asIntegerOrUndefined(escrow?.candidate_index) ?? null,
    role: ROLLOUT_ROLES.includes(role as RolloutRole) ? (role as RolloutRole) : 'agent',
    task: taskFrom(escrow, rolloutId),
    policy: policyFrom(escrow, trajectory.agent),
    messages,
    tool_defs: trajectory.agent.tool_definitions ?? [],
    ...(spans !== undefined ? { steps: spans } : {}),
    outcome: {
      // ATIF carries no label. Null is the labeled gap; a 0 here would be a
      // fabricated failure and a 1 a fabricated success.
      reward: null,
      reward_source: null,
      verdict: null,
      metrics: isRecord(outcome?.metrics) ? outcome.metrics : {},
      is_completed: typeof outcome?.is_completed === 'boolean' ? outcome.is_completed : true,
      is_truncated:
        typeof outcome?.is_truncated === 'boolean'
          ? outcome.is_truncated
          : trajectory.continued_trajectory_ref !== undefined,
      error: asString(outcome?.error) ?? null,
      // The anti-Goodhart flag is restored when the source document stated
      // it; the wire schema requires the field, so a document that never did
      // imports as `false`. That is safe here because the reward is already
      // forced to `null` (not trainable) and `realness_screened` stays
      // absent = unknown rather than claiming a screen ran.
      realness_gated: outcome?.realness_gated === true,
    },
    cost: costFrom(trajectory.final_metrics),
    artifacts: artifactsFrom(escrow),
    provenance: {
      captured_at: asString(provenance?.captured_at) ?? capturedAt,
      capture: ROLLOUT_CAPTURES.includes(capture as RolloutCapture)
        ? (capture as RolloutCapture)
        : 'backfill',
      gap: composeGap(escrowedGap, [HARBOR_IMPORT_GAP]),
      // Restored for the same reason `realness_gated` is, and with the opposite
      // risk profile from the reward: this is the gated run's own measurement
      // bag, moved off `outcome` by `gateGamedOutcome` so no exporter reads it
      // as training input. Dropping it here would silently destroy the audit
      // trail that says WHY the run was flagged and what it claimed, on the one
      // population an auditor most wants to inspect. It cannot be fail-open —
      // nothing projects `provenance` into a training row.
      ...(isRecord(provenance?.gated_evidence)
        ? { gated_evidence: provenance.gated_evidence as GatedEvidence }
        : {}),
    },
  }
  assertRolloutLine(line, `rollout line imported from ATIF trajectory ${rolloutId}`)
  return line
}

/**
 * Flatten an ATIF trajectory tree back into `tangle.rollout.v1` lines, parent
 * first, each child carrying `parent_rollout_id`.
 *
 * Every line comes back UNLABELED: `reward`, `reward_source` and `verdict` are
 * null and `provenance.gap` says why. ATIF models no verdict, so scoring an
 * imported trajectory is a judge's job, not this function's. Every line lands
 * on `holdout` whatever the document claims — see `relabelImportedSplit`.
 */
export function fromHarborTrajectory(
  trajectory: HarborTrajectory,
  options: FromHarborOptions = {},
): RolloutLine[] {
  const capturedAt = (options.now?.() ?? new Date()).toISOString()
  const lines: RolloutLine[] = []
  const walk = (node: HarborTrajectory, parentId: string | null, onPath: Set<string>): void => {
    const line = nodeToLine(node, parentId, capturedAt)
    if (onPath.has(line.rollout_id)) {
      throw new Error(`subagent_trajectories cycle through trajectory_id ${line.rollout_id}`)
    }
    onPath.add(line.rollout_id)
    lines.push(line)
    for (const child of node.subagent_trajectories ?? []) {
      walk(child, line.rollout_id, onPath)
    }
    onPath.delete(line.rollout_id)
  }
  walk(trajectory, null, new Set())
  return lines
}

/**
 * THE explicit door out of `holdout` for imported lines.
 *
 * Import forces `holdout` because a document's own claim about its split is not
 * evidence — anyone can write `extra.tangle.task.split`. Promoting a file to a
 * trainable split is an operator's decision about provenance they verified, so
 * it is a separate, greppable call: `grep relabelImportedSplit` enumerates
 * every place foreign data was declared trainable, which is exactly the audit
 * the trusted-escrow version made impossible.
 *
 * Returns plain `RolloutLine`s. They still have to pass `assertMinted` (and its
 * anti-Goodhart check) to reach an exporter — re-labeling a split is not
 * minting a reward.
 */
export function relabelImportedSplit(
  lines: readonly RolloutLine[],
  split: RolloutSplit,
): RolloutLine[] {
  if (!ROLLOUT_SPLITS.includes(split)) {
    throw new Error(`relabelImportedSplit: unknown split ${String(split)}`)
  }
  return lines.map((line) => ({ ...line, task: { ...line.task, split } }))
}
