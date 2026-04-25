/**
 * Multi-toolchain layer factory + merge helper.
 *
 * Some verification stages (install, typecheck, build, lint) run the
 * SAME logical layer across multiple parallel adapters — pnpm AND npm
 * AND cargo AND forge for a polyglot scaffold. The verifier presents
 * one row per stage; the toolchain breakdown lives in `findings.detail`.
 *
 * This module provides the merge: take N independent `LayerResult`s
 * (one per adapter) and reduce them to a single `LayerResult` whose
 * status is the worst of the parts and whose findings cite the adapter
 * that produced each one. Plus a {@link multiToolchainLayer} factory
 * that runs the adapter calls in parallel + applies the reducer.
 *
 * Pure utility — composes with {@link MultiLayerVerifier}.{run}.
 */

import type {
  Layer,
  LayerResult,
  LayerStatus,
  Severity,
  VerifyContext,
} from './multi-layer-verifier'

// ─── Status reduction ──────────────────────────────────────────────────

const STATUS_RANK: Record<LayerStatus, number> = {
  pass: 0,
  skipped: 1,
  fail: 2,
  timeout: 3,
  error: 4,
}

function worst(a: LayerStatus, b: LayerStatus): LayerStatus {
  return (STATUS_RANK[a] ?? 0) >= (STATUS_RANK[b] ?? 0) ? a : b
}

const SEVERITY_RANK: Record<Severity, number> = {
  info: 0,
  minor: 1,
  major: 2,
  critical: 3,
}

function maxSeverity(findings: ReadonlyArray<{ severity: Severity }>): Severity {
  let best: Severity = 'info'
  for (const f of findings) {
    if (SEVERITY_RANK[f.severity] > SEVERITY_RANK[best]) best = f.severity
  }
  return best
}

// ─── Merge ──────────────────────────────────────────────────────────────

export interface AdapterRun {
  /** Identifier for the adapter (e.g. 'pnpm', 'npm', 'cargo', 'forge'). */
  adapter: string
  result: LayerResult
}

export interface MergeOptions {
  /**
   * How to combine per-adapter `durationMs`. Default `'max'` (parallel
   * wall-clock). Set `'sum'` when reporting total work done across
   * adapters rather than wall time.
   */
  mergeDuration?: 'max' | 'sum'
  /**
   * Prefix finding messages with a per-adapter tag (e.g. `[pnpm] typecheck failed`).
   * Default: no prefix (renderers read `detail.adapter` instead).
   */
  messagePrefixer?: (adapter: string) => string
  /**
   * How to reduce per-adapter `LayerResult.diagnostics` into the merged
   * result's diagnostics. `'max'` (default) — for each key, merged =
   * max across adapters where value is non-null (matches "if ANY adapter
   * saw N errors, merged saw N"). `'sum'` — sum non-null values.
   */
  mergeDiagnostics?: 'max' | 'sum'
}

/**
 * Reduce N adapter runs to a single `LayerResult` for a logical layer.
 *
 *   - status: worst of the parts (pass < skipped < fail < timeout < error)
 *   - score: weighted mean of numeric scores (skip = no contribution)
 *   - findings: union, each tagged with `detail.adapter`
 *   - durationMs: `mergeDuration` option (default 'max' for parallel wall-clock)
 *   - diagnostics: `mergeDiagnostics` option (default 'max' per key)
 *   - reason: " · "-joined `name: status` per adapter
 */
export function mergeLayerResults(
  name: string,
  perAdapter: AdapterRun[],
  options: MergeOptions = {},
): LayerResult {
  const mergeDuration = options.mergeDuration ?? 'max'
  const mergeDiagnostics = options.mergeDiagnostics ?? 'max'
  const prefix = options.messagePrefixer

  if (perAdapter.length === 0) {
    return {
      layer: name,
      status: 'skipped',
      durationMs: 0,
      findings: [],
      reason: 'no adapters',
    }
  }
  if (perAdapter.length === 1) {
    const only = perAdapter[0]!
    return {
      ...only.result,
      layer: name,
      findings: only.result.findings.map((f) => ({
        ...f,
        layer: name,
        message: prefix ? `${prefix(only.adapter)} ${f.message}` : f.message,
        detail: { ...(f.detail ?? {}), adapter: only.adapter },
      })),
      reason: only.result.reason ?? `${only.adapter}: ${only.result.status}`,
    }
  }

  let status: LayerStatus = 'pass'
  let weightedScoreSum = 0
  let weightCount = 0
  const findings: LayerResult['findings'] = []
  let durationMs = 0
  const reasonParts: string[] = []
  const diagnostics: Record<string, number | null> = {}

  for (const { adapter, result } of perAdapter) {
    status = worst(status, result.status)
    if (typeof result.score === 'number') {
      weightedScoreSum += result.score
      weightCount += 1
    }
    durationMs = mergeDuration === 'sum' ? durationMs + result.durationMs : Math.max(durationMs, result.durationMs)
    reasonParts.push(`${adapter}: ${result.status}`)
    for (const f of result.findings) {
      findings.push({
        ...f,
        layer: name,
        message: prefix ? `${prefix(adapter)} ${f.message}` : f.message,
        detail: { ...(f.detail ?? {}), adapter },
      })
    }
    for (const [k, v] of Object.entries(result.diagnostics ?? {})) {
      if (typeof v !== 'number' || !Number.isFinite(v)) continue
      const prev = diagnostics[k]
      if (prev == null) diagnostics[k] = v
      else diagnostics[k] = mergeDiagnostics === 'sum' ? prev + v : Math.max(prev, v)
    }
  }

  return {
    layer: name,
    status,
    score: weightCount > 0 ? weightedScoreSum / weightCount : undefined,
    durationMs,
    findings,
    reason: reasonParts.join(' · '),
    diagnostics: Object.keys(diagnostics).length > 0 ? diagnostics : undefined,
    detail: {
      adapters: perAdapter.map(({ adapter, result }) => ({
        adapter,
        status: result.status,
        score: result.score ?? null,
      })),
      worstSeverity: maxSeverity(findings),
    },
  }
}

// ─── Layer factory ──────────────────────────────────────────────────────

export interface MultiToolchainLayerConfig<Env, Adapter> {
  name: string
  adapters: ReadonlyArray<Adapter>
  /** Adapter identifier — used in findings + reason. */
  adapterName: (a: Adapter) => string
  /** Run a single adapter against the verify context. */
  run: (a: Adapter, ctx: VerifyContext<Env>) => Promise<LayerResult> | LayerResult
  dependsOn?: string[]
  weight?: number
  failContributesToScore?: boolean
  capMs?: number
  /**
   * Per-adapter parallel cap. Defaults to 8 — defense in depth against a
   * caller passing 50 adapters and fanning out 50 simultaneous subprocesses.
   * Adapters that need higher concurrency raise this explicitly.
   */
  maxParallel?: number
}

/**
 * Build a {@link Layer} that fans the same logical stage across N adapters
 * in parallel and merges via {@link mergeLayerResults}.
 *
 * Per-adapter throws are caught + converted to `status: 'error'` results
 * so one bad adapter doesn't poison the whole layer.
 */
export function multiToolchainLayer<Env, Adapter>(
  config: MultiToolchainLayerConfig<Env, Adapter>,
): Layer<Env> {
  const maxParallel = Math.max(1, config.maxParallel ?? 8)
  return {
    name: config.name,
    dependsOn: config.dependsOn,
    weight: config.weight,
    failContributesToScore: config.failContributesToScore,
    capMs: config.capMs,
    async run(ctx) {
      if (config.adapters.length === 0) {
        return {
          layer: config.name,
          status: 'skipped',
          durationMs: 0,
          findings: [],
          reason: 'no adapters detected',
        }
      }

      const runOne = async (adapter: Adapter): Promise<AdapterRun> => {
        const adapterName = config.adapterName(adapter)
        try {
          const r = await config.run(adapter, ctx)
          return { adapter: adapterName, result: r }
        } catch (err) {
          return {
            adapter: adapterName,
            result: {
              layer: config.name,
              status: 'error',
              durationMs: 0,
              findings: [
                {
                  severity: 'major',
                  layer: config.name,
                  message: err instanceof Error ? err.message : String(err),
                  detail: { adapter: adapterName },
                },
              ],
              reason: err instanceof Error ? err.message : String(err),
            },
          }
        }
      }

      // Bounded parallelism — chunked into groups of size maxParallel.
      const results: AdapterRun[] = []
      for (let i = 0; i < config.adapters.length; i += maxParallel) {
        const chunk = config.adapters.slice(i, i + maxParallel)
        const chunkResults = await Promise.all(chunk.map(runOne))
        results.push(...chunkResults)
      }
      return mergeLayerResults(config.name, results)
    },
  }
}
