/**
 * Multi-layer verifier — ordered pipeline of verification layers.
 *
 * Different contract from {@link JudgeRunner} (which runs parallel
 * specs against a sandbox). MultiLayerVerifier is a DAG of layers
 * (install → typecheck → build → lint → serve → semantic → …) with
 * dependency-based skip, per-layer findings, soft-fail semantics, and
 * an aggregated `blendedScore` across all passed layers.
 *
 * Use when you want:
 *   - ordered stages where a failing upstream stage skips downstream ones
 *   - each stage produces rich `findings` (severity + message + evidence)
 *   - a single composite score across stages with per-stage weights
 *   - soft-fail stages whose failure doesn't abort the pipeline
 *
 * Use {@link JudgeRunner} when you want:
 *   - N independent judges running in parallel against the same artifact
 *   - no inter-judge dependencies
 *   - boolean `passed` per judge + overall
 *
 * Both primitives compose — JudgeRunner can be invoked as a single
 * layer inside a MultiLayerVerifier if that suits the caller.
 */

// ─── Types ──────────────────────────────────────────────────────────────

export type LayerStatus = 'pass' | 'fail' | 'skipped' | 'error' | 'timeout'

export type Severity = 'critical' | 'major' | 'minor' | 'info'

export interface Finding {
  severity: Severity
  message: string
  evidence?: string
  /** Optional layer name the finding belongs to (set by the verifier if omitted). */
  layer?: string
}

export interface LayerResult {
  layer: string
  status: LayerStatus
  /** 0..1 score, optional — layers that don't produce a numeric score omit. */
  score?: number
  durationMs: number
  findings: Finding[]
  /** Short human-readable summary (one line). */
  reason?: string
  /** Any rich per-layer detail — rendered as-is by consumers that know the layer. */
  detail?: Record<string, unknown>
}

export interface VerifyContext<Env = unknown> {
  /** Per-run opaque context the caller provides. Layers destructure what they need. */
  env: Env
  /** Previously-computed results from layers that already ran. */
  prior: Record<string, LayerResult>
  /** Signal — if aborted, layers MUST bail within reasonable wall. */
  signal: AbortSignal
}

export interface Layer<Env = unknown> {
  name: string
  /** Stages that must have `status: 'pass'` before this layer runs. */
  dependsOn?: string[]
  /**
   * Weight in the composite `blendedScore`. Default 1.0. Layers with weight 0
   * contribute findings but not score.
   */
  weight?: number
  /**
   * If true, a `fail` status contributes to `blendedScore` (as 0) instead of
   * being dropped — use for layers whose failure is a real signal. Default:
   * fail drops from numerator + denominator, matching VB's existing semantics.
   */
  failContributesToScore?: boolean
  /** Optional per-layer wall-cap in ms. Honored by the verifier (AbortSignal). */
  capMs?: number
  run: (ctx: VerifyContext<Env>) => Promise<LayerResult> | LayerResult
}

export interface VerifyOptions<Env = unknown> {
  env: Env
  /**
   * Overall wall cap. Default: sum of layer capMs, or Infinity if any layer
   * omits a cap. The verifier short-circuits remaining layers on overall cap.
   */
  overallCapMs?: number
  /** Called with each layer result as it completes. */
  onLayer?: (result: LayerResult) => void
}

export interface VerificationReport {
  layers: LayerResult[]
  passCount: number
  failCount: number
  skippedCount: number
  errorCount: number
  /** True iff at least one scored layer ran AND every scored layer passed. */
  allPass: boolean
  /**
   * Weighted mean of `score` across contributing layers. 0 when no layers
   * contributed. See {@link Layer.failContributesToScore} for fail semantics.
   */
  blendedScore: number
  durationMs: number
  startedAt: string
  finishedAt: string
}

// ─── Helpers ────────────────────────────────────────────────────────────

/**
 * Grade a semantic-concept-style judge result into a single layer status.
 *
 * Pass when overall score >= threshold AND no critical-severity concept gap.
 * Fail otherwise. Use inside a `Layer.run` when wrapping a concept judge.
 *
 * Generalized from VerticalBench H3 fix: `failingConcepts.length === 0` was
 * too strict — a single concept at 6/10 failed the entire layer despite
 * overall score being >= 0.7. Now we trust the judge's own `severity` field:
 * `critical` findings veto; `major`/`minor` reduce the score but don't veto.
 */
export function gradeSemanticStatus(input: {
  score: number
  findings: Array<{ severity: Severity; present?: boolean; score?: number }>
  available: boolean
  threshold?: number
}): LayerStatus {
  if (!input.available) return 'error'
  const threshold = input.threshold ?? 0.7
  const criticalGaps = input.findings.filter(
    (f) => f.severity === 'critical' && (f.present === false || (f.score ?? 0) < 7),
  )
  return input.score >= threshold && criticalGaps.length === 0 ? 'pass' : 'fail'
}

// ─── Verifier ───────────────────────────────────────────────────────────

export class MultiLayerVerifier<Env = unknown> {
  constructor(private readonly layers: Layer<Env>[]) {
    const seen = new Set<string>()
    for (const l of layers) {
      if (seen.has(l.name)) throw new Error(`MultiLayerVerifier: duplicate layer name "${l.name}"`)
      seen.add(l.name)
    }
    for (const l of layers) {
      for (const dep of l.dependsOn ?? []) {
        if (!seen.has(dep)) {
          throw new Error(
            `MultiLayerVerifier: layer "${l.name}" depends on "${dep}" which is not registered`,
          )
        }
      }
    }
  }

  async run(opts: VerifyOptions<Env>): Promise<VerificationReport> {
    const startedAtMs = Date.now()
    const startedAt = new Date(startedAtMs).toISOString()
    const controller = new AbortController()
    const overallCap = opts.overallCapMs
    const overallTimer =
      overallCap != null
        ? setTimeout(() => controller.abort(new Error('overall cap exceeded')), overallCap)
        : null

    const results: LayerResult[] = []
    const byName: Record<string, LayerResult> = {}

    try {
      for (const layer of this.layers) {
        // Skip if any dependency didn't pass.
        const unmet = (layer.dependsOn ?? []).filter((d) => byName[d]?.status !== 'pass')
        if (unmet.length > 0) {
          const skipped: LayerResult = {
            layer: layer.name,
            status: 'skipped',
            durationMs: 0,
            findings: [],
            reason: `skipped — upstream not passing: ${unmet.join(', ')}`,
          }
          results.push(skipped)
          byName[layer.name] = skipped
          opts.onLayer?.(skipped)
          continue
        }

        // Per-layer cap — compose with overall signal.
        const perLayerController = new AbortController()
        const mergedSignal = mergeSignals(controller.signal, perLayerController.signal)
        const layerTimer =
          layer.capMs != null
            ? setTimeout(() => perLayerController.abort(new Error(`layer ${layer.name} cap`)), layer.capMs)
            : null

        const layerStart = Date.now()
        let result: LayerResult
        try {
          result = await layer.run({ env: opts.env, prior: { ...byName }, signal: mergedSignal })
        } catch (err) {
          const aborted = mergedSignal.aborted
          result = {
            layer: layer.name,
            status: aborted ? 'timeout' : 'error',
            durationMs: Date.now() - layerStart,
            findings: [
              {
                severity: 'major',
                message: err instanceof Error ? err.message : String(err),
                layer: layer.name,
              },
            ],
            reason: err instanceof Error ? err.message : String(err),
          }
        } finally {
          if (layerTimer) clearTimeout(layerTimer)
        }

        // Normalize findings to attach layer name if omitted.
        result.findings = result.findings.map((f) => ({ ...f, layer: f.layer ?? layer.name }))
        results.push(result)
        byName[layer.name] = result
        opts.onLayer?.(result)

        if (controller.signal.aborted) break
      }

      const report = aggregate(this.layers, results, startedAt, startedAtMs)
      return report
    } finally {
      if (overallTimer) clearTimeout(overallTimer)
    }
  }
}

function aggregate<Env>(
  layers: Layer<Env>[],
  results: LayerResult[],
  startedAt: string,
  startedAtMs: number,
): VerificationReport {
  const weightByName = new Map<string, number>()
  const failContribByName = new Map<string, boolean>()
  for (const l of layers) {
    weightByName.set(l.name, l.weight ?? 1)
    failContribByName.set(l.name, l.failContributesToScore ?? false)
  }

  let passCount = 0
  let failCount = 0
  let skippedCount = 0
  let errorCount = 0
  let scoredWeightSum = 0
  let scoredWeightedTotal = 0
  let ranAnyScoredLayer = false
  let anyScoredLayerFailed = false

  for (const r of results) {
    const weight = weightByName.get(r.layer) ?? 1
    const failContrib = failContribByName.get(r.layer) ?? false
    if (r.status === 'pass') passCount++
    else if (r.status === 'fail') failCount++
    else if (r.status === 'skipped') skippedCount++
    else errorCount++

    if (r.score != null && weight > 0) {
      if (r.status === 'pass') {
        ranAnyScoredLayer = true
        scoredWeightSum += weight
        scoredWeightedTotal += weight * r.score
      } else if (r.status === 'fail') {
        if (failContrib) {
          ranAnyScoredLayer = true
          scoredWeightSum += weight
          scoredWeightedTotal += weight * r.score
        }
        anyScoredLayerFailed = true
      }
      // skipped / error / timeout layers don't contribute
    } else if (r.status === 'fail') {
      anyScoredLayerFailed = true
    }
  }

  const finishedAtMs = Date.now()
  return {
    layers: results,
    passCount,
    failCount,
    skippedCount,
    errorCount,
    allPass: ranAnyScoredLayer && !anyScoredLayerFailed && failCount === 0 && errorCount === 0,
    blendedScore: scoredWeightSum > 0 ? scoredWeightedTotal / scoredWeightSum : 0,
    durationMs: finishedAtMs - startedAtMs,
    startedAt,
    finishedAt: new Date(finishedAtMs).toISOString(),
  }
}

function mergeSignals(a: AbortSignal, b: AbortSignal): AbortSignal {
  if (a.aborted) return a
  if (b.aborted) return b
  const c = new AbortController()
  const onAbort = (signal: AbortSignal) => () => c.abort(signal.reason)
  a.addEventListener('abort', onAbort(a), { once: true })
  b.addEventListener('abort', onAbort(b), { once: true })
  return c.signal
}
