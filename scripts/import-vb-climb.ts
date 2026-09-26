#!/usr/bin/env -S node --experimental-strip-types
/**
 * Import a real `vb-climb` GEPA run's own artifacts into a search ledger
 * (search-tree-design §12's real-ledger proof), through the real
 * `recordGepaSearch`/`importGepaPopulation`/`importExternalEvaluations` path
 * (E2/E9's GEPA importer) — no synthetic data, no second ledger writer.
 *
 * Reads exactly what the climb wrote: `climb-spec.json` for the task
 * partitions, `result.json` for the optimizer's own choice and cost
 * accounting, and, under `improve/optimization/*​/gepa/`, GEPA's own
 * candidate-population artifact and callback observation log. Both artifacts
 * are re-verified by the importer's own readers (byte count, SHA-256 and
 * content shape) against a summary this script builds from the files
 * on disk, so a truncated or edited artifact is refused before any event is
 * written, the same as a producer's own summary would be.
 *
 * The climb's own `cost.optimization.costProvenance.kind` is `estimated`,
 * never `observed` (its own `accountingComplete` is `false`, because the
 * coder's token usage is unknown) — this script records that generation-level
 * spend as `unknown`, matching the design's own rule (§12, "unknown stays
 * unknown"). It does not feed any lens: `operatorYield`/`front` read
 * per-node cost from `cell-settled` accounting, which the callback path
 * records as `unknown` for every cell (the callback meters cost per
 * evaluation batch, not per cell) — so on a real GEPA-imported climb both
 * lenses report every child excluded, honestly, not a bug in this importer
 * or those lenses.
 *
 * Usage:
 *   node --experimental-strip-types scripts/import-vb-climb.ts \
 *     --dir <vb-climb-run-dir> --out <path>
 */
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  fsCampaignStorage,
  readExternalOptimizerObservationArtifact,
  readGepaCandidatePopulationArtifact,
  recordGepaSearch,
  replaySearchLedgerText,
  type ExternalOptimizerObservationSummary,
  type GepaCandidatePopulationSummary,
} from '../src/campaign/index'
import type { Scenario } from '../src/campaign/types'

interface Args {
  dir: string
  out: string
}

function parseArgs(argv: string[]): Args {
  const flags: Record<string, string> = {}
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!
    if (!token.startsWith('--')) continue
    flags[token.slice(2)] = argv[i + 1] ?? ''
    i++
  }
  if (!flags.dir || !flags.out) {
    throw new Error('usage: import-vb-climb.ts --dir <vb-climb-run-dir> --out <path>')
  }
  return { dir: flags.dir, out: flags.out }
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function sha256Of(contents: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(contents).digest('hex')}`
}

/** The climb writes exactly one GEPA run per `improve/optimization/*​/gepa`
 * directory; a coder climb runs one method, so exactly one is expected. */
function findOne(root: string, matches: (name: string) => boolean): string {
  const found: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (matches(entry.name)) found.push(path)
    }
  }
  walk(root)
  if (found.length !== 1) {
    throw new Error(`expected exactly one match under ${root}, found ${found.length}: ${found.join(', ')}`)
  }
  return found[0]!
}

function candidateChars(candidate: unknown): number {
  return typeof candidate === 'string' ? candidate.length : JSON.stringify(candidate).length
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  rmSync(args.out, { force: true })
  rmSync(`${args.out}.head`, { force: true })
  rmSync(`${dirname(args.out)}/blobs`, { recursive: true, force: true })

  const spec = readJson(join(args.dir, 'climb-spec.json')) as {
    process: string
    partitions: { train: string[]; selection: string[] }
    baseProfileDigest: string
    judge: string
    optimizer: { model: string }
  }
  const result = readJson(join(args.dir, 'result.json')) as {
    cost?: { optimization?: { totalCostUsd?: number; costProvenance?: { kind?: string } } }
  }
  const contestants = readJson(join(args.dir, 'contestants.json')) as Array<{
    id: string
    profile: { name: string; model: { default: string; provider: string } }
  }>
  const baseContestant = contestants[0]!
  let commit = 'unknown'
  try {
    commit = readFileSync(join(args.dir, 'commit.txt'), 'utf8').trim() || 'unknown'
  } catch {
    // commit.txt is best-effort provenance; its absence does not block the import.
  }

  const populationPath = findOne(join(args.dir, 'improve'), (name) =>
    name.startsWith('candidate-population-') && name.endsWith('.json'),
  )
  const observationsPath = findOne(join(args.dir, 'improve'), (name) =>
    name.startsWith('observations-') && name.endsWith('.jsonl'),
  )

  const populationRaw = readFileSync(populationPath, 'utf8')
  const populationJson = JSON.parse(populationRaw) as {
    runId: string
    bestIndex: number
    candidates: Array<{
      candidate: unknown
      selectionScores: Array<{ scenarioId: string }>
    }>
  }
  const scenarioIds = [
    ...new Set(populationJson.candidates.flatMap((c) => c.selectionScores.map((s) => s.scenarioId))),
  ]
  const populationSummary: GepaCandidatePopulationSummary = {
    scope: 'gepa-candidate-population',
    path: populationPath,
    sha256: sha256Of(populationRaw),
    bytes: Buffer.byteLength(populationRaw),
    runId: populationJson.runId,
    candidates: populationJson.candidates.length,
    bestIndex: populationJson.bestIndex,
    maxCandidates: populationJson.candidates.length,
    maxCandidateChars: Math.max(...populationJson.candidates.map((c) => candidateChars(c.candidate))),
    scenarioIds,
    surfaceKind: typeof populationJson.candidates[0]!.candidate === 'string' ? 'text' : 'components',
  }
  const population = readGepaCandidatePopulationArtifact({ summary: populationSummary })

  const observationsRaw = readFileSync(observationsPath, 'utf8')
  const observationLines = observationsRaw.length === 0 ? [] : observationsRaw.slice(0, -1).split('\n')
  const counts = { submittedCandidates: 0, evaluations: 0, refusals: 0 }
  for (const line of observationLines) {
    const kind = (JSON.parse(line) as { kind: string }).kind
    if (kind === 'proposal') counts.submittedCandidates += 1
    else if (kind === 'evaluation') counts.evaluations += 1
    else counts.refusals += 1
  }
  const observationSummary: ExternalOptimizerObservationSummary = {
    scope: 'callback-submitted-candidates',
    path: observationsPath,
    sha256: sha256Of(observationsRaw),
    ...counts,
  }
  const observations = readExternalOptimizerObservationArtifact({ summary: observationSummary })

  const scenario = (id: string): Scenario => ({ id, kind: 'vb-leaf' })
  const seed = population.candidates.find((c) => c.parentIndices.every((p) => p === null))
  if (!seed) throw new Error(`GEPA population at ${populationPath} names no seed candidate`)

  const optimizationCost = result.cost?.optimization
  const searchId = `vb-climb:${population.runId}`
  // The climb-spec's `optimizer.model` is a bare alias ("gpt-5.4"); its own
  // cost ledger records the exact dated snapshot each call actually hit.
  // Prefer that; fall back to the alias branch if a run's ledger ever omits it.
  const costLedgerPath = join(args.dir, 'improve', 'cost', 'cost-ledger.jsonl')
  const optimizerSnapshot = readFileSync(costLedgerPath, 'utf8')
    .split('\n')
    .map((line) => {
      try {
        return (JSON.parse(line) as { record?: { channel?: string; model?: string } }).record
      } catch {
        return undefined
      }
    })
    // `channel: 'optimizer'` is GEPA's own model call; the agent (channel
    // `agent`) and judge (channel `judge`) calls share the same name prefix
    // (e.g. `gpt-5.4-mini` also starts with `gpt-5.4-`) and must be excluded.
    .find((record) => record?.channel === 'optimizer' && record.model?.startsWith(`${spec.optimizer.model}-`))
    ?.model
  const receipt = await recordGepaSearch({
    name: `vb-climb/${spec.process}`,
    path: args.out,
    searchId,
    storage: fsCampaignStorage(),
    seed: 1,
    baselineSurface: seed.candidate,
    trainScenarios: spec.partitions.train.map(scenario),
    selectionScenarios: spec.partitions.selection.map(scenario),
    evaluationLimit: observationSummary.evaluations,
    observations,
    population,
    generationAccounting: {
      tokens: { status: 'unknown', reason: 'the climb records the optimizer generation call, not its token usage' },
      cost:
        optimizationCost?.costProvenance?.kind === 'observed' && typeof optimizationCost.totalCostUsd === 'number'
          ? { status: 'known', usd: optimizationCost.totalCostUsd, source: 'provider' }
          : {
              status: 'unknown',
              knownLowerBoundUsd: 0,
              reason: `the climb's own cost accounting is incomplete (costProvenance.kind=${optimizationCost?.costProvenance?.kind ?? 'missing'})`,
            },
    },
    identity: {
      agent: { uri: `vb-climb-coder://${baseContestant.profile.name}`, revision: spec.baseProfileDigest },
      proposer: optimizerSnapshot
        ? {
            kind: 'model',
            model: { provider: 'openai', snapshot: optimizerSnapshot },
            // `population.runId` is GEPA's own compound run key, not a hash
            // shape the ledger's `SourceRef.revision` accepts; hash it instead.
            source: {
              uri: 'tool://gepa-optimizer',
              revision: sha256Of(population.runId).slice('sha256:'.length),
            },
          }
        : {
            kind: 'model',
            model: {
              provider: 'openai',
              alias: spec.optimizer.model,
              unknown: `no dated snapshot for '${spec.optimizer.model}' appears in ${costLedgerPath}`,
            },
            source: {
              uri: 'tool://gepa-optimizer',
              revision: sha256Of(population.runId).slice('sha256:'.length),
            },
          },
      search: { uri: 'tool://vb-climb', revision: commit },
      // The climb records a model alias ("gpt-5.6-luna"), never a pinned
      // snapshot (a dated or opaque-tagged id `modelHasSnapshot` requires):
      // recorded honestly as an alias, not forced into the snapshot branch.
      model: {
        provider: baseContestant.profile.model.provider,
        alias: baseContestant.profile.model.default,
        unknown: 'the climb records a model alias, not a pinned immutable snapshot',
      },
      subject: `vb/${spec.process}`,
      // `judge` is a free-text tier config, not a hash; the ledger's
      // `SourceRef.revision` requires an immutable-revision shape, so this
      // records the hash of that exact config text as the revision.
      judge: { uri: 'app-grade://tier', revision: sha256Of(spec.judge).slice('sha256:'.length) },
    },
  })

  const text = readFileSync(args.out, 'utf8')
  const state = replaySearchLedgerText(text, searchId, args.out)
  console.log(
    `imported ${args.dir} -> ${args.out}: ${text.split('\n').filter(Boolean).length} entries, ` +
      `${state.nodes().length} nodes, ${state.edges().length} edges, ${state.cells().length} cells, ` +
      `complete=${state.completion.complete}, receipt.digest=${receipt.receiptDigest.slice(0, 16)}...`,
  )
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
