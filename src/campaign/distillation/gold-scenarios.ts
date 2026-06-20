/**
 * @experimental
 *
 * Gold scenarios for teacher→student distillation. The TEACHER is an
 * expensive workflow (e.g. the 70-agent skill audit) whose verdicts are
 * frozen as gold labels; the STUDENT is a cheap single-shot analyst whose
 * prompt GEPA optimizes toward reproducing those labels.
 *
 * A `GoldScenario` is a `Scenario` (the substrate's input contract) carrying
 * an OPAQUE `input` (what the student sees) and an OPAQUE `label` (the gold
 * verdict the student's output is scored against). Both are typed `unknown`
 * here: this module is domain-agnostic — it distills ANY analyst against ANY
 * gold JSONL. The agreement comparator (see `agreement-judge.ts`) is what
 * knows the label's shape.
 *
 * Loading + splitting are DETERMINISTIC and LLM-free: the gold set is the
 * fixed ground truth, never regenerated here.
 */

import { readFileSync } from 'node:fs'
import type { Scenario } from '../types'

/** A held gold record: opaque student-input + opaque gold-label, carried as a
 *  substrate `Scenario` so it flows through `runCampaign` unchanged. */
export interface GoldScenario<TInput = unknown, TLabel = unknown> extends Scenario {
  kind: 'gold'
  /** What the student analyst is shown (rendered into its user prompt). */
  input: TInput
  /** The teacher's gold verdict — the target the student's output is scored
   *  against by the agreement judge. NEVER shown to the student. */
  label: TLabel
}

/** One raw JSONL line. `scenarioId` and `id` are both accepted (the audit
 *  emits `scenarioId`); `split` is honored when present. */
interface GoldJsonlLine {
  scenarioId?: string
  id?: string
  input: unknown
  label: unknown
  split?: 'train' | 'test'
}

/** Read a gold JSONL (one `{scenarioId|id, input, label, split?}` per line) into
 *  `GoldScenario[]`. Deterministic, no LLM. Blank lines are skipped; a line
 *  missing an id, `input`, or `label` throws (a silent skip would corrupt the
 *  split silently — fail loud on a malformed gold set). */
export function loadGoldScenarios<TInput = unknown, TLabel = unknown>(
  jsonlPath: string,
): GoldScenario<TInput, TLabel>[] {
  const text = readFileSync(jsonlPath, 'utf8')
  return parseGoldJsonl<TInput, TLabel>(text, jsonlPath)
}

/** Parse gold JSONL text directly (no fs). Exported so tests + in-memory
 *  callers exercise the same parse path as {@link loadGoldScenarios}. */
export function parseGoldJsonl<TInput = unknown, TLabel = unknown>(
  text: string,
  sourceLabel = '<inline>',
): GoldScenario<TInput, TLabel>[] {
  const out: GoldScenario<TInput, TLabel>[] = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!.trim()
    if (raw.length === 0) continue
    let parsed: GoldJsonlLine
    try {
      parsed = JSON.parse(raw) as GoldJsonlLine
    } catch (err) {
      throw new Error(
        `loadGoldScenarios: ${sourceLabel}:${i + 1} is not valid JSON — ${
          err instanceof Error ? err.message : String(err)
        }`,
      )
    }
    const rawId = parsed.scenarioId ?? parsed.id
    if (typeof rawId !== 'string' || rawId.length === 0) {
      throw new Error(
        `loadGoldScenarios: ${sourceLabel}:${i + 1} missing string \`scenarioId\`/\`id\``,
      )
    }
    // runCampaign forms the cellId as `${scenario.id}:${rep}` and heldOutGate
    // recovers the scenarioId via `cellId.split(':')[0]`. A ':' in the id (the
    // real skill-audit gold uses ids like `skill:blueprint-launch`) would
    // collapse every scenario into the first segment's bucket and zero the
    // holdout delta. Sanitize ':' → '__' for the campaign id; the original is
    // preserved on the scenario for display + traceback.
    const id = rawId.replace(/:/g, '__')
    if (parsed.input === undefined) {
      throw new Error(`loadGoldScenarios: ${sourceLabel}:${i + 1} (${rawId}) missing \`input\``)
    }
    if (parsed.label === undefined) {
      throw new Error(`loadGoldScenarios: ${sourceLabel}:${i + 1} (${rawId}) missing \`label\``)
    }
    const scenario: GoldScenario<TInput, TLabel> = {
      id,
      kind: 'gold',
      input: parsed.input as TInput,
      label: parsed.label as TLabel,
    }
    const tags: string[] = []
    if (id !== rawId) tags.push(`gold-id:${rawId}`)
    if (parsed.split !== undefined) tags.push(`split:${parsed.split}`)
    if (tags.length > 0) scenario.tags = tags
    out.push(scenario)
  }
  if (out.length === 0) {
    throw new Error(`loadGoldScenarios: ${sourceLabel} contained no gold records`)
  }
  return out
}

export interface SplitGoldOptions {
  /** Every Nth scenario (0-based index) goes to the TEST/holdout split; the
   *  rest train. Default 4 ⇒ a 25% holdout. Ignored for any scenario that
   *  carries an explicit `split:` tag (that is honored verbatim). */
  testEveryNth?: number
}

export interface GoldSplit<TInput, TLabel> {
  /** Training scenarios — the optimization pool the proposer searches over. */
  train: GoldScenario<TInput, TLabel>[]
  /** Held-out scenarios — kept OUT of training; scored only at the gate. */
  test: GoldScenario<TInput, TLabel>[]
}

/** Deterministic train/test split. A scenario tagged `split:train|test` is
 *  routed by that tag; the rest fall to a modulo split (`index % testEveryNth
 *  === 0 ⇒ test`). Pure — same input always yields the same split, so a gold
 *  set's holdout is stable across runs (a shuffled split would let a lucky
 *  seed flatter the gate). */
export function splitGold<TInput, TLabel>(
  scenarios: GoldScenario<TInput, TLabel>[],
  options: SplitGoldOptions = {},
): GoldSplit<TInput, TLabel> {
  const testEveryNth = options.testEveryNth ?? 4
  if (!Number.isInteger(testEveryNth) || testEveryNth < 2) {
    throw new Error('splitGold: testEveryNth must be an integer ≥ 2 (else train or test is empty)')
  }
  const train: GoldScenario<TInput, TLabel>[] = []
  const test: GoldScenario<TInput, TLabel>[] = []
  let implicitIndex = 0
  for (const scenario of scenarios) {
    const explicit = explicitSplit(scenario)
    if (explicit === 'train') {
      train.push(scenario)
    } else if (explicit === 'test') {
      test.push(scenario)
    } else {
      // Only implicit scenarios are counted for the modulo, so honoring some
      // explicit tags doesn't skew the deterministic stride of the rest.
      if (implicitIndex % testEveryNth === 0) test.push(scenario)
      else train.push(scenario)
      implicitIndex += 1
    }
  }
  return { train, test }
}

function explicitSplit(scenario: GoldScenario): 'train' | 'test' | undefined {
  for (const tag of scenario.tags ?? []) {
    if (tag === 'split:train') return 'train'
    if (tag === 'split:test') return 'test'
  }
  return undefined
}
