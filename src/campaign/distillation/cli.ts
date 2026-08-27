#!/usr/bin/env node
/**
 * `distill` — run a teacher→student GEPA distillation against a gold JSONL.
 *
 * The TEACHER is an expensive workflow whose verdicts are frozen as gold; the
 * STUDENT is a cheap single-shot analyst whose system prompt GEPA optimizes
 * toward reproducing those gold verdicts. This is the LIVE, token-spending
 * entry — invoked by hand, never in CI.
 *
 * Usage:
 *   distill \
 *     --gold   <path/to/gold.jsonl> \
 *     --baseline <path/to/baseline-prompt.txt> \
 *     --model  <cheap-student-model> \
 *     [--optimizer-model <reflection-model>] \
 *     [--generations N] [--population K] [--reps R] \
 *     [--test-every-nth 4] [--delta 0] \
 *     [--categorical f1,f2] [--array a1,a2] \
 *     [--run-dir <dir>]
 *
 * Auth: set LLM_API_KEY (+ optional LLM_BASE_URL) or TANGLE_API_KEY for the
 * Tangle router. The same creds drive the student calls AND the GEPA
 * reflection.
 *
 * Example (against the private skills-internal gold set, 53 records):
 *   TANGLE_API_KEY=$(cat /tmp/.tk) pnpm tsx src/campaign/distillation/cli.ts \
 *     --gold ~/code/skills-internal/audits/gold/skill-verdicts.gold.jsonl \
 *     --baseline ./baseline-skill-analyst.txt \
 *     --model gpt-4o-mini --optimizer-model gpt-4o \
 *     --generations 3 --population 4 \
 *     --categorical value_verdict,quality_score,generalization_rating,public_leak_risk,write_target_rating,subagent_recommended \
 *     --array top_actions
 */

import { readFileSync } from 'node:fs'
import { buildAgreementJudge, fieldAgreement } from './agreement-judge'
import { loadGoldScenarios, splitGold } from './gold-scenarios'
import { runDistillation } from './run-distillation'

interface CliArgs {
  flags: Record<string, string>
}

function parseArgs(argv: string[]): CliArgs {
  const flags: Record<string, string> = {}
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]!
    if (!tok.startsWith('--')) continue
    const key = tok.slice(2)
    const next = argv[i + 1]
    if (next != null && !next.startsWith('--')) {
      flags[key] = next
      i++
    } else {
      flags[key] = 'true'
    }
  }
  return { flags }
}

function splitList(value: string | undefined): string[] {
  if (!value) return []
  return value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

async function main(): Promise<void> {
  const { flags } = parseArgs(process.argv.slice(2))

  const goldPath = flags.gold
  const baselinePath = flags.baseline
  const studentModel = flags.model
  if (!goldPath || !baselinePath || !studentModel) {
    console.error(
      'distill: required flags --gold <path> --baseline <prompt-file> --model <cheap-model>',
    )
    process.exit(2)
  }

  const apiKey = (process.env.LLM_API_KEY || process.env.TANGLE_API_KEY)?.trim()
  if (!apiKey) {
    console.error(
      'distill: set LLM_API_KEY (+ optional LLM_BASE_URL) or TANGLE_API_KEY for a live run.',
    )
    process.exit(2)
  }
  const baseUrl = process.env.LLM_BASE_URL || process.env.TANGLE_ROUTER_BASE_URL

  const optimizerModel = flags['optimizer-model'] ?? studentModel
  const generations = flags.generations ? Number(flags.generations) : 3
  const population = flags.population ? Number(flags.population) : 4
  const reps = flags.reps ? Number(flags.reps) : 1
  const testEveryNth = flags['test-every-nth'] ? Number(flags['test-every-nth']) : 4
  const deltaThreshold = flags.delta ? Number(flags.delta) : 0

  // Comparator field config. Defaults are the skill-audit gold verdict shape
  // (skills-internal/audits/gold/skill-verdicts.gold.jsonl); the CLI is generic
  // — pass --categorical / --array for any other gold schema.
  const categorical =
    splitList(flags.categorical).length > 0
      ? splitList(flags.categorical)
      : [
          'value_verdict',
          'quality_score',
          'generalization_rating',
          'public_leak_risk',
          'write_target_rating',
          'subagent_recommended',
        ]
  const array = splitList(flags.array).length > 0 ? splitList(flags.array) : ['top_actions']

  const baselinePrompt = readFileSync(baselinePath, 'utf8')
  const scenarios = loadGoldScenarios<Record<string, unknown>, Record<string, unknown>>(goldPath)
  const { train, test } = splitGold(scenarios, { testEveryNth })

  console.log(
    `[distill] ${scenarios.length} gold records → ${train.length} train / ${test.length} holdout`,
  )
  console.log(
    `[distill] student=${studentModel} optimizer=${optimizerModel} pop=${population} gens=${generations} reps=${reps}`,
  )
  console.log(
    `[distill] comparator categorical=[${categorical.join(',')}] array=[${array.join(',')}]`,
  )

  const compare = fieldAgreement<Record<string, unknown>, Record<string, unknown>>({
    categorical,
    array,
  })
  const judge = buildAgreementJudge<
    Record<string, unknown>,
    Record<string, unknown>,
    Record<string, unknown>
  >({
    compareLabels: compare,
    dimensionKeys: [...categorical, ...array],
  })

  const result = await runDistillation({
    baselinePrompt,
    train,
    holdout: test,
    llm: { transport: 'router', apiKey, baseUrl, defaultModel: studentModel },
    reflectionLlm: { apiKey, baseUrl },
    studentModel,
    optimizerModel,
    judge,
    populationSize: population,
    maxGenerations: generations,
    reps,
    deltaThreshold,
    runDir: flags['run-dir'],
  })

  const { baseline, winner, delta } = result.holdoutAgreement
  console.log('\n──────────────── distillation result ────────────────')
  console.log(
    `holdout agreement  baseline=${baseline.toFixed(4)}  winner=${winner.toFixed(4)}  Δ=${delta.toFixed(4)}`,
  )
  console.log(
    `gate decision      ${result.gateResult.decision} — ${result.gateResult.reasons.join('; ')}`,
  )
  if (result.winnerLabel) console.log(`winner label       ${result.winnerLabel}`)
  if (result.winnerRationale) console.log(`winner rationale   ${result.winnerRationale}`)
  console.log('\n──────────────── winning student prompt ────────────────')
  console.log(result.winnerPrompt)
}

main().catch((err) => {
  console.error('distill: failed —', err instanceof Error ? err.message : err)
  process.exit(1)
})
