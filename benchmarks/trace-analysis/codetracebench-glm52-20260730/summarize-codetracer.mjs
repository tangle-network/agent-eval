#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import {
  codeTraceBenchCase,
  codeTracerPredictionsToFindings,
  runAnalystBenchmark,
  summarizeCodeTraceCalibration,
} from '../../../dist/analyst/index.js'

const GLM_INPUT_USD_PER_TOKEN = 0.0006 / 1_000
const GLM_OUTPUT_USD_PER_TOKEN = 0.0022 / 1_000
const PRODUCED_AT = '2026-07-30T00:00:00.000Z'

const flags = parseFlags(process.argv.slice(2))
const labelsPath = resolve(required(flags, 'labels'))
const runDir = resolve(required(flags, 'run-dir'))
const outputPath = resolve(required(flags, 'output'))
const revision = required(flags, 'revision')
if (!/^[a-f0-9]{40}$/i.test(revision)) {
  throw new TypeError('--revision must be a full 40-character Git revision')
}

const labelBytes = await readFile(labelsPath)
const rows = JSON.parse(labelBytes.toString('utf8'))
if (!Array.isArray(rows) || rows.length === 0) {
  throw new TypeError('--labels must contain a non-empty JSON array')
}

const inputs = rows.map((row) => ({
  row,
  trajectoryId: requiredString(row.traj_id, 'CodeTraceBench traj_id'),
  stepCount: positiveInteger(row.step_count, `${row.traj_id} step_count`),
}))
const cases = inputs.map((input) => codeTraceBenchCase(input.row, input))
const sourceFiles = []
const statuses = new Map()

for (const input of inputs) {
  for (const repetition of [0, 1]) {
    const key = `r${repetition}--${input.trajectoryId}`
    const statusPath = join(runDir, 'status', `${key}.json`)
    const status = JSON.parse(await readTracked(statusPath))
    if (
      !status ||
      typeof status !== 'object' ||
      status.trajectoryId !== input.trajectoryId ||
      status.repetition !== repetition ||
      !['ok', 'failed', 'invalid-output'].includes(status.state)
    ) {
      throw new TypeError(`${relative(runDir, statusPath)} has invalid status metadata`)
    }
    statuses.set(key, status)
    await trackIfPresent(join(runDir, 'logs', `${key}.log`))
    await trackIfPresent(join(runDir, 'time', `${key}.txt`))
    await trackIfPresent(join(runDir, 'cases', key, 'codetracer_labels.json'))
  }
}

const result = await runAnalystBenchmark({
  cases,
  repetitions: 2,
  maxConcurrency: 1,
  runners: [
    {
      id: 'codetracer',
      async analyze(input, context) {
        const key = `r${context.repetition}--${input.trajectoryId}`
        const status = statuses.get(key)
        if (!status) throw new Error(`missing status for ${key}`)
        const log = await readOptional(join(runDir, 'logs', `${key}.log`))
        const timing = parseTiming(await readOptional(join(runDir, 'time', `${key}.txt`)))
        const usage = parseUsage(log)
        const metadata = {
          upstream: 'CodeTracer',
          upstreamState: status.state,
          exitCode: status.exitCode,
          repricedCostUsd: repriceUsage(usage),
        }
        if (status.state !== 'ok') {
          return {
            findings: [],
            usage,
            observedLatencyMs: timing.wallMs,
            metadata,
            error: {
              class: status.state === 'failed' ? 'CodeTracerProcessError' : 'CodeTracerOutputError',
              message:
                status.state === 'failed'
                  ? `CodeTracer exited with status ${status.exitCode}`
                  : 'CodeTracer completed without a valid label file',
              code: status.state,
              status: status.exitCode,
            },
          }
        }
        const predictions = JSON.parse(
          await readFile(join(runDir, 'cases', key, 'codetracer_labels.json'), 'utf8'),
        )
        let findings
        try {
          findings = codeTracerPredictionsToFindings(input.trajectoryId, predictions, {
            stepCount: input.stepCount,
            producedAt: PRODUCED_AT,
          })
        } catch (error) {
          return {
            findings: [],
            usage,
            observedLatencyMs: timing.wallMs,
            metadata: {
              ...metadata,
              adapterError:
                error instanceof Error ? `${error.name}: ${error.message}` : String(error),
            },
            error: {
              class: 'CodeTracerOutputError',
              message: 'CodeTracer emitted labels outside its supported output schema',
              code: 'invalid-prediction-schema',
            },
          }
        }
        return {
          findings,
          usage,
          observedLatencyMs: timing.wallMs,
          metadata,
        }
      },
    },
  ],
  benchmark: {
    id: 'codetracebench-codetracer',
    dataset: {
      id: 'codetracebench',
      revision: 'aa213b84ffb6690fc37ca15766d6ca174ec36d4d',
      split: 'verified-miniswe-normalizer-compatible-32',
    },
    metadata: {
      upstream: 'NJU-LINK/CodeTracer',
      upstreamRevision: revision,
      memoryEnabled: false,
      model: 'glm-5.2',
    },
  },
})
result.provenance.startedAt = PRODUCED_AT
result.provenance.endedAt = PRODUCED_AT

const statusCounts = Object.fromEntries(
  ['ok', 'failed', 'invalid-output'].map((state) => [
    state,
    [...statuses.values()].filter((status) => status.state === state).length,
  ]),
)
const evaluationStatusCounts = {
  valid: result.observations.filter((observation) => !observation.error).length,
  failedProcess: result.observations.filter(
    (observation) => observation.error?.code === 'failed',
  ).length,
  invalidOutput: result.observations.filter((observation) =>
    ['invalid-output', 'invalid-prediction-schema'].includes(observation.error?.code ?? ''),
  ).length,
}
const knownRepricedRuns = result.observations.filter(
  (observation) => typeof observation.runnerMetadata?.repricedCostUsd === 'number',
)
const artifact = {
  kind: 'agent-eval/codetracer-benchmark-result',
  source: {
    upstream: 'NJU-LINK/CodeTracer',
    upstreamRevision: revision,
    model: 'glm-5.2',
    memoryEnabled: false,
    labelsSha256: sha256(labelBytes),
    runManifestSha256: sha256(
      Buffer.from(
        JSON.stringify(
          sourceFiles
            .sort((left, right) => left.path.localeCompare(right.path))
            .map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })),
        ),
      ),
    ),
    sourceFiles: sourceFiles.length,
  },
  statusCounts,
  evaluationStatusCounts,
  result,
  codeTraceCalibration: summarizeCodeTraceCalibration(result),
  repricedCost: {
    method: 'Agent Eval GLM estimate: $0.0006/1K input tokens and $0.0022/1K output tokens',
    knownRuns: knownRepricedRuns.length,
    unknownRuns: result.observations.length - knownRepricedRuns.length,
    usd: stableSum(
      knownRepricedRuns.map((observation) => observation.runnerMetadata.repricedCostUsd),
    ),
  },
}

await writeFile(outputPath, `${JSON.stringify(artifact, null, 2)}\n`, {
  encoding: 'utf8',
  flag: 'wx',
})
process.stdout.write(
  `${JSON.stringify({
    output: outputPath,
    statusCounts,
    evaluationStatusCounts,
    summary: result.summaries[0],
    calibration: artifact.codeTraceCalibration.runners[0],
    repricedCost: artifact.repricedCost,
  })}\n`,
)

function parseFlags(argv) {
  const parsed = new Map()
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (!flag?.startsWith('--') || !value || value.startsWith('--')) {
      throw new TypeError('expected --labels, --run-dir, --revision, and --output')
    }
    const name = flag.slice(2)
    if (parsed.has(name)) throw new TypeError(`duplicate flag: ${flag}`)
    parsed.set(name, value)
  }
  for (const name of parsed.keys()) {
    if (!['labels', 'run-dir', 'revision', 'output'].includes(name)) {
      throw new TypeError(`unknown flag: --${name}`)
    }
  }
  return parsed
}

function required(parsed, name) {
  const value = parsed.get(name)?.trim()
  if (!value) throw new TypeError(`--${name} is required`)
  return value
}

async function readTracked(path) {
  const bytes = await readFile(path)
  sourceFiles.push({
    path: relative(runDir, path),
    bytes: bytes.byteLength,
    sha256: sha256(bytes),
  })
  return bytes.toString('utf8')
}

async function trackIfPresent(path) {
  try {
    await readTracked(path)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
}

async function readOptional(path) {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return ''
    throw error
  }
}

function parseUsage(log) {
  const calls = /API calls:\s+([\d,]+)/.exec(log)
  const tokens = /Total tokens:\s+([\d,]+) input,\s+([\d,]+) output/.exec(log)
  const cost = /Total cost:\s+\$([0-9]+(?:\.[0-9]+)?)/.exec(log)
  return {
    calls: calls ? integer(calls[1]) : null,
    tokens: tokens
      ? {
          input: integer(tokens[1]),
          output: integer(tokens[2]),
        }
      : null,
    cost: cost
      ? { kind: 'estimated', usd: Number(cost[1]) }
      : { kind: 'uncaptured', usd: null },
    ...(cost ? {} : { knownCostUsd: 0 }),
  }
}

function parseTiming(text) {
  const wall = /wall_seconds=([0-9]+(?:\.[0-9]+)?)/.exec(text)
  return { wallMs: wall ? Number(wall[1]) * 1_000 : null }
}

function repriceUsage(usage) {
  if (!usage.tokens) return null
  return (
    usage.tokens.input * GLM_INPUT_USD_PER_TOKEN +
    usage.tokens.output * GLM_OUTPUT_USD_PER_TOKEN
  )
}

function integer(value) {
  const parsed = Number(value.replaceAll(',', ''))
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new TypeError(`invalid non-negative integer: ${value}`)
  }
  return parsed
}

function positiveInteger(value, context) {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new TypeError(`${context} must be a positive integer`)
  }
  return parsed
}

function requiredString(value, context) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TypeError(`${context} must be a non-empty string`)
  }
  return value
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function stableSum(values) {
  return values.reduce((sum, value) => Math.round((sum + value) * 1e12) / 1e12, 0)
}
