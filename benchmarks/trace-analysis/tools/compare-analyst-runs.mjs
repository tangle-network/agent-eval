#!/usr/bin/env node
// Compare analyst-benchmark result.json files across arms.
//
// Reuses the package's own statistics from dist/ (build first: pnpm build):
//   - summarizeAnalystBenchmarkRunner  micro (pooled) + macro summary semantics
//   - compareAnalystRunners            paired per-metric deltas, cluster bootstrap CIs
//   - clusteredPairedBinary            completion (run failed vs completed) paired binary
//
// Micro F1 here is the pooled statistic: recall = sum(matched)/sum(expected),
// precision = sum(supported)/sum(predicted findings on issue-bearing rows),
// F1 = harmonic mean — identical to result.summaries[].f1.
// Macro F1 = mean of per-case F1 over issue-bearing rows = summaries[].macroF1.
//
// Usage:
//   compare-analyst-runs.mjs --run LABEL=[RUNNER@]PATH[,[RUNNER@]PATH...] \
//     [--run LABEL2=...] [--pool] [--baseline LABEL] [--seed N] \
//     [--resamples N] [--confidence C] [--json]
//   compare-analyst-runs.mjs --verify-embedded PATH [--json]
//
// Arms with multiple paths (dev + holdout pooled) require --pool; observations
// are concatenated before any statistic. Pairing is on caseId + repetition,
// clusters on observations[].clusterId, so pooled arms must cover the same
// case set on both sides for full pairing (unpaired cases are reported).
//
// --verify-embedded recomputes a persisted artifact's summaries, comparisons,
// and CodeTraceBench calibration from its own observations and prints
// MATCH/MISMATCH per field (exit 1 on any mismatch). Comparison CIs are
// recomputed with the artifact's recorded seed (provenance.runnerOrderSeed),
// so intervalLow/intervalHigh reproduce exactly unless --seed overrides it.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const distRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../dist')
const { summarizeAnalystBenchmarkRunner, compareAnalystRunners, summarizeCodeTraceCalibration } =
  await import(`${distRoot}/analyst/index.js`)
const { clusteredPairedBinary } = await import(`${distRoot}/index.js`)

const ENVELOPE_KIND = 'agent-eval/analyst-benchmark-result'

function usageError(message) {
  process.stderr.write(`error: ${message}\n\nrun with --help for usage\n`)
  process.exit(2)
}

function printHelp() {
  const header = readFileSync(fileURLToPath(import.meta.url), 'utf8')
    .split('\n')
    .filter((line) => line.startsWith('//'))
    .map((line) => line.replace(/^\/\/ ?/, ''))
    .join('\n')
  process.stdout.write(`${header}\n`)
}

function parseArgs(argv) {
  const args = {
    runs: [],
    pool: false,
    baseline: null,
    seed: 0,
    resamples: 2000,
    confidence: 0.95,
    json: false,
    verifyEmbedded: null,
    seedExplicit: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const next = () => {
      i += 1
      if (i >= argv.length) usageError(`${arg} requires a value`)
      return argv[i]
    }
    if (arg === '--help' || arg === '-h') {
      printHelp()
      process.exit(0)
    } else if (arg === '--run') {
      args.runs.push(next())
    } else if (arg === '--pool') {
      args.pool = true
    } else if (arg === '--baseline') {
      args.baseline = next()
    } else if (arg === '--seed') {
      args.seed = Number(next())
      args.seedExplicit = true
      if (!Number.isSafeInteger(args.seed)) usageError('--seed must be an integer')
    } else if (arg === '--resamples') {
      args.resamples = Number(next())
      if (!Number.isSafeInteger(args.resamples) || args.resamples <= 0) {
        usageError('--resamples must be a positive integer')
      }
    } else if (arg === '--confidence') {
      args.confidence = Number(next())
      if (!(args.confidence > 0 && args.confidence < 1)) {
        usageError('--confidence must be in (0,1)')
      }
    } else if (arg === '--json') {
      args.json = true
    } else if (arg === '--verify-embedded') {
      args.verifyEmbedded = next()
    } else {
      usageError(`unknown argument '${arg}'`)
    }
  }
  return args
}

function loadArtifact(path) {
  let value
  try {
    value = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    usageError(`cannot read '${path}': ${error.message}`)
  }
  const envelope = value.kind === ENVELOPE_KIND ? value : null
  const result = envelope ? envelope.result : value
  if (
    !result ||
    !Array.isArray(result.observations) ||
    !Array.isArray(result.summaries) ||
    !result.provenance
  ) {
    usageError(
      `'${path}' is not an analyst benchmark result ` +
        `(need observations/summaries/provenance, or a '${ENVELOPE_KIND}' envelope)`,
    )
  }
  return { path, envelope, result }
}

function pickRunner(artifact, explicit) {
  const available = [...new Set(artifact.result.observations.map((o) => o.runnerId))]
  if (explicit) {
    if (!available.includes(explicit)) {
      usageError(`runner '${explicit}' not in '${artifact.path}' (has: ${available.join(', ')})`)
    }
    return explicit
  }
  const nonEmpty = available.filter((id) => id !== 'empty')
  if (nonEmpty.length !== 1) {
    usageError(
      `'${artifact.path}' has runners [${available.join(', ')}]; ` +
        `disambiguate with LABEL=RUNNER@PATH`,
    )
  }
  return nonEmpty[0]
}

function parseArmSpecs(runArgs, pool) {
  const arms = new Map()
  for (const raw of runArgs) {
    const eq = raw.indexOf('=')
    if (eq <= 0) usageError(`--run expects LABEL=[RUNNER@]PATH[,...], got '${raw}'`)
    const label = raw.slice(0, eq).trim()
    if (!label) usageError(`--run has an empty label in '${raw}'`)
    const sources = raw
      .slice(eq + 1)
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => {
        const at = entry.indexOf('@')
        return at > 0
          ? { runner: entry.slice(0, at), path: entry.slice(at + 1) }
          : { runner: null, path: entry }
      })
    if (sources.length === 0) usageError(`--run '${raw}' names no paths`)
    const existing = arms.get(label) ?? []
    existing.push(...sources)
    arms.set(label, existing)
  }
  for (const [label, sources] of arms) {
    if (sources.length > 1 && !pool) {
      usageError(
        `arm '${label}' has ${sources.length} result files; pass --pool to pool observations`,
      )
    }
  }
  return arms
}

function buildArm(label, sources) {
  const observations = []
  const seen = new Set()
  const loadedSources = []
  let representativenessProven = true
  for (const source of sources) {
    const artifact = loadArtifact(source.path)
    const runnerId = pickRunner(artifact, source.runner)
    const rows = artifact.result.observations.filter((o) => o.runnerId === runnerId)
    if (rows.length === 0) usageError(`'${source.path}' has no observations for '${runnerId}'`)
    for (const row of rows) {
      const key = `${row.caseId} ${row.repetition}`
      if (seen.has(key)) {
        usageError(
          `arm '${label}': duplicate observation '${row.caseId}' repetition ${row.repetition} ` +
            `(same case pooled twice — arms must pool disjoint case sets)`,
        )
      }
      seen.add(key)
      observations.push({ ...row, runnerId: label })
    }
    if (artifact.result.provenance.metadata?.populationRepresentativenessProven !== true) {
      representativenessProven = false
    }
    loadedSources.push({ path: source.path, runnerId, observations: rows.length })
  }
  return { label, sources: loadedSources, observations, representativenessProven }
}

function pooledCounts(observations) {
  const positive = observations.filter((o) => o.labelState === 'positive')
  const counts = {
    expectedIssues: 0,
    matchedIssues: 0,
    predictedFindings: 0,
    supportedFindings: 0,
  }
  for (const o of positive) {
    counts.expectedIssues += o.score.expectedIssueCount
    counts.matchedIssues += o.score.matchedIssueIds.length
    counts.predictedFindings += o.error ? 0 : o.findings.length
    counts.supportedFindings += o.score.supportedFindingIndexes.length
  }
  return counts
}

function completionComparison(baselineArm, candidateArm, seed, confidence) {
  const rows = [...baselineArm.observations, ...candidateArm.observations]
  const result = clusteredPairedBinary(rows, {
    baselineArm: baselineArm.label,
    treatmentArm: candidateArm.label,
    pairKey: (row) => row.caseId,
    clusterKey: (row) => row.clusterId,
    arm: (row) => row.runnerId,
    pass: (row) => !row.error,
    repKey: (row) => String(row.repetition),
    seed,
    confidence,
  })
  return {
    nPairs: result.statistics?.nPairs ?? 0,
    nClusters: result.statistics?.nClusters ?? 0,
    unpairedBaseline: result.unpairedBaseline.length,
    unpairedCandidate: result.unpairedTreatment.length,
    candidateOnlyCompletes: result.statistics?.b10 ?? null,
    baselineOnlyCompletes: result.statistics?.b01 ?? null,
    taskWeightedRiskDifference: result.statistics?.taskWeightedRiskDifference ?? null,
    bootstrap: result.statistics?.bootstrap ?? null,
    signFlip: result.statistics?.signFlip
      ? {
          pValue: result.statistics.signFlip.pValue,
          method: result.statistics.signFlip.method,
          alternative: result.statistics.signFlip.alternative,
        }
      : null,
  }
}

function fmt(value, digits = 4) {
  if (value === null || value === undefined) return '—'
  if (typeof value !== 'number') return String(value)
  return Number.isInteger(value) && Math.abs(value) < 1e6 ? String(value) : value.toFixed(digits)
}

function table(rows) {
  const widths = rows[0].map((_, col) => Math.max(...rows.map((row) => String(row[col]).length)))
  return rows
    .map((row) => row.map((cell, col) => String(cell).padEnd(widths[col])).join('  '))
    .join('\n')
}

function runCompare(args) {
  const specs = parseArmSpecs(args.runs, args.pool)
  if (specs.size < 1) usageError('need at least one --run LABEL=PATH')
  const arms = [...specs.entries()].map(([label, sources]) => buildArm(label, sources))
  const baselineLabel = args.baseline ?? arms[0].label
  const baselineArm = arms.find((arm) => arm.label === baselineLabel)
  if (!baselineArm) usageError(`--baseline '${baselineLabel}' is not a --run label`)

  const perArm = arms.map((arm) => {
    const summary = summarizeAnalystBenchmarkRunner(arm.label, arm.observations)
    return { arm, summary, counts: pooledCounts(arm.observations) }
  })

  const comparisons = arms
    .filter((arm) => arm.label !== baselineLabel)
    .map((candidateArm) => {
      const baseSummary = perArm.find((row) => row.arm === baselineArm).summary
      const candSummary = perArm.find((row) => row.arm === candidateArm).summary
      const synthetic = {
        provenance: {
          metadata: {
            populationRepresentativenessProven:
              baselineArm.representativenessProven && candidateArm.representativenessProven,
          },
        },
        observations: [...baselineArm.observations, ...candidateArm.observations],
        summaries: [baseSummary, candSummary],
      }
      return {
        baseline: baselineLabel,
        candidate: candidateArm.label,
        metrics: compareAnalystRunners(synthetic, {
          baselineRunnerId: baselineLabel,
          candidateRunnerId: candidateArm.label,
          seed: args.seed,
          resamples: args.resamples,
          confidence: args.confidence,
        }).metrics,
        completion: completionComparison(baselineArm, candidateArm, args.seed, args.confidence),
      }
    })

  if (args.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          seed: args.seed,
          resamples: args.resamples,
          confidence: args.confidence,
          arms: perArm.map(({ arm, summary, counts }) => ({
            label: arm.label,
            sources: arm.sources,
            counts,
            summary,
          })),
          baseline: baselineLabel,
          comparisons,
        },
        null,
        2,
      )}\n`,
    )
    return
  }

  process.stdout.write('== Per-arm summary (micro = pooled; macro = mean per issue-bearing case)\n')
  const armRows = [
    [
      'arm',
      'runs',
      'failed',
      'microP',
      'microR',
      'microF1',
      'macroF1',
      'matched/expected',
      'supported/predicted',
      'sources',
    ],
    ...perArm.map(({ arm, summary, counts }) => [
      arm.label,
      summary.plannedRuns,
      summary.failedRuns,
      fmt(summary.findingPrecision),
      fmt(summary.issueRecall),
      fmt(summary.f1),
      fmt(summary.macroF1),
      `${counts.matchedIssues}/${counts.expectedIssues}`,
      `${counts.supportedFindings}/${counts.predictedFindings}`,
      arm.sources.map((s) => `${s.runnerId}@${s.path}`).join(' + '),
    ]),
  ]
  process.stdout.write(`${table(armRows)}\n`)

  for (const comparison of comparisons) {
    process.stdout.write(
      `\n== Paired deltas: ${comparison.candidate} - ${comparison.baseline} ` +
        `(pairs on caseId+repetition, clusters on clusterId, ` +
        `${args.resamples} resamples, seed ${args.seed})\n`,
    )
    const metricRows = [
      [
        'metric',
        'dir',
        'base',
        'cand',
        'delta',
        `ci${Math.round(args.confidence * 100)}`,
        'cases',
        'clusters',
        'limitations',
      ],
      ...comparison.metrics.map((m) => [
        m.metric,
        m.direction,
        fmt(m.baselineMean),
        fmt(m.candidateMean),
        fmt(m.meanDelta),
        m.intervalLow === null ? '—' : `[${fmt(m.intervalLow)}, ${fmt(m.intervalHigh)}]`,
        m.pairedCases,
        m.pairedClusters,
        m.inferenceLimitations.join(',') || 'none',
      ]),
    ]
    process.stdout.write(`${table(metricRows)}\n`)
    const completion = comparison.completion
    process.stdout.write(
      `completion (clusteredPairedBinary): pairs=${completion.nPairs} ` +
        `clusters=${completion.nClusters} ` +
        `candidate-only-completes=${fmt(completion.candidateOnlyCompletes)} ` +
        `baseline-only-completes=${fmt(completion.baselineOnlyCompletes)} ` +
        `riskDiff=${fmt(completion.taskWeightedRiskDifference)} ` +
        `ci=${
          completion.bootstrap
            ? `[${fmt(completion.bootstrap.lower)}, ${fmt(completion.bootstrap.upper)}]`
            : '—'
        } ` +
        `signFlip p=${completion.signFlip ? fmt(completion.signFlip.pValue) : '—'} ` +
        `unpaired base/cand=${completion.unpairedBaseline}/${completion.unpairedCandidate}\n`,
    )
  }
}

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const keys = Object.keys(value)
    .filter((key) => value[key] !== undefined)
    .sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
}

function verifyEmbedded(args) {
  const artifact = loadArtifact(args.verifyEmbedded)
  if (!artifact.envelope) {
    usageError(`--verify-embedded needs a persisted '${ENVELOPE_KIND}' envelope`)
  }
  const { result } = artifact
  const seed = args.seedExplicit ? args.seed : result.provenance.runnerOrderSeed
  if (!Number.isSafeInteger(seed)) {
    usageError('artifact has no integer provenance.runnerOrderSeed; pass --seed')
  }
  let mismatches = 0
  const check = (label, embedded, recomputed) => {
    const match = canonical(embedded) === canonical(recomputed)
    if (!match) mismatches += 1
    process.stdout.write(
      `${match ? 'MATCH   ' : 'MISMATCH'}  ${label}  embedded=${canonical(
        embedded,
      )} recomputed=${canonical(recomputed)}\n`,
    )
    return match
  }

  process.stdout.write(`verify-embedded ${artifact.path} (comparison seed ${seed})\n\n`)
  process.stdout.write('-- summaries (recomputed with summarizeAnalystBenchmarkRunner)\n')
  for (const embedded of result.summaries) {
    const recomputed = summarizeAnalystBenchmarkRunner(
      embedded.runnerId,
      result.observations.filter((o) => o.runnerId === embedded.runnerId),
    )
    for (const field of ['f1', 'macroF1', 'failedRuns', 'issueRecall', 'findingPrecision']) {
      check(`summaries[${embedded.runnerId}].${field}`, embedded[field], recomputed[field])
    }
    check(`summaries[${embedded.runnerId}].<all fields>`, embedded, recomputed)
  }

  const embeddedComparisons = artifact.envelope.comparisons ?? []
  process.stdout.write('\n-- comparisons (recomputed with compareAnalystRunners)\n')
  for (const embedded of embeddedComparisons) {
    const recomputed = compareAnalystRunners(result, {
      baselineRunnerId: embedded.baselineRunnerId,
      candidateRunnerId: embedded.candidateRunnerId,
      seed,
    })
    const pair = `${embedded.baselineRunnerId}->${embedded.candidateRunnerId}`
    for (const [index, embeddedMetric] of embedded.metrics.entries()) {
      const recomputedMetric = recomputed.metrics[index]
      for (const field of Object.keys(embeddedMetric)) {
        check(`comparisons[${pair}].${embeddedMetric.metric}.${field}`, embeddedMetric[field],
          recomputedMetric?.[field])
      }
    }
  }

  if (artifact.envelope.codeTraceCalibration) {
    process.stdout.write('\n-- codeTraceCalibration (recomputed with summarizeCodeTraceCalibration)\n')
    check(
      'codeTraceCalibration',
      artifact.envelope.codeTraceCalibration,
      summarizeCodeTraceCalibration(result),
    )
  }

  process.stdout.write(`\n${mismatches === 0 ? 'ALL MATCH' : `${mismatches} MISMATCH(ES)`}\n`)
  if (mismatches > 0) process.exitCode = 1
}

const args = parseArgs(process.argv.slice(2))
if (args.verifyEmbedded) {
  if (args.runs.length > 0) usageError('--verify-embedded does not take --run arms')
  verifyEmbedded(args)
} else {
  runCompare(args)
}
