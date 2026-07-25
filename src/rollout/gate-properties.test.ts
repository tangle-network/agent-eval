/**
 * The anti-Goodhart gate, closed by GENERATION instead of by imagination.
 *
 * Four adversarial rounds found 13, then 2, then 2 leaks, and every one had the
 * same shape: a guard existed but did not compose every check, or a second path
 * existed that skipped one. That instrument is an agent reading code and
 * guessing, so it converges slowly and it only ever finds what someone thought
 * to look for — leak 1 of round 4 was an ORDER-DEPENDENT lookup, which no
 * example-based test can find because every fixture is written in one order and
 * that order is usually the favourable one.
 *
 * Property-based testing explores by construction. Three properties hold the
 * whole surface:
 *
 *   1. CONTAINMENT — for any line the screen flagged as gamed, with arbitrary
 *      positive numbers in every reward-derived position, no exporter emits any
 *      of them. Run against BOTH doors: the minted path (`assertMinted`) and the
 *      raw path a plain-JavaScript consumer of the published package uses, which
 *      is the population `assertRewardGate` exists for and where the last two
 *      leaks lived.
 *   2. ORDER INDEPENDENCE — shuffling the input array changes no exporter's
 *      output. This is leak 1 stated as a law.
 *   3. IDEMPOTENCE — the gating transform applied twice equals applied once, on
 *      the line AND across a Harbor round-trip (round 3 found gap-string
 *      accretion there).
 *
 * The exporter registry is a TOTAL map over `EXPORTER_IDS`, so an exporter added
 * to the package without a probe here is a type error, not a silent hole — the
 * same discipline `GATE_CHECKS` applies to the checks themselves.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { buildRlDataset, type RlDatasetConfig } from '../rl/dataset'
import {
  stepRewardsToJsonl,
  toDpoRows,
  toGrpoRows,
  toPrmRows,
  toSftRows as toRlSftRows,
} from '../rl/exporters'
import { type PreferenceTriple, toAnthropicFormat, toTRLFormat } from '../rl/preferences'
import type { PrmTrainingTriple, StepReward } from '../rl/process-reward'
import {
  toRewardRows,
  toRftItems,
  toVerifiersRolloutOutputs,
  toSftRows as toWaistSftRows,
} from './exporters'
import { malformedRolloutLine } from './fixtures'
import { fromHarborTrajectory, toHarborTrajectories } from './interchange/harbor'
import { buildHfDataset } from './release/hf-dataset'
import { assertMinted, gateGamedOutcome, type MintedRolloutLine, type RolloutLine } from './schema'

// ---------------------------------------------------------------------------
// Taint. Every reward-derived position on a generated gated line carries one of
// these; nothing else in the package produces them, so finding one in an
// exported row NAMES the leaking path instead of merely failing.
// ---------------------------------------------------------------------------

/** Positive numbers planted in reward-derived positions. Includes the denormal
 *  (smallest positive double) and Infinity, the two a `> 0` test is most likely
 *  to be written wrongly around. */
const POISON_NUMBERS: readonly number[] = [
  0.8675309,
  42.1337,
  5e-324,
  Number.MAX_SAFE_INTEGER,
  Number.POSITIVE_INFINITY,
]

/** The same magnitudes as STRINGS. A producer that JSON-stringifies its numbers
 *  (or reads them off a CSV) hands these to the published exporters, and every
 *  one of them is `>= 1` or `> 0` under JavaScript's coercion. */
const POISON_NUMERIC_STRINGS: readonly string[] = ['0.8675309', '42.1337', '2', '  7  ']

/** Planted in verdict/metrics text positions. */
const POISON_MARKER = 'POISONED_BY_A_GATED_RUN'

interface Leak {
  path: string
  value: unknown
  why: string
}

const isPoisonNumber = (value: number): boolean =>
  POISON_NUMBERS.some((p) => Object.is(p, value) || p === value)

/**
 * Every planted value reachable in `value`, with its path.
 *
 * Walks the in-memory object rather than its JSON, deliberately: `JSON.stringify`
 * turns `Infinity` and `NaN` into `null`, so scanning the serialized form would
 * hide exactly the numbers a `> 0` test is most likely to mishandle.
 */
function findPlantedLeaks(value: unknown, path = '$', out: Leak[] = []): Leak[] {
  if (value === null || value === undefined) return out
  if (typeof value === 'number') {
    if (isPoisonNumber(value)) {
      out.push({ path, value, why: 'reward-derived number planted on a gated line' })
    }
    return out
  }
  if (typeof value === 'string') {
    if (POISON_NUMERIC_STRINGS.includes(value)) {
      out.push({ path, value, why: 'reward-derived numeric STRING planted on a gated line' })
    } else if (value.includes(POISON_MARKER)) {
      out.push({ path, value, why: 'gated verdict text planted on a gated line' })
    }
    return out
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => {
      findPlantedLeaks(item, `${path}[${i}]`, out)
    })
    return out
  }
  if (typeof value === 'object') {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      findPlantedLeaks(item, `${path}.${key}`, out)
    }
  }
  return out
}

/** Keys whose value IS a training signal in one of the emitted shapes. */
const REWARD_KEYS = new Set([
  'reward',
  'rewards',
  'chosenReward',
  'rejectedReward',
  'meanReward',
  'margin',
  'marginScore',
  'score',
  'mean',
  'max',
])

/** Read a value the way a downstream consumer would: numbers and numeric strings alike. */
function asConsumerNumber(value: unknown): number | null {
  if (typeof value === 'number') return value
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value)
    return Number.isNaN(n) ? null : n
  }
  return null
}

/**
 * Any reward-named key holding a positive value.
 *
 * The planted scan catches a value copied through verbatim; this one catches a
 * value COMPUTED from it (a group mean, a margin), which arrives as a number
 * that was never planted. Only sound on an all-gated corpus, where every
 * legitimate training signal is 0 or absent by construction — which is why the
 * containment property generates exactly that.
 */
function findPositiveRewardKeys(value: unknown, path = '$', out: Leak[] = []): Leak[] {
  if (value === null || value === undefined || typeof value !== 'object') return out
  if (Array.isArray(value)) {
    value.forEach((item, i) => {
      findPositiveRewardKeys(item, `${path}[${i}]`, out)
    })
    return out
  }
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const child = `${path}.${key}`
    if (REWARD_KEYS.has(key)) {
      const scalars = Array.isArray(item) ? item : [item]
      scalars.forEach((scalar, i) => {
        const n = asConsumerNumber(scalar)
        if (n !== null && n > 0) {
          out.push({
            path: Array.isArray(item) ? `${child}[${i}]` : child,
            value: scalar,
            why: 'positive value under a reward-named key, on a corpus where every line is gated',
          })
        }
      })
    }
    findPositiveRewardKeys(item, child, out)
  }
  return out
}

/**
 * The ONE path a planted value is allowed to survive at.
 *
 * `provenance.gated_evidence` is where the gate PUTS what it took off the
 * outcome, and the `raw` release config is the audit dump those diagnostics
 * exist for — see the same exclusion in `releaseRowRefs.raw`. Flagging it would
 * make the property fail on the gate working correctly.
 *
 * Stated as one named predicate rather than folded into the walkers, because an
 * exclusion is the one thing in a leak detector that must stay visible: widen it
 * and the property quietly stops testing. Nothing else is exempt.
 */
const isRelocatedEvidence = (leak: Leak): boolean => leak.path.includes('gated_evidence')

const allLeaks = (value: unknown): Leak[] =>
  [...findPlantedLeaks(value), ...findPositiveRewardKeys(value)].filter(
    (leak) => !isRelocatedEvidence(leak),
  )

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/** 0 · positive · negative · denormal · Infinity · NaN · numeric strings · wrong type · absent. */
const rewardArb = fc.oneof(
  fc.constant(0),
  fc.constant(-0),
  fc.constant(null),
  fc.constant(-1),
  fc.constant(Number.NaN),
  fc.constant(Number.NEGATIVE_INFINITY),
  fc.constantFrom(...POISON_NUMBERS),
  fc.constantFrom(...POISON_NUMERIC_STRINGS),
  fc.constant(true),
  fc.constant(undefined),
  fc.constant({ value: 42.1337 }),
)

const poisonLeafArb = fc.oneof(
  fc.constantFrom(...POISON_NUMBERS),
  fc.constantFrom(...POISON_NUMERIC_STRINGS),
  fc.constant(POISON_MARKER),
  fc.constant(true),
  fc.constant(null),
)

/** empty · arbitrary keys AND values · nested · non-object types. */
const metricsArb = fc.oneof(
  fc.constant({}),
  fc.dictionary(fc.string({ minLength: 1, maxLength: 10 }), poisonLeafArb, { maxKeys: 4 }),
  fc.constant({ 'layer.tests': 42.1337, 'layer.lint': 0.8675309 }),
  fc.constant({ nested: { deep: { score: 42.1337 } } }),
  fc.constantFrom(...POISON_NUMBERS),
  fc.constantFrom(...POISON_NUMERIC_STRINGS),
  fc.constant(true),
  fc.constant(null),
  fc.constant(undefined),
  fc.array(fc.constantFrom(...POISON_NUMBERS), { maxLength: 3 }),
)

/** null · populated · arbitrary shapes. */
const verdictArb = fc.oneof(
  fc.constant(null),
  fc.constant(undefined),
  fc.constant({ resolved: true, score: 42.1337 }),
  fc.constant({ notes: POISON_MARKER }),
  fc.constantFrom(...POISON_NUMBERS),
  fc.constant(POISON_MARKER),
  fc.array(fc.constantFrom(...POISON_NUMBERS), { maxLength: 3 }),
)

/** true · false · absent · wrong type. */
const realnessScreenedArb = fc.constantFrom(true, false, undefined, null, 'yes', 1)

const cleanStepArb = fc.record({
  kind: fc.constantFrom('tool', 'llm'),
  name: fc.constantFrom('edit', 'chat'),
  durationMs: fc.constant(12),
})

/** A step carrying a PER-STEP REWARD — the fourth signal the invariant names. */
const rewardingStepArb = fc.record({
  kind: fc.constantFrom('tool', 'llm'),
  name: fc.constantFrom('edit', 'chat'),
  reward: fc.constantFrom(...POISON_NUMBERS),
})

/** absent · empty · populated with per-step rewards · at the mint cap. */
const stepsArb = fc.oneof(
  fc.constant(undefined),
  fc.constant([]),
  fc.array(cleanStepArb, { minLength: 1, maxLength: 3 }),
  fc.array(rewardingStepArb, { minLength: 1, maxLength: 4 }),
)

interface OutcomeDraft {
  reward: unknown
  metrics: unknown
  verdict: unknown
  realness_screened: unknown
}

const outcomeDraftArb: fc.Arbitrary<OutcomeDraft> = fc.record({
  reward: rewardArb,
  metrics: metricsArb,
  verdict: verdictArb,
  realness_screened: realnessScreenedArb,
})

/**
 * One invocation. `gated` decides the realness verdict; the reward-derived
 * positions are poisoned either way, so an ungated sibling in the same episode
 * is a realistic neighbour rather than a blank.
 */
function draftLine(args: {
  rolloutId: string
  runId: string
  parentRolloutId: string | null
  instanceId: string
  gated: boolean
  draft: OutcomeDraft
  steps: unknown
}): RolloutLine {
  const base = malformedRolloutLine()
  return {
    ...base,
    rollout_id: args.rolloutId,
    run_id: args.runId,
    parent_rollout_id: args.parentRolloutId,
    role: args.parentRolloutId === null ? 'supervisor' : 'worker',
    task: { ...base.task, instance_id: args.instanceId, split: 'search' },
    ...(args.steps === undefined ? {} : { steps: args.steps as RolloutLine['steps'] }),
    outcome: {
      ...base.outcome,
      reward: args.draft.reward as number | null,
      reward_source: 'property/judge',
      metrics: args.draft.metrics as Record<string, unknown>,
      verdict: args.draft.verdict,
      realness_gated: args.gated,
      realness_screened: args.draft.realness_screened as boolean | undefined,
    },
  }
}

/**
 * An EPISODE: one root invocation plus workers, ALL SHARING ONE `run_id`, in
 * arbitrary order.
 *
 * Generated by construction rather than left to chance — this is the exact
 * corpus shape leak 1 needed (`supervisorRunRolloutLines` emits precisely it),
 * and a generator that only ever produced one line per run would have missed
 * that bug just as thoroughly as the example-based fixtures did.
 */
function episodeArb(options: { gated: fc.Arbitrary<boolean>; episodes: number }) {
  return fc
    .array(
      fc.record({
        workers: fc.integer({ min: 0, max: 2 }),
        rootGated: options.gated,
        workerGated: fc.array(options.gated, { minLength: 2, maxLength: 2 }),
        drafts: fc.array(outcomeDraftArb, { minLength: 3, maxLength: 3 }),
        steps: fc.array(stepsArb, { minLength: 3, maxLength: 3 }),
      }),
      { minLength: 1, maxLength: options.episodes },
    )
    .chain((episodes) => {
      const lines: RolloutLine[] = []
      episodes.forEach((episode, e) => {
        const runId = `run-${e}`
        const rootId = `rollout-${e}-root`
        lines.push(
          draftLine({
            rolloutId: rootId,
            runId,
            parentRolloutId: null,
            instanceId: `instance-${e}`,
            gated: episode.rootGated,
            draft: episode.drafts[0]!,
            steps: episode.steps[0],
          }),
        )
        for (let w = 0; w < episode.workers; w++) {
          lines.push(
            draftLine({
              rolloutId: `rollout-${e}-w${w}`,
              runId,
              parentRolloutId: rootId,
              instanceId: `instance-${e}`,
              gated: episode.workerGated[w] ?? episode.rootGated,
              draft: episode.drafts[w + 1] ?? episode.drafts[0]!,
              steps: episode.steps[w + 1],
            }),
          )
        }
      })
      // The permutation is generated, not assumed: order is the property.
      return fc
        .shuffledSubarray(lines, { minLength: lines.length, maxLength: lines.length })
        .map((shuffled) => shuffled as RolloutLine[])
    })
}

/**
 * A corpus plus the ids its line-less artifacts reference.
 *
 * The id pool is drawn from three populations on purpose: a `rollout_id` (which
 * resolves to exactly one invocation), a `run_id` (which is AMBIGUOUS whenever
 * its episode has workers), and an id that exists nowhere. Those are the three
 * answers `resolveInvocation` distinguishes, and the middle one is where leak 1
 * lived.
 */
function corpusArb(options: { gated: fc.Arbitrary<boolean>; episodes: number }) {
  return episodeArb(options).chain((lines) =>
    fc
      .array(
        fc.constantFrom(
          ...lines.map((line) => line.rollout_id),
          ...lines.map((line) => line.run_id),
          'no-such-id',
        ),
        { minLength: 2, maxLength: 2 },
      )
      .map((ids) => ({ lines, ids })),
  )
}

function preferenceTripleOf(chosenRunId: string, rejectedRunId: string): PreferenceTriple {
  return {
    scenarioId: 'instance-0',
    chosenRunId,
    rejectedRunId,
    chosenVariantId: 'A',
    rejectedVariantId: 'B',
    marginScore: 42.1337,
    meta: {
      chosenPromptHash: 'hash-chosen',
      rejectedPromptHash: 'hash-rejected',
      chosenConfigHash: 'cfg-a',
      rejectedConfigHash: 'cfg-b',
      chosenModel: 'glm-5.2',
      rejectedModel: 'glm-4.6',
    },
  }
}

function prmTripleOf(prefixRunId: string, rejectedRunId: string): PrmTrainingTriple {
  return {
    prefixRunId,
    prefixStepIndex: 0,
    chosenSpanId: 'span-a',
    chosenReward: 42.1337,
    rejectedSpanId: 'span-b',
    rejectedReward: 0.8675309,
    rejectedRunId,
    marginScore: 42.1337,
  }
}

function stepRewardOf(runId: string): StepReward {
  return {
    spanId: 'span-a',
    runId,
    stepIndex: 0,
    kind: 'tool',
    name: 'edit',
    reward: 42.1337,
    determinism: 'deterministic',
    weight: 42.1337,
  }
}

// ---------------------------------------------------------------------------
// The exporter registry — TOTAL over `EXPORTER_IDS`.
// ---------------------------------------------------------------------------

/**
 * Every exporter that can put a number on the wire. Total map below, so adding
 * an id without a probe does not compile and a probe cannot be quietly dropped.
 */
const EXPORTER_IDS = [
  'waist/toSftRows',
  'waist/toRewardRows',
  'waist/toVerifiersRolloutOutputs',
  'waist/toRftItems',
  'rl/toGrpoRows',
  'rl/toSftRows',
  'rl/toDpoRows',
  'rl/toPrmRows',
  'rl/stepRewardsToJsonl',
  'rl/toTRLFormat',
  'rl/toAnthropicFormat',
  'rl/buildRlDataset',
  'release/buildHfDataset',
] as const

type ExporterId = (typeof EXPORTER_IDS)[number]

interface ExportInput {
  lines: MintedRolloutLine[]
  triples: PreferenceTriple[]
  prmTriples: PrmTrainingTriple[]
  stepRewards: StepReward[]
  /** Set only for the filesystem probes; see `NEEDS_FS`. */
  dir?: string
}

interface ExporterProbe {
  /** True when the probe writes to disk, so the properties can budget it separately. */
  needsFs: boolean
  run: (input: ExportInput) => Promise<unknown>
}

const LOOKUPS = {
  promptOf: () => 'PROMPT-TEXT',
  completionOf: () => 'COMPLETION-TEXT',
  stepTextOf: () => 'STEP-TEXT',
}

const DATASET_CONFIG: RlDatasetConfig = {
  name: 'property-corpus',
  version: '0.0.1',
  domain: 'property',
  license: 'MIT',
  reward: { kind: 'deterministic', source: 'property/judge', description: 'generated' },
  intendedUse: 'property test',
  outOfScope: 'everything',
  limitations: 'generated',
  createdAtIso: '2026-07-24T00:00:00.000Z',
  // GRPO only: it is the one format whose line path legitimately EMITS gated
  // rows (at reward 0) — the most leak-prone surface, and the one that keeps
  // the bundle probe emitting on an all-gated corpus. `requireRows` fails the
  // build loudly for a requested format with no trainable rows (sft/dpo on an
  // all-gated corpus), which is refusal-at-the-door — separately pinned in
  // reward-invariant.test.ts, but it would starve this probe's coverage.
  formats: ['grpo'],
}

const EXPORTERS: { readonly [K in ExporterId]: ExporterProbe } = {
  'waist/toSftRows': {
    needsFs: false,
    run: async (i) =>
      // The widest legitimate surface: no quality floor, held-out admitted —
      // the leak detector wants MORE rows out, and the gate must still hold.
      toWaistSftRows(i.lines, {
        minimumQualityExclusive: Number.MIN_SAFE_INTEGER,
        allowHeldOutTrainingData: true,
      }),
  },
  'waist/toRewardRows': { needsFs: false, run: async (i) => toRewardRows(i.lines) },
  'waist/toVerifiersRolloutOutputs': {
    needsFs: false,
    run: async (i) => toVerifiersRolloutOutputs(i.lines),
  },
  'waist/toRftItems': { needsFs: false, run: async (i) => toRftItems(i.lines) },
  'rl/toGrpoRows': { needsFs: false, run: (i) => toGrpoRows(i.lines, LOOKUPS) },
  'rl/toSftRows': { needsFs: false, run: (i) => toRlSftRows(i.lines, LOOKUPS) },
  'rl/toDpoRows': {
    needsFs: false,
    run: (i) => toDpoRows(i.triples, LOOKUPS, { lines: i.lines }),
  },
  'rl/toPrmRows': {
    needsFs: false,
    run: (i) => toPrmRows(i.prmTriples, LOOKUPS, { lines: i.lines }),
  },
  'rl/stepRewardsToJsonl': {
    needsFs: false,
    run: async (i) => stepRewardsToJsonl(i.stepRewards, { lines: i.lines }),
  },
  'rl/toTRLFormat': {
    needsFs: false,
    run: async (i) => toTRLFormat(i.triples, () => 'PROMPT-TEXT', { lines: i.lines }),
  },
  'rl/toAnthropicFormat': {
    needsFs: false,
    run: async (i) => toAnthropicFormat(i.triples, { lines: i.lines }),
  },
  'rl/buildRlDataset': {
    needsFs: false,
    run: (i) =>
      buildRlDataset(i.lines, LOOKUPS, DATASET_CONFIG, {
        triples: i.triples,
        lookups: LOOKUPS,
      }),
  },
  'release/buildHfDataset': {
    needsFs: true,
    run: async (i) => {
      const ledger = join(i.dir as string, 'ledger.jsonl')
      await writeFile(ledger, `${i.lines.map((line) => JSON.stringify(line)).join('\n')}\n`)
      const summary = await buildHfDataset([ledger], {
        out: join(i.dir as string, 'out'),
        formats: ['sft', 'verifiers', 'rft', 'raw'],
        includeProposers: true,
      })
      return summary
    },
  },
}

const MEMORY_EXPORTERS = EXPORTER_IDS.filter((id) => !EXPORTERS[id].needsFs)
const FS_EXPORTERS = EXPORTER_IDS.filter((id) => EXPORTERS[id].needsFs)

type ProbeResult = { kind: 'threw'; message: string } | { kind: 'ok'; output: unknown }

async function runProbe(id: ExporterId, input: ExportInput): Promise<ProbeResult> {
  try {
    return { kind: 'ok', output: await EXPORTERS[id].run(input) }
  } catch (error) {
    return { kind: 'threw', message: (error as Error).message }
  }
}

/** Build the line-less artifacts a corpus implies, referencing generated ids. */
function artifactsFor(ids: readonly string[]): Omit<ExportInput, 'lines' | 'dir'> {
  const [a = 'no-such-id', b = 'no-such-id'] = ids
  return {
    triples: [preferenceTripleOf(a, b)],
    prmTriples: [prmTripleOf(a, b)],
    stepRewards: [stepRewardOf(a)],
  }
}

/** Mint every line, reporting refusal rather than throwing — refusal at the door
 *  is a PASS for the containment property, and how often it happens is data. */
function mintAll(lines: readonly RolloutLine[]): { minted: MintedRolloutLine[]; refused: number } {
  const minted: MintedRolloutLine[] = []
  let refused = 0
  for (const line of lines) {
    try {
      minted.push(assertMinted(line, 'property line'))
    } catch {
      refused++
    }
  }
  return { minted, refused }
}

/** The raw door: what a plain-JavaScript caller of the published package hands
 *  an exporter. The cast lives in the TEST because that caller has no types at
 *  all — it is precisely the population `assertRewardGate` was written for. */
const asRawMinted = (lines: readonly RolloutLine[]): MintedRolloutLine[] =>
  lines as unknown as MintedRolloutLine[]

// ---------------------------------------------------------------------------
// Coverage — a property that never reaches the code it is about proves nothing.
// ---------------------------------------------------------------------------

interface Coverage {
  cases: number
  mintedLines: number
  refusedLines: number
  /** Exporter runs that produced output (as opposed to throwing). */
  emitted: Map<ExporterId, number>
  threw: Map<ExporterId, number>
}

const newCoverage = (): Coverage => ({
  cases: 0,
  mintedLines: 0,
  refusedLines: 0,
  emitted: new Map(),
  threw: new Map(),
})

function record(coverage: Coverage, id: ExporterId, result: ProbeResult): void {
  const bucket = result.kind === 'ok' ? coverage.emitted : coverage.threw
  bucket.set(id, (bucket.get(id) ?? 0) + 1)
}

const describeLeaks = (leaks: Leak[]): string =>
  leaks.map((l) => `${l.path} = ${JSON.stringify(l.value)} — ${l.why}`).join('\n')

// ---------------------------------------------------------------------------
// PROPERTY 1 — containment
// ---------------------------------------------------------------------------

/**
 * Cases per property. 1000 is the floor these ship at; `GATE_PROPERTY_RUNS`
 * raises it (a nightly job can run 100k for free) or lowers it while iterating.
 * fast-check re-seeds every run, so the corpus is different each CI execution —
 * the suite keeps searching after it is written, which is the whole point of
 * replacing a hand adversary with a generator.
 */
const CASES = Number(process.env.GATE_PROPERTY_RUNS ?? 1000)

describe('PROPERTY: a gated run contributes no positive signal to any exporter', () => {
  it(`holds over ${CASES} generated all-gated corpora, through BOTH the minted and the raw door`, async () => {
    const coverage = newCoverage()

    await fc.assert(
      fc.asyncProperty(
        corpusArb({ gated: fc.constant(true), episodes: 3 }),
        async ({ lines, ids }) => {
          coverage.cases++
          const artifacts = artifactsFor(ids)

          const { minted, refused } = mintAll(lines)
          coverage.mintedLines += minted.length
          coverage.refusedLines += refused

          /**
           * Every corpus each door must be clean over: the whole batch, AND each
           * line on its own.
           *
           * The per-line pass is not redundant. The exporters check every line
           * before emitting any row, so ONE line that correctly throws aborts
           * the call and the property never inspects the output the OTHER lines
           * would have produced. With three generated lines per case, a leak
           * needs its siblings to be simultaneously clean to be visible at all —
           * which is exactly the conjunction that let a reverted fix survive 400
           * cases. Isolating each line removes the masking.
           */
          const corpora: MintedRolloutLine[][] = [minted, ...minted.map((line) => [line])]
          const rawCorpora: RolloutLine[][] = [lines, ...lines.map((line) => [line])]

          // Door 1: the minted path. Anything mint admitted must export clean.
          for (const id of MEMORY_EXPORTERS) {
            for (const corpus of corpora) {
              const result = await runProbe(id, { lines: corpus, ...artifacts })
              record(coverage, id, result)
              if (result.kind === 'threw') continue
              const leaks = allLeaks(result.output)
              if (leaks.length > 0) {
                throw new Error(
                  `MINTED DOOR — ${id} emitted a gated run's signal:\n${describeLeaks(leaks)}\n` +
                    `output: ${JSON.stringify(result.output)?.slice(0, 900)}`,
                )
              }
            }
          }

          // Door 2: the raw path — an object literal from a JavaScript caller,
          // which reaches only `assertRewardGate`. Throwing is the correct
          // answer; emitting a planted value is the leak.
          for (const id of MEMORY_EXPORTERS) {
            for (const corpus of rawCorpora) {
              const result = await runProbe(id, { lines: asRawMinted(corpus), ...artifacts })
              if (result.kind === 'threw') continue
              const leaks = allLeaks(result.output)
              if (leaks.length > 0) {
                throw new Error(
                  `RAW DOOR — ${id} emitted a gated run's signal:\n${describeLeaks(leaks)}\n` +
                    `line: ${JSON.stringify(corpus[0])?.slice(0, 900)}`,
                )
              }
            }
          }
        },
      ),
      { numRuns: CASES },
    )

    // Calibration: the property must actually have reached the exporters.
    expect(coverage.cases).toBe(CASES)
    expect(coverage.mintedLines).toBeGreaterThan(0)
    expect(coverage.refusedLines).toBeGreaterThan(0)
    for (const id of MEMORY_EXPORTERS) {
      expect(
        coverage.emitted.get(id) ?? 0,
        `${id} never produced output across ${CASES} cases — the property never reached it`,
      ).toBeGreaterThan(0)
    }
  }, 240_000)
})

// ---------------------------------------------------------------------------
// PROPERTY 2 — order independence
// ---------------------------------------------------------------------------

/** A JSONL payload, split and sorted — several exporters return their rows as a
 *  serialized string, where deep-sorting the object graph cannot reach them. */
function canonicalJsonl(value: string): string | null {
  const lines = value.split('\n').filter((line) => line !== '')
  if (lines.length === 0) return null
  const parsed: unknown[] = []
  for (const line of lines) {
    try {
      parsed.push(JSON.parse(line))
    } catch {
      return null
    }
  }
  return JSON.stringify(canonical(parsed))
}

/** Deep-sort arrays so two runs are compared as CONTENT, not as sequence: an
 *  exporter that maps over its input legitimately emits rows in input order. */
function canonical(value: unknown): unknown {
  if (typeof value === 'string') return canonicalJsonl(value) ?? value
  if (Array.isArray(value)) {
    return value
      .map(canonical)
      .sort((a, b) => (JSON.stringify(a) ?? '').localeCompare(JSON.stringify(b) ?? ''))
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonical(v)]),
    )
  }
  return typeof value === 'number' && !Number.isFinite(value) ? String(value) : value
}

describe('PROPERTY: exporter output does not depend on input order', () => {
  it(`holds over ${CASES} generated corpora with mixed gated/ungated siblings sharing a run_id`, async () => {
    let cases = 0
    await fc.assert(
      fc.asyncProperty(
        corpusArb({ gated: fc.boolean(), episodes: 3 }),
        fc.integer({ min: 1, max: 997 }),
        async ({ lines, ids }, rotation) => {
          cases++
          const { minted } = mintAll(lines)
          if (minted.length < 2) return

          // Reference an AMBIGUOUS run_id whenever the corpus holds one. Leak 1
          // needed a gated and an ungated invocation under one `run_id`, and a
          // pool that only sometimes names such an id makes the whole property
          // depend on luck: with plain generated ids the reverted last-wins
          // lookup survived 300 cases.
          const byRun = new Map<string, number>()
          for (const line of minted) byRun.set(line.run_id, (byRun.get(line.run_id) ?? 0) + 1)
          const shared = [...byRun.entries()].filter(([, n]) => n > 1).map(([id]) => id)
          const artifacts = artifactsFor(shared.length > 0 ? [shared[0]!, shared[0]!] : ids)

          const offset = rotation % minted.length
          // BOTH alternative orders. A rotation moves the split point, so two
          // lines keep their relative order unless it falls between them;
          // reversal flips EVERY pair, which is what a last-wins lookup needs
          // to be caught reliably.
          const reordered: Array<[string, MintedRolloutLine[]]> = [
            ['rotated', [...minted.slice(offset), ...minted.slice(0, offset)]],
            ['reversed', [...minted].reverse()],
          ]

          for (const id of MEMORY_EXPORTERS) {
            const a = await runProbe(id, { lines: minted, ...artifacts })
            for (const [how, lineOrder] of reordered) {
              const b = await runProbe(id, { lines: lineOrder, ...artifacts })
              if (a.kind !== b.kind) {
                throw new Error(
                  `${id}: ${how} the SAME lines changed whether it threw — ` +
                    `${a.kind === 'threw' ? a.message : 'ok'} vs ${b.kind === 'threw' ? b.message : 'ok'}`,
                )
              }
              if (a.kind === 'threw' || b.kind === 'threw') continue
              const ca = JSON.stringify(canonical(a.output))
              const cb = JSON.stringify(canonical(b.output))
              if (ca !== cb) {
                // Report the first DIFFERING position: two large outputs that
                // share a long prefix print identical-looking excerpts otherwise.
                let at = 0
                while (at < (ca?.length ?? 0) && ca?.[at] === cb?.[at]) at++
                const from = Math.max(0, at - 120)
                throw new Error(
                  `${id}: output changed when the lines were ${how}, first at char ${at}.\n` +
                    `A: …${ca?.slice(from, at + 200)}\nB: …${cb?.slice(from, at + 200)}`,
                )
              }
            }
          }
        },
      ),
      { numRuns: CASES },
    )
    expect(cases).toBe(CASES)
  }, 240_000)
})

// ---------------------------------------------------------------------------
// PROPERTY 3 — idempotence
// ---------------------------------------------------------------------------

describe('PROPERTY: the gating transform is idempotent', () => {
  it(`holds over ${CASES} generated lines, for gateGamedOutcome and assertMinted`, () => {
    let applied = 0
    fc.assert(
      fc.property(episodeArb({ gated: fc.boolean(), episodes: 2 }), (lines) => {
        for (const line of lines) {
          // Relocation must not re-relocate, and must not accrete evidence.
          const once = gateGamedOutcome(line)
          const twice = gateGamedOutcome(once)
          expect(JSON.stringify(twice)).toBe(JSON.stringify(once))

          let minted: MintedRolloutLine
          try {
            minted = assertMinted(line, 'idempotence')
          } catch {
            continue
          }
          applied++
          expect(JSON.stringify(assertMinted(minted, 'idempotence'))).toBe(JSON.stringify(minted))
        }
      }),
      { numRuns: CASES },
    )
    expect(applied).toBeGreaterThan(0)
  }, 240_000)

  it(`holds over ${CASES} generated episodes across repeated Harbor round-trips`, () => {
    let tripped = 0
    fc.assert(
      // One episode = one ATIF tree; `toHarborTrajectory` is one tree per document.
      fc.property(episodeArb({ gated: fc.boolean(), episodes: 1 }), (lines) => {
        const { minted } = mintAll(lines)
        if (minted.length === 0) return
        // The PLURAL export: minting can refuse an episode's root and leave
        // its workers behind, which is a legitimate multi-root corpus and the
        // case `toHarborTrajectory` explicitly refuses.
        const trip = (input: RolloutLine[]): RolloutLine[] =>
          toHarborTrajectories(input)
            .flatMap((tree) => fromHarborTrajectory(tree))
            .map((line) => assertMinted(line, 'harbor'))
        // Round 3 found `provenance.gap` accreting one clause per trip, so the
        // THIRD trip is what proves it stopped rather than merely slowed.
        const one = trip(minted)
        const two = trip(one)
        const three = trip(two)
        tripped++
        expect(two.map((l) => l.provenance.gap)).toEqual(three.map((l) => l.provenance.gap))
        expect(JSON.stringify(canonical(three))).toBe(JSON.stringify(canonical(two)))
      }),
      { numRuns: CASES },
    )
    expect(tripped).toBeGreaterThan(0)
  }, 240_000)
})

// ---------------------------------------------------------------------------
// PROPERTY 4 — the published filesystem release path
// ---------------------------------------------------------------------------

describe('PROPERTY: the published release path ships no gated signal', () => {
  it(`holds over ${CASES} generated all-gated ledgers through buildHfDataset, checked on the BYTES WRITTEN`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'gate-prop-'))
    let attempted = 0
    let built = 0
    let filesScanned = 0
    try {
      await fc.assert(
        fc.asyncProperty(episodeArb({ gated: fc.constant(true), episodes: 2 }), async (lines) => {
          const dir = join(root, `case-${attempted++}`)
          const { minted } = mintAll(lines)
          if (minted.length === 0) return
          await mkdir(dir, { recursive: true })
          for (const id of FS_EXPORTERS) {
            const result = await runProbe(id, { lines: minted, ...artifactsFor([]), dir })
            if (result.kind === 'threw') continue
            built++
            const leaks = allLeaks(result.output)
            if (leaks.length > 0) {
              throw new Error(`${id} summary leaked:\n${describeLeaks(leaks)}`)
            }
            // The summary is a claim ABOUT the release; the files are the
            // release. A card that certifies clean over bytes nobody read is
            // the exact failure `gate-report.ts` was written for, so the
            // property reads every byte the build actually wrote.
            for (const file of (result.output as { files: string[] }).files) {
              const text = await readFile(file, 'utf8')
              filesScanned++
              const rows = text
                .split('\n')
                .filter((l) => l !== '')
                .flatMap((l) => {
                  try {
                    return [JSON.parse(l)]
                  } catch {
                    return []
                  }
                })
              const fileLeaks = [
                ...findPlantedLeaks(rows, file),
                ...findPositiveRewardKeys(rows, file),
              ].filter((leak) => !isRelocatedEvidence(leak))
              if (fileLeaks.length > 0) {
                throw new Error(`${id} WROTE a gated run's signal:\n${describeLeaks(fileLeaks)}`)
              }
            }
          }
        }),
        { numRuns: CASES },
      )
      // Calibration: a filesystem property that never built anything, or built
      // without writing, would pass forever.
      expect(built, 'buildHfDataset never completed a single generated case').toBeGreaterThan(0)
      expect(filesScanned, 'no released file was ever read back').toBeGreaterThan(0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 240_000)
})
