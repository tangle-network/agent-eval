import { ValidationError } from '../errors'

// ── Anytime-valid e-process (betting test-martingale) ────────────────

export interface EProcessOptions {
  /** Type-I error budget. The process decides when wealth ≥ 1/alpha
   *  (Ville's inequality). Default 0.05. */
  alpha?: number
  /** Truncation bound on the predictable bet λ ∈ [0, maxBet]. Must satisfy
   *  maxBet < 1/nullMean so every wealth factor stays strictly positive.
   *  Default 0.5. */
  maxBet?: number
  /** The null boundary m₀ for H0: E[x] ≤ m₀ on x ∈ [0,1]. Default 0.5
   *  (the paired-delta encoding x = (d+1)/2 maps "no effect" to 1/2).
   *  A pre-registered minEffect shifts this — see `sequentialPairedGate`. */
  nullMean?: number
}

export interface EProcessStep {
  /** Current wealth W_n — the e-value against H0 after n observations. */
  wealth: number
  /** Observations consumed so far. */
  n: number
  /** True from the first n where W_n ≥ 1/alpha onward (sticky). */
  decided: boolean
}

export interface EProcessState extends EProcessStep {
  alpha: number
  maxBet: number
  nullMean: number
  /** The decision boundary 1/alpha. */
  threshold: number
  /** Observation count at the first threshold crossing; undefined until decided. */
  decidedAtN?: number
}

export interface EProcess {
  /** Consume one observation x ∈ [0,1]. Throws on non-finite / out-of-range
   *  input — a silent clamp would corrupt the type-I guarantee. */
  update(x: number): EProcessStep
  state(): EProcessState
}

/**
 * Betting test-martingale for bounded observations — the e-process core of
 * anytime-valid sequential testing (Waudby-Smith & Ramdas, "Estimating means
 * of bounded random variables by betting", JRSS-B 2024).
 *
 * Observations x_i ∈ [0,1]; H0: E[x] ≤ m₀ (`nullMean`, default 1/2). Wealth
 *
 *   W_t = Π_{i≤t} (1 + λ_i (x_i − m₀)),  W_0 = 1
 *
 * with the truncated GROW-style plug-in bet computed from PRIOR observations:
 *
 *   λ_i = clamp((μ̂_{i−1} − m₀) / (σ̂²_{i−1} + (μ̂_{i−1} − m₀)²), 0, maxBet)
 *
 * where μ̂/σ̂² are the shrunk running estimates μ̂_t = (1/2 + Σx_i)/(t+1),
 * σ̂²_t = (1/4 + Σ(x_i − μ̂_i)²)/(t+1).
 *
 * PREDICTABILITY INVARIANT (load-bearing): λ_i is a function of x_1..x_{i−1}
 * ONLY — it may never see x_i. With λ_i ≥ 0 predictable, each factor has
 * E[1 + λ_i(x_i − m₀) | past] ≤ 1 under H0, so W is a nonnegative
 * supermartingale and Ville's inequality gives P(∃t: W_t ≥ 1/α) ≤ α — the
 * type-I guarantee holds at ANY data-dependent stopping time. λ_1 is always 0
 * (no prior evidence), so the first observation never moves wealth.
 *
 * `decided` latches at the first crossing W_t ≥ 1/α and never un-latches;
 * wealth keeps updating after the crossing (the e-process remains valid), but
 * the decision time is the first crossing.
 */
export function eProcess(opts: EProcessOptions = {}): EProcess {
  const alpha = opts.alpha ?? 0.05
  const maxBet = opts.maxBet ?? 0.5
  const nullMean = opts.nullMean ?? 0.5
  if (!Number.isFinite(alpha) || alpha <= 0 || alpha >= 1) {
    throw new ValidationError(`eProcess: alpha must be in (0,1), got ${alpha}`)
  }
  if (!Number.isFinite(nullMean) || nullMean <= 0 || nullMean >= 1) {
    throw new ValidationError(`eProcess: nullMean must be in (0,1), got ${nullMean}`)
  }
  if (!Number.isFinite(maxBet) || maxBet <= 0 || maxBet >= 1 / nullMean) {
    throw new ValidationError(
      `eProcess: maxBet must be in (0, 1/nullMean=${(1 / nullMean).toFixed(4)}) so wealth ` +
        `factors stay positive, got ${maxBet}`,
    )
  }
  const threshold = 1 / alpha
  let wealth = 1
  let n = 0
  let decided = false
  let decidedAtN: number | undefined
  // Running sums over observations consumed so far — read BEFORE folding in
  // the next x, so every bet is predictable.
  let sumX = 0
  let varSum = 0
  return {
    update(x: number): EProcessStep {
      if (typeof x !== 'number' || !Number.isFinite(x) || x < 0 || x > 1) {
        throw new ValidationError(
          `eProcess: observation must be a finite number in [0,1], got ${x}`,
        )
      }
      // λ from prior observations ONLY — x has not touched sumX/varSum yet.
      const muPrev = (0.5 + sumX) / (n + 1)
      const varPrev = (0.25 + varSum) / (n + 1)
      const edge = muPrev - nullMean
      const lambda = Math.min(maxBet, Math.max(0, edge / (varPrev + edge * edge)))
      wealth *= 1 + lambda * (x - nullMean)
      n += 1
      sumX += x
      const muNow = (0.5 + sumX) / (n + 1)
      varSum += (x - muNow) ** 2
      if (!decided && wealth >= threshold) {
        decided = true
        decidedAtN = n
      }
      return { wealth, n, decided }
    },
    state(): EProcessState {
      return { wealth, n, decided, alpha, maxBet, nullMean, threshold, decidedAtN }
    },
  }
}
