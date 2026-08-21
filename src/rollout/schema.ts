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
 *
 * That last sentence is enforced here, by `validateRolloutLine`, not merely
 * documented. Validating `reward` and `realness_gated` independently — each a
 * well-typed field, their COMBINATION unchecked — is what let a line claiming
 * `{reward: 0.95, realness_gated: true}` validate clean and walk into every
 * training export. The relationship between the two IS the invariant, so it is
 * checked where every other structural claim about a line is checked.
 *
 * The invariant is about the OUTCOME, not about one field of it. Zeroing
 * `reward` while `outcome.metrics` still carried the per-layer scores that
 * reward was computed from exported the gamed signal anyway, in the dict the
 * verifiers format reads as its per-rubric scores. So `gateGamedOutcome`
 * transforms the whole outcome once, at `assertMinted` — the funnel every
 * minted line passes — and the reward-bearing components are relocated to
 * `provenance.gated_evidence`, which no exporter projects.
 *
 * WHICH checks each door applies is not decided in this file. `./gate-checks`
 * owns the canonical list and the total per-entry-point policy; the three doors
 * below (`validateRolloutLine`, `assertRewardGate`, `assertMinted`) each call
 * `gateErrors` with their declared policy, so a check added to that list applies
 * here without anyone editing this file, and a check deliberately skipped has to
 * name itself there.
 */

import { declaredSteps, GATE_POLICIES, gatedEvidenceOf, gateErrors } from './gate-checks'

export const ROLLOUT_SCHEMA = 'tangle.rollout.v1'

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

/** Split vocabulary follows `RunRecord.splitTag`, extended with `canary`. */
export type RolloutSplit = 'search' | 'dev' | 'holdout' | 'canary'
export const ROLLOUT_SPLITS: readonly RolloutSplit[] = ['search', 'dev', 'holdout', 'canary']
/** Splits that may ship in training exports. Everything else is fail-closed excluded. */
const TRAINABLE_SPLITS: readonly RolloutSplit[] = ['search']

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
const CHAT_ROLES: readonly ChatRole[] = ['system', 'user', 'assistant', 'tool']

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
  /**
   * Harbor ATIF `is_copied_context` (RFC 0001 rule 7): this turn was COPIED IN
   * from another trajectory's context, not produced by the agent on this line.
   * The RFC makes excluding it from SFT a MUST, and `toSftRows` does — training
   * on it teaches the model to author text it never authored, and credits this
   * run for another one's work. Absent = false (authored here).
   */
  is_copied_context?: boolean
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
  // The four fields below are lifted verbatim from Harbor ATIF's per-step
  // `metrics` (see `interchange/harbor.ts`); the wire names stay snake_case to
  // match that spec exactly, which is why they differ from `durationMs`.
  // All optional and never back-filled: an absent field means "not captured",
  // which is not the same claim as an empty array.
  /**
   * LLM inferences this span represents. 0 = deterministic dispatch with no
   * model call — distinct from absent, which means the producer did not track it.
   */
  llm_call_count?: number
  /** Exact prompt tokenization. Removes the ambiguity of re-tokenizing text at train time. */
  prompt_token_ids?: number[]
  /** Exact completion tokenization; aligns index-wise with `logprobs`. */
  completion_token_ids?: number[]
  /**
   * Per-completion-token log probabilities under the sampling policy. Required
   * for off-policy correction (importance weighting) when the rollout was
   * generated by a policy other than the one being trained.
   */
  logprobs?: number[]
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
   * Anti-Goodhart flag from `RunRecord.outcome.realness.gated`: the run faked
   * its success signal. `true` requires `reward` to be 0 or null — the
   * validator rejects the line otherwise — and the line never qualifies for
   * SFT. Required on the wire: a line that does not state the flag does not
   * validate, so no producer can dodge the gate by omitting it.
   *
   * `true` ALSO requires `metrics` to be empty and `verdict` to be null: the
   * numbers the reward was computed from are relocated to
   * `provenance.gated_evidence` by `gateGamedOutcome`. See that function for
   * why zeroing the scalar alone was not enough.
   */
  realness_gated: boolean
  /**
   * Whether an authenticity SCREEN ever RAN on this reward — a different claim
   * from `realness_gated`, which is the screen's VERDICT.
   *
   * `realness_gated: false` reads as "we looked and nothing fired". A producer
   * with no screen at all was emitting exactly that, so a never-screened reward
   * was indistinguishable on the wire from a screened-clean one, and the whole
   * anti-Goodhart apparatus silently treated the first as the second. The two
   * claims are now separable:
   *
   *   - `true`   — a screen ran; `realness_gated` is its verdict.
   *   - `false`  — the producer declares it HAS no screen (`unscreenedRewardFields`).
   *                `assertMinted` REFUSES such a line when its reward is above
   *                zero: an unscreened positive reward is precisely the signal
   *                the gate exists to qualify, and nothing has qualified it.
   *   - absent   — not stated. Pre-unification ledgers land here, as does a
   *                `RunRecord` carrying no `outcome.realness` at all. Absent is
   *                read as "unknown", never as `false` (which would refuse most
   *                of the existing corpus) and never as `true`.
   */
  realness_screened?: boolean
}

export interface RolloutCostBlock {
  usd: number | null
  tokens_in: number | null
  tokens_out: number | null
  tokens_reasoning: number | null
  cache_read: number | null
  cache_write: number | null
  wall_s: number | null
  /**
   * Total LLM inferences across the invocation (ATIF `llm_call_count`,
   * aggregated). Optional and additive: absent = not tracked, never 0.
   */
  llm_call_count?: number | null
}

export interface RolloutArtifacts {
  patch_path: string | null
  run_dir: string | null
  /** Source-of-truth transcript pointer (session id / jsonl path) for audit. */
  transcript_ref: string | null
}

/**
 * The reward-bearing half of a GATED line's outcome, moved off `outcome` and
 * parked here verbatim. Diagnostics, never training input — see
 * `gateGamedOutcome`.
 */
export interface GatedEvidence {
  /** `outcome.metrics` exactly as the producer measured it. */
  metrics?: Record<string, unknown>
  /** `outcome.verdict` verbatim — the judge record that claimed the success. */
  verdict?: unknown
  /**
   * The per-step fields `tangle.rollout.v1` does not declare, parked here when
   * the gate projected `steps[]` down to the schema's own key set.
   *
   * A per-step reward is training signal exactly like the scalar, and `steps`
   * rides through `toRewardRows` verbatim — so a gated line was shipping its
   * step-level credit assignment at full value beside a `reward` of 0.
   */
  steps?: unknown
}

export interface RolloutProvenance {
  captured_at: string
  capture: RolloutCapture
  /**
   * Why this line is incomplete. Required when `messages` is empty (the
   * transcript could not be recovered); also set by interchange importers to
   * name a MISSING LABEL — an imported trajectory carries no verdict, so
   * `outcome.reward` is null and this says why.
   */
  gap?: string
  /**
   * Present only on a realness-gated line: the outcome fields the gate
   * relocated, kept so an auditor can still see WHY the run was gated and what
   * it claimed. Deliberately OUTSIDE `outcome`, because every training exporter
   * reads `outcome` and none reads `provenance`.
   */
  gated_evidence?: GatedEvidence
}

export interface RolloutLine {
  schema: typeof ROLLOUT_SCHEMA
  rollout_id: string
  /** Spawning invocation within the same episode (worker → supervisor). */
  parent_rollout_id: string | null
  run_id: string
  /** Logical experiment grouping from `RunRecord.experimentId`; null = not recorded. */
  experiment_id: string | null
  /** Stable candidate identity from `RunRecord.candidateId`; null = not recorded. */
  candidate_id: string | null
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
const isNumberArray = (v: unknown): boolean =>
  Array.isArray(v) && v.every((n) => typeof n === 'number' && Number.isFinite(n))
const isIntegerArray = (v: unknown): boolean =>
  Array.isArray(v) && v.every((n) => Number.isInteger(n))
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
  if (value.is_copied_context !== undefined && typeof value.is_copied_context !== 'boolean') {
    errors.push(`${path}.is_copied_context: must be boolean when present`)
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

/**
 * THE anti-Goodhart gate, applied to the WHOLE outcome as a TRANSFORMATION.
 *
 * Two prior rounds enforced the gate as a CHECK ON ONE FIELD at N call sites,
 * and each round the next reward-bearing field leaked. The one that shipped:
 * `mintRolloutRows` bulk-copied `RunRecord.outcome.raw` into `outcome.metrics`
 * with no gate, so a gated run exported `reward: 0` (correct) while the
 * deterministic per-layer scores that reward was COMPUTED FROM — the
 * `layer.*` keys `rl/verifiable-reward.ts` calls the RL training signal —
 * shipped at 1.0, in the top-level `metrics` dict of the Prime Intellect
 * verifiers format, which IS that format's per-rubric score dict. `verdict`
 * leaks the same way into `toRftItem`'s `reference.verdict`, where a grader
 * author reads `resolved: true` off a run that faked it.
 *
 * So the rule is no longer "zero the field we remembered". It is: if the gate
 * fired, the outcome that leaves here carries NOTHING positive that was derived
 * from the reward, whichever field a present or future exporter decides to
 * read. `reward` is already forced to 0 upstream (`trainingReward`) and
 * REJECTED here if it is not; `metrics` and `verdict` are relocated.
 *
 * WHERE they go, and why relocation rather than deletion: zeroing destroys the
 * audit trail that shows why the run was gated and what it claimed, which is
 * the row an auditor most wants and the labeled example a gaming DETECTOR
 * trains on. `provenance.gated_evidence` keeps every byte, at a path no
 * training exporter reads — all four release configs and every `rl/exporters`
 * shape project from `outcome`, `messages`, `cost` and `task`; none projects
 * `provenance`. Auditability preserved, training signal removed, and a future
 * exporter that reads a field nobody thought of is safe by construction because
 * the field is empty rather than because the exporter remembered to check.
 *
 * Idempotent: a second application finds nothing left to move and returns the
 * line unchanged, so re-minting a line read back off a ledger cannot clobber
 * the evidence it already carries.
 */
export function gateGamedOutcome(line: RolloutLine): RolloutLine {
  if (line.outcome.realness_gated !== true) return line
  const moved = gatedEvidenceOf(line)
  if (moved === undefined) return line
  const kept = line.provenance.gated_evidence
  const evidence: GatedEvidence = {}
  const metrics = { ...kept?.metrics, ...moved.metrics }
  if (Object.keys(metrics).length > 0) evidence.metrics = metrics
  if (moved.verdict !== undefined) evidence.verdict = moved.verdict
  else if (kept?.verdict !== undefined) evidence.verdict = kept.verdict
  if (moved.steps !== undefined) evidence.steps = moved.steps
  else if (kept?.steps !== undefined) evidence.steps = kept.steps
  // The trajectory itself STAYS: a gamed transcript is the labeled example a
  // gaming detector trains on, and the exporters are meant to ship it. Only the
  // fields the wire format does not declare come off, which is the same
  // partition `gatedEvidenceOf` applies to `metrics` — the producer's own,
  // never a key-name guess.
  const steps = moved.steps === undefined ? line.steps : declaredSteps(line.steps)
  return {
    ...line,
    ...(steps === undefined ? {} : { steps }),
    outcome: { ...line.outcome, metrics: {}, verdict: null },
    provenance: { ...line.provenance, gated_evidence: evidence },
  }
}

/**
 * EVERY gate check, for the export path — the runtime backstop.
 *
 * `validateRolloutLine` checks the reward relationship too, but an exporter
 * cannot afford to re-validate every field of every line, and more importantly
 * it is not the exporter's job to re-check the schema — it is its job never to
 * emit a signal it was told is fabricated. Thrown rather than filtered: an
 * exporter silently dropping a poisoned line would hide the producer that made
 * it, and the producer is the actual defect.
 *
 * This is the third layer, and it exists for exactly one caller: JavaScript.
 * The brand stops TypeScript callers at compile time and `assertMinted` fixes
 * data arriving from disk, but neither is present for a plain JS consumer of
 * the published package handing an object literal to `toRewardRows`. Which is
 * exactly why this entry point's policy omits nothing: a check it skips is a
 * check that never runs for those callers at all. It composed two of the three
 * for one round, and a never-screened positive reward walked through all four
 * waist exporters at full value. `GATE_POLICIES.assertRewardGate` is now the
 * only place that list is written down.
 */
export function assertRewardGate(line: RolloutLine, context: string): void {
  const errors = gateErrors(line, GATE_POLICIES.assertRewardGate)
  if (errors.length > 0) {
    throw new Error(`${context}: rollout ${line.rollout_id} — ${errors[0]}`)
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
  if (!isStringOrNull(value.experiment_id)) errors.push('experiment_id: expected string|null')
  if (!isStringOrNull(value.candidate_id)) errors.push('candidate_id: expected string|null')
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
          return
        }
        // ATIF-lifted optionals: absent on every line written before they
        // existed, so they are checked only when present — old ledgers stay valid.
        if (s.llm_call_count !== undefined && !Number.isInteger(s.llm_call_count)) {
          errors.push(`steps[${i}].llm_call_count: expected integer when present`)
        }
        for (const key of ['prompt_token_ids', 'completion_token_ids'] as const) {
          if (s[key] !== undefined && !isIntegerArray(s[key])) {
            errors.push(`steps[${i}].${key}: expected integer[] when present`)
          }
        }
        if (s.logprobs !== undefined && !isNumberArray(s.logprobs)) {
          errors.push(`steps[${i}].logprobs: expected number[] when present`)
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
    if (typeof value.outcome.realness_gated !== 'boolean') {
      errors.push('outcome.realness_gated: expected boolean')
    }
    if (
      value.outcome.realness_screened !== undefined &&
      typeof value.outcome.realness_screened !== 'boolean'
    ) {
      errors.push('outcome.realness_screened: expected boolean when present')
    }
    errors.push(
      ...gateErrors(
        { outcome: value.outcome, steps: value.steps },
        GATE_POLICIES.validateRolloutLine,
      ),
    )
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
  if (
    isRecord(value.cost) &&
    value.cost.llm_call_count !== undefined &&
    !(value.cost.llm_call_count === null || Number.isInteger(value.cost.llm_call_count))
  ) {
    errors.push('cost.llm_call_count: expected integer|null when present')
  }

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
  if (isRecord(value.provenance)) {
    if (value.provenance.gap !== undefined && typeof value.provenance.gap !== 'string') {
      errors.push('provenance.gap: must be string when present')
    }
    const evidence = value.provenance.gated_evidence
    if (evidence !== undefined) {
      if (!isRecord(evidence)) {
        errors.push('provenance.gated_evidence: must be an object when present')
      } else if (evidence.metrics !== undefined && !isRecord(evidence.metrics)) {
        errors.push('provenance.gated_evidence.metrics: must be an object when present')
      }
    }
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

// ---------------------------------------------------------------------------
// The minted brand — the COMPILE-TIME half of the anti-Goodhart gate.
// ---------------------------------------------------------------------------

/**
 * Phantom property. `declare const` means it exists only in the type system:
 * nothing is written at runtime, so a branded line still serializes to exactly
 * the same JSON as a plain one.
 */
declare const MINTED_ROLLOUT: unique symbol

/**
 * A minted outcome states the gate verdict — it is not allowed to stay silent —
 * and, when that verdict is `true`, carries nothing else the reward was derived
 * from (`gateGamedOutcome` has run).
 */
export interface MintedRolloutOutcome extends RolloutOutcome {
  realness_gated: boolean
}

/**
 * A `RolloutLine` whose reward has been checked against the anti-Goodhart
 * invariant. The type every training-data exporter takes.
 *
 * Why a brand and not just the interface: `RolloutLine` is structural, so any
 * hand-built object literal of the right shape IS one — which is how a line
 * declaring `{reward: 0.95, realness_gated: true}` reached the exporters
 * despite them "only accepting a minted line". The phantom symbol makes the
 * type nominal: it cannot be produced by writing an object literal, only by
 * `mintRolloutRows` (which applies the gate), `readRolloutLedger` (which
 * validates every line off disk), or an explicit, greppable `assertMinted`.
 *
 * Belt and braces on purpose. The brand closes first-party call sites at
 * COMPILE time; `validateRolloutLine` closes data arriving at RUNTIME (ledger
 * files, foreign imports, JSON from another process) where types are absent.
 * Neither alone is enough.
 *
 * Assignable to `RolloutLine` in one direction only: readers, analysis, and
 * the ledger writer keep taking the plain type.
 */
export type MintedRolloutLine = Omit<RolloutLine, 'outcome'> & {
  readonly [MINTED_ROLLOUT]: true
  outcome: MintedRolloutOutcome
}

/**
 * Promote a line to the type the training exporters accept, applying the
 * anti-Goodhart gate to the WHOLE outcome on the way through. THE escape hatch
 * — grep `assertMinted` to enumerate every place a line enters the training
 * path without coming from mint or a ledger.
 *
 * The gate runs HERE, once, rather than at each producer, because this is the
 * single funnel every minted line passes: `mintRolloutRows` calls it,
 * `readRolloutLedger` calls it per line off disk, `scrubLines` calls it on the
 * way out of a release, and a hand-built line has no other door. One
 * transformation at the funnel means an already-published ledger holding a
 * gated line with populated `metrics` is RE-GATED when it is read, instead of
 * being rejected (which would make every such artifact unreadable) or trusted
 * (which is the leak). Three steps, in this order:
 *
 *   1. VALIDATE the schema.
 *   2. REFUSE every check `GATE_POLICIES.assertMinted` marks `enforce` — today
 *      the reward relationship (which stays a REJECTION: a caller claiming
 *      `{reward: 0.95, realness_gated: true}` is a producer defect and must fail
 *      loudly, since laundering it into `reward: 0` here would hide the
 *      producer) and a positive reward the producer declared it never screened.
 *   3. TRANSFORM the one check that policy marks `repair` — relocate the
 *      reward's components off `outcome` (`gateGamedOutcome`), so no exporter
 *      can leak them whichever field it reads.
 *
 * Step 2 enumerates nothing by hand: a check added to `GATE_CHECKS` is enforced
 * here the moment its disposition in that policy says so.
 *
 * Also normalizes the optional wire flag to an explicit boolean.
 * `realness_gated` is absent on pre-unification ledgers and absent means "not
 * flagged" per the schema, so filling it in states a claim the line was already
 * making, and makes the flag readable on every published row instead of most of
 * them. `realness_screened` is NOT filled in: absent means "unknown", and
 * inventing either value there would be the same overclaim this round removed.
 */
export function assertMinted(value: unknown, context = 'rollout line'): MintedRolloutLine {
  assertRolloutLine(value, context)
  const refused = gateErrors(value, GATE_POLICIES.assertMinted)
  if (refused.length > 0) {
    throw new Error(`invalid ${context}: rollout ${value.rollout_id} — ${refused[0]}`)
  }
  const gated = gateGamedOutcome(value)
  if (gated.outcome.realness_gated === undefined) {
    return {
      ...gated,
      outcome: { ...gated.outcome, realness_gated: false },
    } as MintedRolloutLine
  }
  return gated as MintedRolloutLine
}

/** `assertMinted` over a batch, naming the offending index in the error. */
export function assertMintedLines(
  values: readonly unknown[],
  context = 'rollout line',
): MintedRolloutLine[] {
  return values.map((value, i) => assertMinted(value, `${context} [${i}]`))
}
