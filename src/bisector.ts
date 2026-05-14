/**
 * Bisector — auto-locate the change that introduced an eval regression.
 *
 * Two shapes:
 *   - `commitBisect` — walk an ordered SHA list, binary-search for the
 *     first commit that fails.
 *   - `promptBisect` — given a good and bad prompt, progressively port
 *     paragraphs from good→bad to localize the breaking change.
 *
 * Generic `bisect<T>` lets callers drive any ordered state space
 * (dataset versions, config files, CLI flag combinations).
 */

export interface BisectOptions<T> {
  /** State known to pass. */
  good: T
  /** State known to fail. */
  bad: T
  /** Equality test on state values — default Object.is. */
  equals?: (a: T, b: T) => boolean
  /** Pick the halfway state between good + bad. Return null when no further
   *  split is possible (e.g. adjacent commits). */
  halfway: (good: T, bad: T) => T | null
  /** Produce a verdict for a state. */
  runEval: (state: T) => Promise<{ score: number; pass: boolean }>
  /** Hard cap on iterations (default 40 — covers ~1T ordered states). */
  maxIterations?: number
}

export interface BisectStep<T> {
  state: T
  score: number
  pass: boolean
}

export interface BisectResult<T> {
  /** The first bad state — typically `bad` in the final (good, bad) adjacent pair. */
  culprit: T
  /** Ordered trace of all states evaluated. */
  path: BisectStep<T>[]
  /** True when we narrowed to an adjacent (good, bad) pair. */
  converged: boolean
  /** True when `good` itself failed or `bad` itself passed — the caller's
   *  premise was broken. */
  inputInconsistent: boolean
}

export async function bisect<T>(options: BisectOptions<T>): Promise<BisectResult<T>> {
  const equals = options.equals ?? ((a, b) => Object.is(a, b))
  const maxIter = options.maxIterations ?? 40
  const path: BisectStep<T>[] = []

  const goodVerdict = await options.runEval(options.good)
  path.push({ state: options.good, ...goodVerdict })
  const badVerdict = await options.runEval(options.bad)
  path.push({ state: options.bad, ...badVerdict })

  if (!goodVerdict.pass) {
    return { culprit: options.good, path, converged: false, inputInconsistent: true }
  }
  if (badVerdict.pass) {
    return { culprit: options.bad, path, converged: false, inputInconsistent: true }
  }

  let good = options.good
  let bad = options.bad
  for (let i = 0; i < maxIter; i++) {
    const mid = options.halfway(good, bad)
    if (mid === null || equals(mid, good) || equals(mid, bad)) {
      return { culprit: bad, path, converged: true, inputInconsistent: false }
    }
    const v = await options.runEval(mid)
    path.push({ state: mid, ...v })
    if (v.pass) good = mid
    else bad = mid
  }
  return { culprit: bad, path, converged: false, inputInconsistent: false }
}

/**
 * Commit bisect — `commits` is an ordered SHA list, oldest to newest.
 * `good` and `bad` must both be present in the list.
 */
export async function commitBisect(options: {
  commits: string[]
  good: string
  bad: string
  runEval: (sha: string) => Promise<{ score: number; pass: boolean }>
  maxIterations?: number
}): Promise<BisectResult<string>> {
  const { commits } = options
  const goodIdx = commits.indexOf(options.good)
  const badIdx = commits.indexOf(options.bad)
  if (goodIdx < 0 || badIdx < 0) {
    throw new Error(
      `commitBisect: good or bad SHA not in commit list (good=${options.good}, bad=${options.bad})`,
    )
  }
  if (goodIdx >= badIdx) {
    throw new Error('commitBisect: good must precede bad in the commit list')
  }
  return bisect<string>({
    good: options.good,
    bad: options.bad,
    runEval: options.runEval,
    maxIterations: options.maxIterations,
    halfway: (g, b) => {
      const gi = commits.indexOf(g)
      const bi = commits.indexOf(b)
      if (bi - gi <= 1) return null
      return commits[Math.floor((gi + bi) / 2)]
    },
  })
}

/**
 * Prompt bisect — splits the good and bad prompts into paragraphs, then
 * progressively replaces paragraphs in `good` with their counterparts
 * from `bad` to localize the offending change. Only works when the two
 * prompts have the same paragraph count (a common editorial workflow
 * constraint — one paragraph = one change unit).
 */
export async function promptBisect(options: {
  good: string
  bad: string
  runEval: (prompt: string) => Promise<{ score: number; pass: boolean }>
  maxIterations?: number
  paragraphSplitter?: (prompt: string) => string[]
}): Promise<BisectResult<string> & { offendingParagraphIndex?: number }> {
  const split = options.paragraphSplitter ?? ((p: string) => p.split(/\n\s*\n/))
  const join = (paragraphs: string[]) => paragraphs.join('\n\n')
  const goodParas = split(options.good)
  const badParas = split(options.bad)
  if (goodParas.length !== badParas.length) {
    throw new Error(
      `promptBisect: paragraph count mismatch (${goodParas.length} vs ${badParas.length})`,
    )
  }
  if (goodParas.length < 2) {
    throw new Error('promptBisect: need at least 2 paragraphs to bisect')
  }
  // Represent state as a bit-mask of which paragraphs come from `bad`.
  // good = all-zero, bad = all-one; halfway = flip the midpoint half.
  const n = goodParas.length
  const goodMask = '0'.repeat(n)
  const badMask = '1'.repeat(n)

  function paragraphsFor(mask: string): string[] {
    return mask.split('').map((c, i) => (c === '1' ? badParas[i] : goodParas[i]))
  }

  const result = await bisect<string>({
    good: goodMask,
    bad: badMask,
    runEval: (mask) => options.runEval(join(paragraphsFor(mask))),
    maxIterations: options.maxIterations ?? n + 5,
    halfway: (g, b) => {
      // Pick the first differing position and flip it.
      for (let i = 0; i < g.length; i++) {
        if (g[i] !== b[i]) {
          // Flip the midpoint between the remaining diff positions.
          const differing: number[] = []
          for (let j = i; j < g.length; j++) if (g[j] !== b[j]) differing.push(j)
          if (differing.length === 0) return null
          if (differing.length === 1) return null // adjacent — can't narrow further
          // Flip the first half of differing positions from good → bad.
          const flip = differing.slice(0, Math.ceil(differing.length / 2))
          const chars = g.split('')
          for (const f of flip) chars[f] = b[f]
          return chars.join('')
        }
      }
      return null
    },
    equals: (a, b) => a === b,
  })

  // Identify the offending paragraph as the index that changed between the
  // last good and final bad in the path.
  let offendingParagraphIndex: number | undefined
  const lastGood = result.path.filter((s) => s.pass).pop()
  const culprit = result.culprit
  if (lastGood) {
    for (let i = 0; i < n; i++) {
      if (lastGood.state[i] !== culprit[i]) {
        offendingParagraphIndex = i
        break
      }
    }
  }

  // Materialize path states back into full prompts for caller consumption.
  const materializedPath: BisectStep<string>[] = result.path.map((s) => ({
    state: join(paragraphsFor(s.state)),
    score: s.score,
    pass: s.pass,
  }))

  return {
    culprit: join(paragraphsFor(culprit)),
    path: materializedPath,
    converged: result.converged,
    inputInconsistent: result.inputInconsistent,
    offendingParagraphIndex,
  }
}
