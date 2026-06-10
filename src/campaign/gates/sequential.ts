/**
 * @experimental
 *
 * Anytime-valid sequential promotion gate — an e-process (betting
 * test-martingale, see `eProcess` in `statistics.ts`) over paired
 * per-scenario deltas, so a campaign stops the MOMENT evidence decides
 * instead of burning a fixed-n budget. Decisions remain valid at any
 * data-dependent stopping time (Ville's inequality), which is exactly what
 * fixed-n machinery cannot offer: peeking at a bootstrap CI after every
 * observation and stopping on the first significant peek inflates type-I
 * error far beyond alpha.
 *
 * REPLACES, never layers on, a fixed-n gate. Running `heldoutSignificance`
 * or `paretoSignificanceGate` repeatedly on a growing sample and stopping
 * early is optional stopping no matter how it is dressed up; this gate is
 * the valid way to stop early. Use one or the other per evidence stream.
 *
 * Pre-registration binding: anytime validity holds only for the
 * PRE-REGISTERED statistic. When a `SignedManifest` is bound, the gate takes
 * alpha from `manifest.alpha`, the observation budget from
 * `manifest.preRegisteredN`, orients deltas by `manifest.direction`, and
 * shifts the null boundary by `manifest.minEffect` — re-deciding the same
 * stream under different parameters after seeing data would reopen optional
 * stopping under a fancier name. The manifest's content hash is verified at
 * construction (sync, same `sha256-content` scheme as `signManifest`).
 *
 * Non-iid caveat (stated honestly): the supermartingale guarantee needs each
 * delta's conditional mean under H0 to stay ≤ the null boundary given the
 * past — exchangeable scenario deltas suffice. Scenario streams ordered by
 * difficulty or by scenario family violate this; `decide(ctx)` therefore
 * shuffles the paired deltas with a SEEDED permutation by default (the
 * permutation is data-independent, so bet predictability is preserved).
 * Stratified betting (per-stratum λ) is future work, not implemented here.
 */

import { createHash } from 'node:crypto'
import { canonicalize, type SignedManifest } from '../../pre-registration'
import { type EProcessState, eProcess, mulberry32 } from '../../statistics'
import type { Gate, GateContext, GateResult, GenerationRecord, Scenario } from '../types'
import { pairHoldout } from './statistical-heldout'

export type SequentialDecision = 'promote' | 'continue' | 'undecided-at-maxN'

export interface SequentialObservation {
  decision: SequentialDecision
  /** Current e-value (the betting wealth) against H0. */
  eValue: number
  /** Paired deltas consumed so far. */
  n: number
  /** Names the decision basis. For 'undecided-at-maxN' it states explicitly
   *  that exhausting the budget is NOT evidence of no effect. */
  reason: string
}

export interface SequentialPairedGateOptions {
  /** Type-I budget. With `preRegistration` bound this MUST match
   *  `manifest.alpha` (conflict throws). Default 0.05. */
  alpha?: number
  /** Minimum paired deltas before a promote may fire. The stopping rule is
   *  "first n ≥ minN with e-value ≥ 1/alpha" — still a valid stopping time.
   *  Default 5. */
  minN?: number
  /** Pre-registered observation budget. Required unless `preRegistration`
   *  supplies it via `preRegisteredN` (conflict throws). */
  maxN?: number
  /** Bet truncation forwarded to `eProcess`. Default 0.5. */
  maxBet?: number
  /** Bound on |delta| in the judge's native scale; deltas are mapped to
   *  x = (d/scale + 1)/2 ∈ [0,1]. A delta outside ±scale throws (use
   *  `detectScale` to pick 1 vs 100 BEFORE streaming). Default 1. */
  scale?: number
  /** Seed for the data-independent shuffle of paired deltas in `decide(ctx)`
   *  (exchangeability guard). Default 1337. */
  shuffleSeed?: number
  /** Bind the pre-registered hypothesis. Verified (content hash) at
   *  construction; alpha/maxN/direction/minEffect come FROM the manifest. */
  preRegistration?: SignedManifest
  /** Override the gate name in reports. */
  name?: string
}

export interface SequentialPairedGate<TArtifact = unknown, TScenario extends Scenario = Scenario>
  extends Gate<TArtifact, TScenario> {
  /** Streaming entry point: feed one paired per-scenario delta
   *  (candidate − baseline, native scale). Each gate instance carries ONE
   *  observe-stream; `decide(ctx)` runs on its own fresh stream and never
   *  consumes or advances this one. 'promote' is sticky; observing past the
   *  pre-registered maxN throws (extending a finished stream after seeing
   *  the result reopens optional stopping — start a NEW pre-registered
   *  test). */
  observe(delta: number): SequentialObservation
  /** Read-only snapshot of the observe-stream. */
  state(): EProcessState & { decision: SequentialDecision }
}

interface ResolvedConfig {
  alpha: number
  minN: number
  maxN: number
  maxBet: number
  scale: number
  shuffleSeed: number
  /** 'decrease' negates deltas so "better" is always positive. */
  direction: 'increase' | 'decrease'
  /** H0 boundary in x-space: 1/2 + minEffect/(2·scale). */
  nullMean: number
  minEffect: number
}

/** Sync twin of `verifyManifest` — same `sha256-content` scheme
 *  (sha256 over the canonicalized manifest minus contentHash/algo), via
 *  node:crypto so gate construction can stay synchronous and fail loud
 *  before any observation is consumed. */
function verifyManifestSync(m: SignedManifest): boolean {
  if (m.algo !== undefined && m.algo !== 'sha256-content') {
    throw new Error(`sequentialPairedGate: unrecognized manifest hash algo '${m.algo}'`)
  }
  const { contentHash, algo: _algo, ...rest } = m
  void _algo
  const bytes = JSON.stringify(canonicalize(rest))
  const hash = createHash('sha256').update(bytes, 'utf8').digest('hex')
  return hash === contentHash
}

function resolveConfig(opts: SequentialPairedGateOptions): ResolvedConfig {
  const m = opts.preRegistration
  let alpha: number
  let maxN: number
  let direction: 'increase' | 'decrease'
  let minEffect: number
  if (m) {
    if (!verifyManifestSync(m)) {
      throw new Error(
        `sequentialPairedGate: pre-registration manifest '${m.id}' content hash mismatch (tampered)`,
      )
    }
    if (opts.alpha !== undefined && opts.alpha !== m.alpha) {
      throw new Error(
        `sequentialPairedGate: alpha ${opts.alpha} conflicts with pre-registered alpha ${m.alpha} — ` +
          `the registered statistic is the only one anytime validity covers`,
      )
    }
    if (opts.maxN !== undefined && opts.maxN !== m.preRegisteredN) {
      throw new Error(
        `sequentialPairedGate: maxN ${opts.maxN} conflicts with pre-registered N ${m.preRegisteredN}`,
      )
    }
    alpha = m.alpha
    maxN = m.preRegisteredN
    direction = m.direction
    minEffect = m.minEffect
  } else {
    alpha = opts.alpha ?? 0.05
    if (opts.maxN === undefined) {
      throw new Error(
        'sequentialPairedGate: maxN is required (or bind a preRegistration manifest whose ' +
          'preRegisteredN is the budget) — an unbounded stream has no pre-registered budget',
      )
    }
    maxN = opts.maxN
    direction = 'increase'
    minEffect = 0
  }
  const scale = opts.scale ?? 1
  if (!Number.isFinite(scale) || scale <= 0) {
    throw new Error(`sequentialPairedGate: scale must be > 0, got ${scale}`)
  }
  if (!Number.isInteger(maxN) || maxN < 1) {
    throw new Error(`sequentialPairedGate: maxN must be a positive integer, got ${maxN}`)
  }
  const minN = opts.minN ?? 5
  if (!Number.isInteger(minN) || minN < 1 || minN > maxN) {
    throw new Error(
      `sequentialPairedGate: minN must be an integer in [1, maxN=${maxN}], got ${minN}`,
    )
  }
  if (!Number.isFinite(minEffect) || minEffect < 0 || minEffect >= scale) {
    throw new Error(
      `sequentialPairedGate: minEffect must be in [0, scale=${scale}), got ${minEffect}`,
    )
  }
  // H0: mean delta ≤ minEffect. In x = (d/scale + 1)/2 space that is
  // E[x] ≤ 1/2 + minEffect/(2·scale) — a shifted null boundary, NOT a clamp
  // of the observations (clamping is mean-distorting for skewed deltas).
  const nullMean = 0.5 + minEffect / (2 * scale)
  return {
    alpha,
    minN,
    maxN,
    maxBet: opts.maxBet ?? 0.5,
    scale,
    shuffleSeed: opts.shuffleSeed ?? 1337,
    direction,
    nullMean,
    minEffect,
  }
}

interface SequentialStream {
  observe(delta: number): SequentialObservation
  state(): EProcessState & { decision: SequentialDecision }
}

function makeStream(cfg: ResolvedConfig): SequentialStream {
  const proc = eProcess({ alpha: cfg.alpha, maxBet: cfg.maxBet, nullMean: cfg.nullMean })
  const threshold = 1 / cfg.alpha
  let terminal: SequentialDecision | undefined
  return {
    observe(delta: number): SequentialObservation {
      if (terminal === 'undecided-at-maxN') {
        throw new Error(
          `sequentialPairedGate: pre-registered maxN=${cfg.maxN} exhausted — extending the ` +
            'stream after seeing the result reopens optional stopping; start a NEW ' +
            'pre-registered test',
        )
      }
      if (!Number.isFinite(delta) || Math.abs(delta) > cfg.scale) {
        throw new Error(
          `sequentialPairedGate: delta ${delta} outside ±scale=${cfg.scale} — pass the judge's ` +
            `native scale explicitly (detectScale helps pick 1 vs 100)`,
        )
      }
      const d = cfg.direction === 'decrease' ? -delta : delta
      const step = proc.update((d / cfg.scale + 1) / 2)
      // Stopping rule: FIRST n ≥ minN with current wealth ≥ 1/alpha — a valid
      // stopping time (measurable w.r.t. the past), sticky once latched. The
      // core's own `decided` latch ignores minN, so the gate re-derives the
      // decision from current wealth here.
      if (terminal === undefined && step.n >= cfg.minN && step.wealth >= threshold) {
        terminal = 'promote'
      }
      if (terminal === 'promote') {
        return {
          decision: 'promote',
          eValue: step.wealth,
          n: step.n,
          reason:
            `e-value ${step.wealth.toFixed(2)} ≥ 1/α=${threshold.toFixed(2)} at n=${step.n} ` +
            `(minN=${cfg.minN}): the paired improvement exceeds ${cfg.minEffect} at anytime-valid ` +
            `level α=${cfg.alpha}`,
        }
      }
      if (step.n >= cfg.maxN) {
        terminal = 'undecided-at-maxN'
        return {
          decision: 'undecided-at-maxN',
          eValue: step.wealth,
          n: step.n,
          reason:
            `undecided at pre-registered maxN=${cfg.maxN} (e-value ${step.wealth.toFixed(2)} < ` +
            `1/α=${threshold.toFixed(2)}). This is NOT evidence of no effect — the effect may be ` +
            'real but smaller than this budget can detect; re-register with a larger N to test that',
        }
      }
      return {
        decision: 'continue',
        eValue: step.wealth,
        n: step.n,
        reason: `e-value ${step.wealth.toFixed(2)} < 1/α=${threshold.toFixed(2)} at n=${step.n}/${cfg.maxN} — keep observing`,
      }
    },
    state() {
      return { ...proc.state(), decision: terminal ?? 'continue' }
    },
  }
}

/** Data-independent in-place Fisher–Yates with a seeded PRNG — the permutation
 *  depends only on the seed, never the values, so bet predictability survives. */
function seededShuffle<T>(items: T[], seed: number): T[] {
  const rng = mulberry32(seed)
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    const tmp = items[i]!
    items[i] = items[j]!
    items[j] = tmp
  }
  return items
}

/**
 * Anytime-valid sequential paired gate. Conforms to the existing `Gate`
 * contract (`decide(ctx)` consumes candidate vs baseline judge scores via
 * `pairHoldout` — same pairing granularity as the fixed-n gates: full cellId,
 * never scenarioId) and adds a streaming `observe(delta)` entry for campaigns
 * that score cells incrementally and want to stop mid-stream.
 *
 * Decision mapping onto the substrate's five-valued `GateDecision`:
 *   - 'promote'            → 'ship'
 *   - 'continue'           → 'need_more_work' (stream ended before maxN with
 *                            the e-value undecided — more reps could decide)
 *   - 'undecided-at-maxN'  → 'hold', with the reason stating it is NOT
 *                            evidence of no effect (never a silent default)
 */
export function sequentialPairedGate<TArtifact = unknown, TScenario extends Scenario = Scenario>(
  options: SequentialPairedGateOptions,
): SequentialPairedGate<TArtifact, TScenario> {
  const cfg = resolveConfig(options)
  const name = options.name ?? 'sequentialPairedGate'
  const manifest = options.preRegistration
  const observeStream = makeStream(cfg)

  return {
    name,
    observe(delta: number): SequentialObservation {
      return observeStream.observe(delta)
    },
    state() {
      return observeStream.state()
    },
    async decide(ctx: GateContext<TArtifact, TScenario>): Promise<GateResult> {
      if (!ctx.baselineJudgeScores) {
        throw new Error(
          `${name}: ctx.baselineJudgeScores is required — falling back to the candidate's own ` +
            'scores would compare the candidate against itself (delta 0, silent no-op)',
        )
      }
      const scenarioIds = new Set(ctx.scenarios.map((s) => s.id))
      const paired = pairHoldout(
        ctx.judgeScores,
        ctx.baselineJudgeScores,
        scenarioIds,
        (s) => s.composite,
      )
      const deltas = paired.after.map((a, i) => a - paired.before[i]!)
      seededShuffle(deltas, cfg.shuffleSeed)

      const stream = makeStream(cfg)
      let last: SequentialObservation | undefined
      for (const d of deltas) {
        last = stream.observe(d)
        if (last.decision !== 'continue') break
      }

      const detail = {
        ...stream.state(),
        minN: cfg.minN,
        maxN: cfg.maxN,
        scale: cfg.scale,
        shuffleSeed: cfg.shuffleSeed,
        direction: cfg.direction,
        minEffect: cfg.minEffect,
        pairedN: deltas.length,
        preRegisteredId: manifest?.id,
        metric: manifest?.metric,
      }
      const meanDelta =
        deltas.length === 0 ? undefined : deltas.reduce((s, d) => s + d, 0) / deltas.length

      if (last === undefined) {
        return {
          decision: 'need_more_work',
          reasons: [`${name}: no paired holdout observations — nothing to test`],
          contributingGates: [{ name, passed: false, detail }],
        }
      }
      const decision =
        last.decision === 'promote'
          ? 'ship'
          : last.decision === 'continue'
            ? 'need_more_work'
            : 'hold'
      return {
        decision,
        reasons: [`${name}: ${last.reason}`],
        contributingGates: [{ name, passed: decision === 'ship', detail }],
        delta: meanDelta,
      }
    },
  }
}

export interface SequentialDecideOptions {
  /** Type-I budget for the early-stop evidence. Default 0.05. */
  alpha?: number
  /** Minimum paired deltas before a stop may fire. Default 5. */
  minN?: number
  /** Bet truncation forwarded to `eProcess`. Default 0.5. */
  maxBet?: number
  /** Bound on |per-scenario composite delta|. Default 1. */
  scale?: number
}

export interface SequentialDecideFn {
  (args: { history: GenerationRecord[] }): { stop: boolean; reason?: string }
  /** Read-only snapshot of the accumulated e-process (observability + tests). */
  state(): EProcessState
}

/**
 * `ImprovementDriver.decide` adapter — stops the optimization loop the moment
 * the e-process decides the loop has produced a real improvement, instead of
 * always running `maxGenerations`.
 *
 * Stream: for each generation g ≥ 1, the per-scenario composite deltas of
 * generation g's top candidate vs the generation-0 top candidate (the
 * incumbent the loop set out to beat), paired by scenarioId. H0: no proposed
 * surface improves any scenario's expected composite over the incumbent —
 * under it every delta has conditional mean ≤ 0 and the e-process is valid.
 * Once wealth ≥ 1/alpha the loop stops and hands the winner to the promotion
 * gate (which re-scores on HELD-OUT data — this adapter only spends the
 * exploration budget, it never promotes).
 *
 * Honesty caveats: (1) the incumbent's scores are measured once and shared
 * across all generations' deltas, so type-I control is exact only insofar as
 * those scores approximate the incumbent's true per-scenario means (more reps
 * → tighter); (2) an UNDECIDED process never stops the loop — absence of a
 * crossing is NOT evidence of no effect, so the loop simply runs its normal
 * course. Calling the adapter repeatedly with a growing history consumes each
 * generation exactly once (re-feeding an already-seen record would double-count
 * evidence).
 */
export function sequentialDecide(options: SequentialDecideOptions = {}): SequentialDecideFn {
  const alpha = options.alpha ?? 0.05
  const minN = options.minN ?? 5
  const scale = options.scale ?? 1
  if (!Number.isFinite(scale) || scale <= 0) {
    throw new Error(`sequentialDecide: scale must be > 0, got ${scale}`)
  }
  const proc = eProcess({ alpha, maxBet: options.maxBet ?? 0.5, nullMean: 0.5 })
  const threshold = 1 / alpha
  let processedGenerations = 0
  let reference: Map<string, number> | undefined
  let stopped: { stop: true; reason: string } | undefined

  const topCandidate = (record: GenerationRecord) => {
    if (record.candidates.length === 0) {
      throw new Error(
        `sequentialDecide: generation ${record.generationIndex} has no candidates — ` +
          'cannot extract a top candidate',
      )
    }
    return record.candidates.reduce((best, c) => (c.composite > best.composite ? c : best))
  }

  const decide: SequentialDecideFn = ({ history }) => {
    if (stopped) return stopped
    if (history.length === 0) return { stop: false }
    if (reference === undefined) {
      reference = new Map(
        topCandidate(history[0]!).scenarios.map((s) => [s.scenarioId, s.composite]),
      )
    }
    // Consume only generations not yet seen; start at 1 — generation 0 IS the
    // reference and would contribute all-zero deltas (pure wealth dilution).
    for (let g = Math.max(1, processedGenerations); g < history.length; g++) {
      const top = topCandidate(history[g]!)
      const byScenario = new Map(top.scenarios.map((s) => [s.scenarioId, s.composite]))
      for (const [scenarioId, refComposite] of reference) {
        const candComposite = byScenario.get(scenarioId)
        if (candComposite === undefined) {
          throw new Error(
            `sequentialDecide: generation ${history[g]!.generationIndex} top candidate is missing ` +
              `scenario '${scenarioId}' — generations must score the same scenario set to pair`,
          )
        }
        const delta = candComposite - refComposite
        if (!Number.isFinite(delta) || Math.abs(delta) > scale) {
          throw new Error(
            `sequentialDecide: paired delta ${delta} outside ±scale=${scale} on scenario ` +
              `'${scenarioId}' — pass the composite scale explicitly`,
          )
        }
        const step = proc.update((delta / scale + 1) / 2)
        if (step.n >= minN && step.wealth >= threshold) {
          stopped = {
            stop: true,
            reason:
              `sequential e-process decided at generation ${history[g]!.generationIndex}: ` +
              `e-value ${step.wealth.toFixed(2)} ≥ 1/α=${threshold.toFixed(2)} after n=${step.n} ` +
              'paired deltas vs the generation-0 incumbent — the improvement is real at ' +
              `α=${alpha}; stop exploring and promote via the gate`,
          }
          processedGenerations = history.length
          return stopped
        }
      }
    }
    processedGenerations = history.length
    return { stop: false }
  }
  decide.state = () => proc.state()
  return decide
}
