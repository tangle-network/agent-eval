/**
 * Shared checks for trainer exports over canonical minted rollout lines.
 *
 * Exporters accept only `MintedRolloutLine[]`. Callers convert run records with
 * `mintRolloutRows` before deriving preferences or trainer files.
 */

import { assertRewardGate, type MintedRolloutLine } from '../rollout/schema'

/**
 * The line's reward, with `null` meaning "no verdict exists" and never "scored
 * zero".
 *
 * The wire contract represents an absent verdict directly as `reward: null`.
 */
export function trainableLineReward(line: MintedRolloutLine): number | null {
  // The single reward reader on the `rl/` side, so the runtime invariant check
  // sits here and covers GRPO rows, SFT row metadata, preference ordering, and
  // the published datasheet's reward distribution in one place.
  assertRewardGate(line, 'trainable reward')
  const { reward } = line.outcome
  if (reward === null || !Number.isFinite(reward)) return null
  return reward
}

/** The anti-Goodhart flag as it travels on the line. */
export function isLineRealnessGated(line: MintedRolloutLine): boolean {
  return line.outcome.realness_gated === true
}

/**
 * The minted lines behind a LINE-LESS training artifact.
 *
 * `PreferenceTriple`, `PrmTrainingTriple` and `StepReward` all carry a bare
 * reward number plus run ids, and nothing that says whether those runs faked
 * their success. An exporter over them therefore has no way, from its input
 * alone, to learn that its chosen side is a run the gate flagged — it will
 * happily emit the gaming trajectory as the preferred one. Supplying the lines
 * is what gives it eyes.
 */
export interface RolloutLineContext {
  /**
   * Minted lines for every INVOCATION the artifacts reference.
   *
   * Not "one line per run": `tangle.rollout.v1` models many invocations per
   * `run_id` — that is what `rollout_id` and `parent_rollout_id` are for, and
   * `supervisorRunRolloutLines` emits a supervisor node plus one per worker, all
   * sharing a single `run_id`. A reference is resolved against `rollout_id`
   * first and falls back to `run_id` only when that run has exactly one
   * invocation; see `resolveInvocation`.
   */
  lines: MintedRolloutLine[]
}

/** How one exporter names itself and its context type in the failure messages. */
export interface LineContextRequirement {
  /** Exporter label, e.g. `'DPO export'`. */
  exporter: string
  /** The context type the caller must pass, e.g. `'DpoLineContext'`. */
  contextType: string
  /** Why this exporter cannot see the gate without lines. One sentence. */
  because: string
}

/**
 * How ONE reference on a line-less artifact resolved against the supplied lines.
 *
 * `'ambiguous'` is a real answer, not an error path: the id named more than one
 * invocation and there is no way to tell which one the artifact meant.
 */
type Resolution =
  | { kind: 'resolved'; line: MintedRolloutLine }
  | { kind: 'ambiguous'; count: number }
  | { kind: 'missing' }

/**
 * Both identity keys a line-less artifact might be carrying, built once.
 *
 * `rollout_id` is the INVOCATION id and is the key that answers the question
 * these exporters ask ("was the run behind this side of the pair gamed?").
 * `run_id` is an EPISODE id: `mintRolloutRows` writes it equal to `rollout_id`
 * for a solo run, but `supervisorRunRolloutLines` shares one `run_id` across a
 * supervisor node and every worker it spawned. The published artifacts
 * (`PreferenceTriple.chosenRunId`, `StepReward.runId`,
 * `PrmTrainingTriple.prefixRunId`) name run ids, so the fallback has to exist —
 * but only where it cannot be wrong.
 */
interface InvocationIndex {
  byRollout: Map<string, MintedRolloutLine[]>
  byRun: Map<string, MintedRolloutLine[]>
}

function push(index: Map<string, MintedRolloutLine[]>, key: string, line: MintedRolloutLine): void {
  const existing = index.get(key)
  if (existing === undefined) index.set(key, [line])
  else existing.push(line)
}

function invocationIndex(lines: readonly MintedRolloutLine[]): InvocationIndex {
  const byRollout = new Map<string, MintedRolloutLine[]>()
  const byRun = new Map<string, MintedRolloutLine[]>()
  for (const line of lines) {
    push(byRollout, line.rollout_id, line)
    push(byRun, line.run_id, line)
  }
  return { byRollout, byRun }
}

/**
 * Resolve one referenced id to exactly ONE invocation, or refuse to guess.
 *
 * The previous implementation was `new Map(lines.map((l) => [l.run_id, l]))`,
 * which is LAST-WINS: with a gated supervisor node and an ungated worker sharing
 * a `run_id`, the answer depended on which one appeared later in the array, so
 * `[gatedRoot, worker, rival]` emitted the gamed trajectory as `chosen` and
 * simply reordering the same input suppressed it. An order-dependent security
 * property passes every test whose fixture happens to be ordered favourably,
 * which is the worst possible failure mode for a gate.
 *
 * The rule that removes order from the answer: an id resolves only when it names
 * one invocation. `rollout_id` is tried first because it IS the invocation id;
 * `run_id` is accepted only when the run holds a single invocation, and a
 * cross-index disagreement (an id that is one line's `rollout_id` and a
 * different line's `run_id`) is ambiguous rather than silently preferring
 * either.
 */
function resolveInvocation(index: InvocationIndex, id: string): Resolution {
  const rollouts = index.byRollout.get(id) ?? []
  const runs = index.byRun.get(id) ?? []
  if (rollouts.length > 1) return { kind: 'ambiguous', count: rollouts.length }
  const exact = rollouts[0]
  if (exact !== undefined) {
    if (runs.some((line) => line !== exact)) {
      return { kind: 'ambiguous', count: 1 + runs.filter((line) => line !== exact).length }
    }
    return { kind: 'resolved', line: exact }
  }
  if (runs.length > 1) return { kind: 'ambiguous', count: runs.length }
  const only = runs[0]
  return only === undefined ? { kind: 'missing' } : { kind: 'resolved', line: only }
}

/** What the admission rule did, item by item — the count a caller has to be able to see. */
export interface AdmissionAudit<T> {
  admitted: T[]
  /** Items dropped because a referenced invocation was realness-gated. */
  gatedDrops: number
  /** Items dropped because a referenced id named more than one invocation. */
  ambiguousDrops: number
  /** Each ambiguous id and how many invocations it named, deduped, first-seen order. */
  ambiguous: Array<{ id: string; invocations: number }>
}

/**
 * THE admission rule for every exporter whose input is line-less — one
 * implementation, because two siblings over the same input class with different
 * gating is the defect being eliminated, and it has now happened twice
 * (`toPrmRows` hardened while `toDpoRows` was left open; `toGrpoRows`'
 * `rewardOf` gated while `extractPreferences`' identically-named hook was not).
 *
 * Fail-closed in five steps:
 *   1. No context at all → throw. A two-argument call used to be accepted and
 *      produced rows with no gate applied whatsoever.
 *   2. A referenced id with NO line → throw. Its gate status is unknown, and
 *      unknown is not clean. Thrown rather than dropped because it means the
 *      caller did not supply the context it was asked for, which is a defect in
 *      the call, not in the data.
 *   3. A referenced id naming MORE THAN ONE invocation → DROP the item and count
 *      it. Dropped rather than thrown because, unlike (2), this is ordinary data
 *      — a supervision episode legitimately holds a supervisor invocation and
 *      several workers under one `run_id` — and throwing would make these
 *      exporters unusable on any supervisor corpus, whose only workaround is for
 *      the caller to hand-filter `context.lines` down to one line per run. That
 *      workaround IS the leak, performed by hand. The count is surfaced by
 *      `admitUngatedByInvocation` so the drop is never silent.
 *   4. Every resolved line goes through `assertRewardGate`, so the line-less
 *      exporters compose the same check list as the waist exporters instead of
 *      relying on `realness_gated` alone (which is one of three checks).
 *   5. Either side realness-gated → DROP the item. Dropped rather than zeroed
 *      because these shapes have no honest zero: a preference pair is a
 *      statement that one trajectory is better than another, and a gamed
 *      trajectory belongs on neither side of it — as the chosen one it teaches
 *      the gaming move outright, and as the rejected one it still ships the
 *      gaming trajectory's text into the training file as a contrast example
 *      nobody asked for.
 *
 * `inspect` is the per-exporter extra check (PRM's trajectory-completeness
 * rules). It runs on every resolved line before any item is admitted, so the
 * whole batch fails before a single row is built.
 *
 * Pure: it reports what it dropped and prints nothing.
 */
export function auditInvocationAdmission<T>(
  items: readonly T[],
  idsOf: (item: T) => readonly string[],
  context: RolloutLineContext | undefined | null,
  requirement: LineContextRequirement,
  inspect?: (line: MintedRolloutLine) => void,
): AdmissionAudit<T> {
  if (context === undefined || context === null) {
    throw new Error(
      `${requirement.exporter}: a ${requirement.contextType} is required — ${requirement.because} Pass \`{ lines: (await mintRolloutRows(...)).rows }\`.`,
    )
  }
  const index = invocationIndex(context.lines)
  const audit: AdmissionAudit<T> = {
    admitted: [],
    gatedDrops: 0,
    ambiguousDrops: 0,
    ambiguous: [],
  }
  for (const item of items) {
    const lines: MintedRolloutLine[] = []
    let ambiguous = false
    for (const id of idsOf(item)) {
      const resolution = resolveInvocation(index, id)
      if (resolution.kind === 'missing') {
        throw new Error(
          `${requirement.exporter}: no rollout line supplied for run ${id} — its realness gate and capture quality are unknown`,
        )
      }
      if (resolution.kind === 'ambiguous') {
        ambiguous = true
        if (!audit.ambiguous.some((entry) => entry.id === id)) {
          audit.ambiguous.push({ id, invocations: resolution.count })
        }
        continue
      }
      lines.push(resolution.line)
    }
    for (const line of lines) {
      assertRewardGate(line, requirement.exporter)
      inspect?.(line)
    }
    if (ambiguous) {
      audit.ambiguousDrops++
      continue
    }
    if (lines.some(isLineRealnessGated)) {
      audit.gatedDrops++
      continue
    }
    audit.admitted.push(item)
  }
  return audit
}

/**
 * `auditInvocationAdmission` for the exporters, which return rows and have
 * nowhere to put a count.
 *
 * The ambiguous drops are announced rather than swallowed: a caller who asked
 * for N pairs and silently received N-k has no way to notice that a chunk of
 * their preference data quietly evaporated, and "the training set got smaller
 * for a reason nobody printed" is the same class of invisible failure as the
 * gate that never ran. A gated drop is NOT announced — that one is the gate
 * doing exactly its job, on the population the caller already knows is flagged.
 */
export function admitUngatedByInvocation<T>(
  items: readonly T[],
  idsOf: (item: T) => readonly string[],
  context: RolloutLineContext | undefined | null,
  requirement: LineContextRequirement,
  inspect?: (line: MintedRolloutLine) => void,
): T[] {
  const audit = auditInvocationAdmission(items, idsOf, context, requirement, inspect)
  if (audit.ambiguousDrops > 0) {
    const named = audit.ambiguous.map((e) => `${e.id} (${e.invocations} invocations)`).join(', ')
    console.warn(
      `[${requirement.exporter}] dropped ${audit.ambiguousDrops} item(s): ${named} name more ` +
        'than one invocation in the supplied lines, so the realness gate cannot be read for the ' +
        'invocation the artifact meant. Reference the `rollout_id` instead of the `run_id`, or ' +
        'supply a context holding one invocation per run.',
    )
  }
  return audit.admitted
}
