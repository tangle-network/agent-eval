/**
 * `tangle.rollout.v1` — THE canonical rollout serialization, owned by
 * agent-eval. One JSONL line per agent invocation (a solo eval run, a
 * supervisor episode, a worker session, a proposer shot, a judge call, an
 * analyst pass), labeled with its task/split coordinates and a single
 * scalar reward, carrying the FULL message transcript inline.
 *
 * This schema is the reconciliation of two prior producers:
 *   - agent-eval's RunRecord-joined rollout rows (PR #410): identity,
 *     provenance hashes, the realness gate travelling into the reward,
 *     trace-derived steps.
 *   - the bench rollout-ledger (agent-runtime PR #591): the wire shape —
 *     role, task.split/rep, parent_rollout_id, policy provenance, capture
 *     provenance, inline canonical chat-with-tools messages.
 * Where the two conflicted, RunRecord-derived semantics won; the wire
 * field names follow the ledger (snake_case). See `docs/rollout.md` for
 * the field-by-field decision table.
 *
 * Messages are inlined — never referenced — because every harness store a
 * rollout can be recovered from is mutable or garbage-collected. A line
 * must stay a complete training/eval example on its own.
 *
 * `outcome.reward` is THE single scalar (null = no verdict exists — a
 * labeled gap, never 0). `outcome.realness_gated` is the anti-Goodhart
 * flag: a gated line must never export as a positive training example.
 */

export const ROLLOUT_SCHEMA = 'tangle.rollout.v1'
/** @deprecated alias kept for consumers of the pre-unification constant name. */
export const ROLLOUT_FORMAT = ROLLOUT_SCHEMA

/** `agent` = a solo evaluation run (no multi-agent topology). */
export type RolloutRole = 'agent' | 'supervisor' | 'worker' | 'proposer' | 'judge' | 'analyst'
export const ROLLOUT_ROLES: readonly RolloutRole[] = [
  'agent',
  'supervisor',
  'worker',
  'proposer',
  'judge',
  'analyst',
]

/**
 * Split vocabulary follows `RunRecord.splitTag` ('search' is the pool the
 * optimizer may read — the trainable split), extended with the ledger's
 * 'canary'. 'train' is a legacy alias for 'search' emitted by
 * pre-unification ledgers; it validates and counts as trainable, but new
 * producers must emit 'search'.
 */
export type RolloutSplit = 'search' | 'dev' | 'holdout' | 'canary' | 'train'
export const ROLLOUT_SPLITS: readonly RolloutSplit[] = [
  'search',
  'dev',
  'holdout',
  'canary',
  'train',
]
/** Splits that may ship in training exports. Everything else is fail-closed excluded. */
export const TRAINABLE_SPLITS: readonly RolloutSplit[] = ['search', 'train']

export function isTrainableSplit(split: RolloutSplit): boolean {
  return TRAINABLE_SPLITS.includes(split)
}

/** 'mint' = joined live from RunRecord + trace by `mintRolloutRows`. */
export type RolloutCapture = 'mint' | 'settle-time' | 'backfill'
export const ROLLOUT_CAPTURES: readonly RolloutCapture[] = ['mint', 'settle-time', 'backfill']

// ---------------------------------------------------------------------------
// Canonical message format — OpenAI chat-with-tools, full fidelity.
// ---------------------------------------------------------------------------

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool'
export const CHAT_ROLES: readonly ChatRole[] = ['system', 'user', 'assistant', 'tool']

export interface ChatToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    /** JSON-encoded argument object, exactly as the model emitted it. */
    arguments: string
  }
}

export interface ChatMessage {
  role: ChatRole
  content: string | null
  /** Reasoning/thinking channel where the harness captured it (full fidelity). */
  reasoning_content?: string
  tool_calls?: ChatToolCall[]
  /** Required on role:"tool" — the ChatToolCall this result answers. */
  tool_call_id?: string
  name?: string
}

export interface ToolDef {
  type: 'function'
  function: {
    name: string
    description?: string
    parameters?: Record<string, unknown>
  }
}

/**
 * Compact trace-span projection (llm/tool step) carried alongside the
 * conversation when the line was minted from a trace. Optional: lines
 * recovered from harness stores have no span structure.
 */
export interface RolloutStep {
  kind: string
  name: string
  /** llm: last-message summary · tool: stringified args. Scrubbed. */
  input?: string
  /** llm: output text · tool: stringified result. Scrubbed. */
  output?: string
  status?: 'ok' | 'error'
  durationMs?: number
}

// ---------------------------------------------------------------------------
// Ledger line sections.
// ---------------------------------------------------------------------------

export interface RolloutTask {
  /** Benchmark/suite id (e.g. "swe-bench-verified") or the experiment id. */
  suite: string
  instance_id: string
  split: RolloutSplit
  /** Sampling seed the campaign pinned; null = not recorded. */
  seed: number | null
  /** Replicate index (0-based). */
  rep: number
}

export interface RolloutPolicy {
  /** Harness that drove the invocation (e.g. "opencode", "claude", "pi-loops"). */
  harness: string | null
  harness_version: string | null
  model: string | null
  provider: string | null
  /** Commit of the agent profile / candidate under evaluation. */
  profile_commit: string | null
  /** sha256 of the effective prompt (post-steering), when recorded. */
  prompt_hash?: string | null
  /** sha256 of the effective run config, when recorded. */
  config_hash?: string | null
  /** Canonical agent-profile cell identity, when the run carries one. */
  agent_profile_cell_id?: string | null
  /** Sampling params (temperature, top_p, max_tokens…); null = not recorded. */
  sampling: Record<string, unknown> | null
}

export interface RolloutOutcome {
  /**
   * THE single scalar training signal — the official verdict.
   * null = no verdict exists for this invocation (a labeled gap, never 0).
   */
  reward: number | null
  /** Where the reward came from (judge id; "/inherited" = parent episode's). */
  reward_source: string | null
  /** Raw judge verdict record, verbatim. */
  verdict: unknown
  /** Everything that is NOT the scalar reward. */
  metrics: Record<string, unknown>
  is_completed: boolean
  is_truncated: boolean
  error: string | null
  /**
   * Anti-Goodhart flag from `RunRecord.outcome.realness.gated`: the run
   * faked its success signal. Reward is forced to 0 at mint time and the
   * line never qualifies for SFT. Optional on the wire (absent = false)
   * so pre-unification ledgers stay readable.
   */
  realness_gated?: boolean
}

export interface RolloutCostBlock {
  usd: number | null
  tokens_in: number | null
  tokens_out: number | null
  tokens_reasoning: number | null
  cache_read: number | null
  cache_write: number | null
  wall_s: number | null
}

export interface RolloutArtifacts {
  patch_path: string | null
  run_dir: string | null
  /** Source-of-truth transcript pointer (session id / jsonl path) for audit. */
  transcript_ref: string | null
}

export interface RolloutProvenance {
  captured_at: string
  capture: RolloutCapture
  /** Present on gap lines: why `messages` could not be recovered. */
  gap?: string
}

export interface RolloutLine {
  schema: typeof ROLLOUT_SCHEMA
  rollout_id: string
  /** Spawning invocation within the same episode (worker → supervisor). */
  parent_rollout_id: string | null
  run_id: string
  /** Logical experiment grouping from `RunRecord.experimentId`. Optional on
   *  the wire (pre-unification ledgers lack it); null = not recorded. */
  experiment_id?: string | null
  /** Stable candidate identity from `RunRecord.candidateId`; null = not recorded. */
  candidate_id?: string | null
  /** Improvement-loop generation (-1 = baseline); null = not an improvement loop. */
  generation: number | null
  /** Improvement-loop candidate index (-1 = baseline); null = not an improvement loop. */
  candidate_index: number | null
  role: RolloutRole
  task: RolloutTask
  policy: RolloutPolicy
  /** Full transcript, inline. [] = gap line (see provenance.gap). */
  messages: ChatMessage[]
  tool_defs: ToolDef[]
  /** Trace-span projections, when minted from a trace. */
  steps?: RolloutStep[]
  outcome: RolloutOutcome
  cost: RolloutCostBlock
  artifacts: RolloutArtifacts
  provenance: RolloutProvenance
}

// ---------------------------------------------------------------------------
// Validation — pure TS, no runtime schema dependency, mirroring the
// run-record validator's fail-loud discipline. Returns [] when the value
// is a valid RolloutLine; otherwise one dotted-path error per defect.
// ---------------------------------------------------------------------------

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const isNumberOrNull = (v: unknown): boolean => v === null || typeof v === 'number'
const isStringOrNull = (v: unknown): boolean => v === null || typeof v === 'string'
const isIntegerOrNull = (v: unknown): boolean => v === null || Number.isInteger(v)

function validateChatMessage(value: unknown, path: string, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push(`${path}: not an object`)
    return
  }
  if (!CHAT_ROLES.includes(value.role as ChatRole))
    errors.push(`${path}.role: invalid role ${String(value.role)}`)
  if (!isStringOrNull(value.content)) errors.push(`${path}.content: must be string|null`)
  if (value.reasoning_content !== undefined && typeof value.reasoning_content !== 'string') {
    errors.push(`${path}.reasoning_content: must be string when present`)
  }
  if (value.tool_call_id !== undefined && typeof value.tool_call_id !== 'string') {
    errors.push(`${path}.tool_call_id: must be string when present`)
  }
  if (value.role === 'tool' && typeof value.tool_call_id !== 'string') {
    errors.push(`${path}.tool_call_id: required on role:"tool"`)
  }
  if (value.tool_calls !== undefined) {
    if (!Array.isArray(value.tool_calls)) {
      errors.push(`${path}.tool_calls: must be an array when present`)
    } else {
      value.tool_calls.forEach((call, i) => {
        if (!isRecord(call) || typeof call.id !== 'string' || call.type !== 'function') {
          errors.push(`${path}.tool_calls[${i}]: must be {id, type:"function", function}`)
          return
        }
        const fn = call.function
        if (!isRecord(fn) || typeof fn.name !== 'string' || typeof fn.arguments !== 'string') {
          errors.push(
            `${path}.tool_calls[${i}].function: must be {name: string, arguments: string}`,
          )
        }
      })
    }
  }
}

function validateSection(
  value: unknown,
  path: string,
  fields: Array<[name: string, check: (v: unknown) => boolean, expect: string]>,
  errors: string[],
): void {
  if (!isRecord(value)) {
    errors.push(`${path}: not an object`)
    return
  }
  for (const [name, check, expect] of fields) {
    if (!check(value[name])) errors.push(`${path}.${name}: expected ${expect}`)
  }
}

export function validateRolloutLine(value: unknown): string[] {
  const errors: string[] = []
  if (!isRecord(value)) return ['line: not an object']

  if (value.schema !== ROLLOUT_SCHEMA) errors.push(`schema: expected "${ROLLOUT_SCHEMA}"`)
  if (typeof value.rollout_id !== 'string' || value.rollout_id.length === 0)
    errors.push('rollout_id: expected non-empty string')
  if (!isStringOrNull(value.parent_rollout_id))
    errors.push('parent_rollout_id: expected string|null')
  if (typeof value.run_id !== 'string' || value.run_id.length === 0)
    errors.push('run_id: expected non-empty string')
  if (value.experiment_id !== undefined && !isStringOrNull(value.experiment_id)) {
    errors.push('experiment_id: expected string|null when present')
  }
  if (value.candidate_id !== undefined && !isStringOrNull(value.candidate_id)) {
    errors.push('candidate_id: expected string|null when present')
  }
  if (!isIntegerOrNull(value.generation)) errors.push('generation: expected integer|null')
  if (!isIntegerOrNull(value.candidate_index)) errors.push('candidate_index: expected integer|null')
  if (!ROLLOUT_ROLES.includes(value.role as RolloutRole))
    errors.push(`role: invalid role ${String(value.role)}`)

  validateSection(
    value.task,
    'task',
    [
      ['suite', (v) => typeof v === 'string' && v.length > 0, 'non-empty string'],
      ['instance_id', (v) => typeof v === 'string' && v.length > 0, 'non-empty string'],
      [
        'split',
        (v) => ROLLOUT_SPLITS.includes(v as RolloutSplit),
        `one of ${ROLLOUT_SPLITS.join('|')}`,
      ],
      ['seed', isNumberOrNull, 'number|null'],
      ['rep', (v) => Number.isInteger(v), 'integer'],
    ],
    errors,
  )

  validateSection(
    value.policy,
    'policy',
    [
      ['harness', isStringOrNull, 'string|null'],
      ['harness_version', isStringOrNull, 'string|null'],
      ['model', isStringOrNull, 'string|null'],
      ['provider', isStringOrNull, 'string|null'],
      ['profile_commit', isStringOrNull, 'string|null'],
      ['sampling', (v) => v === null || isRecord(v), 'object|null'],
    ],
    errors,
  )
  if (isRecord(value.policy)) {
    for (const key of ['prompt_hash', 'config_hash', 'agent_profile_cell_id'] as const) {
      if (value.policy[key] !== undefined && !isStringOrNull(value.policy[key])) {
        errors.push(`policy.${key}: expected string|null when present`)
      }
    }
  }

  if (!Array.isArray(value.messages)) {
    errors.push('messages: expected array')
  } else {
    for (const [i, m] of value.messages.entries()) validateChatMessage(m, `messages[${i}]`, errors)
  }

  if (!Array.isArray(value.tool_defs)) {
    errors.push('tool_defs: expected array')
  } else {
    value.tool_defs.forEach((d, i) => {
      if (
        !isRecord(d) ||
        d.type !== 'function' ||
        !isRecord(d.function) ||
        typeof d.function.name !== 'string'
      ) {
        errors.push(`tool_defs[${i}]: must be {type:"function", function:{name}}`)
      }
    })
  }

  if (value.steps !== undefined) {
    if (!Array.isArray(value.steps)) {
      errors.push('steps: expected array when present')
    } else {
      value.steps.forEach((s, i) => {
        if (!isRecord(s) || typeof s.kind !== 'string' || typeof s.name !== 'string') {
          errors.push(`steps[${i}]: must be {kind: string, name: string, …}`)
        }
      })
    }
  }

  validateSection(
    value.outcome,
    'outcome',
    [
      ['reward', isNumberOrNull, 'number|null'],
      ['reward_source', isStringOrNull, 'string|null'],
      ['metrics', isRecord, 'object'],
      ['is_completed', (v) => typeof v === 'boolean', 'boolean'],
      ['is_truncated', (v) => typeof v === 'boolean', 'boolean'],
      ['error', isStringOrNull, 'string|null'],
    ],
    errors,
  )
  if (isRecord(value.outcome)) {
    if (!('verdict' in value.outcome)) errors.push('outcome.verdict: field required (may be null)')
    if (
      value.outcome.realness_gated !== undefined &&
      typeof value.outcome.realness_gated !== 'boolean'
    ) {
      errors.push('outcome.realness_gated: expected boolean when present')
    }
  }

  validateSection(
    value.cost,
    'cost',
    [
      ['usd', isNumberOrNull, 'number|null'],
      ['tokens_in', isNumberOrNull, 'number|null'],
      ['tokens_out', isNumberOrNull, 'number|null'],
      ['tokens_reasoning', isNumberOrNull, 'number|null'],
      ['cache_read', isNumberOrNull, 'number|null'],
      ['cache_write', isNumberOrNull, 'number|null'],
      ['wall_s', isNumberOrNull, 'number|null'],
    ],
    errors,
  )

  validateSection(
    value.artifacts,
    'artifacts',
    [
      ['patch_path', isStringOrNull, 'string|null'],
      ['run_dir', isStringOrNull, 'string|null'],
      ['transcript_ref', isStringOrNull, 'string|null'],
    ],
    errors,
  )

  validateSection(
    value.provenance,
    'provenance',
    [
      [
        'captured_at',
        (v) => typeof v === 'string' && !Number.isNaN(Date.parse(v)),
        'ISO-8601 timestamp',
      ],
      [
        'capture',
        (v) => ROLLOUT_CAPTURES.includes(v as RolloutCapture),
        `one of ${ROLLOUT_CAPTURES.join('|')}`,
      ],
    ],
    errors,
  )
  if (
    isRecord(value.provenance) &&
    value.provenance.gap !== undefined &&
    typeof value.provenance.gap !== 'string'
  ) {
    errors.push('provenance.gap: must be string when present')
  }

  // A gap line must say WHY it is a gap; a full line must not carry a gap note.
  if (Array.isArray(value.messages) && isRecord(value.provenance)) {
    if (value.messages.length === 0 && typeof value.provenance.gap !== 'string') {
      errors.push('provenance.gap: required when messages is empty')
    }
  }

  return errors
}

export function assertRolloutLine(
  value: unknown,
  context = 'rollout line',
): asserts value is RolloutLine {
  const errors = validateRolloutLine(value)
  if (errors.length > 0) {
    throw new Error(`invalid ${context}:\n  ${errors.join('\n  ')}`)
  }
}

export function isRolloutLine(value: unknown): value is RolloutLine {
  return validateRolloutLine(value).length === 0
}
