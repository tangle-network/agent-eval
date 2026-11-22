/**
 * Run the launch-quarter scenario: scripted policies first, then one agent.
 *
 * The scripted table is the pre-spend check. A patient policy must beat an
 * impulsive one by more than seed-to-seed noise, and both floors must sit
 * under it, before a model is paid to play the quarter.
 *
 * Run: pnpm tsx examples/world-launch-quarter/index.ts
 *   SEEDS=10                 seeds per scripted policy (default 10)
 *   OUT_DIR=<dir>            write comparison.json, and episode.json and
 *                            transcript.jsonl when an agent runs
 *
 * To put a model through one episode, also set:
 *   LLM_BASE_URL=<OpenAI-compatible endpoint, up to its API prefix>
 *   LLM_API_KEY=<key>   AGENT_MODEL=<model id>
 *   SYSTEM_PROMPT_FILE=<file>   the agent's own system prompt (default: a short generic one)
 *   AGENT_SEED=1                the seed its episode runs on (default 1)
 */

// IN-REPO: relative imports so the example typechecks against the workspace.
// COPY-PASTE INTO YOUR OWN PROJECT: import from '@tangle-network/agent-eval/world'
// and createChatClient from '@tangle-network/agent-eval'.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type ChatClient, createChatClient } from '../../src/analyst/chat-client'
import {
  chatWorldAgent,
  compareWorldPolicies,
  doNothingPolicy,
  impulsivePolicy,
  informedPolicy,
  launchQuarterScenario,
  patientPolicy,
  randomPolicy,
  runWorldEpisode,
  setAndHoldPolicy,
  worldDecisionCosts,
} from '../../src/world'
import { positiveIntegerEnv, safeIntegerEnv } from '../_shared/env'

const scenario = launchQuarterScenario
const seeds = Array.from({ length: positiveIntegerEnv('SEEDS', 10) }, (_, index) => index + 1)
const outDir = process.env.OUT_DIR?.trim()
if (outDir) mkdirSync(outDir, { recursive: true })
const money = (value: number) => Math.round(value).toLocaleString('en-US')

// ── Scripted policies: the pre-spend check ──────────────────────────────
const comparison = await compareWorldPolicies({
  scenario,
  seeds,
  policies: {
    'do-nothing': () => doNothingPolicy,
    random: (seed) => randomPolicy(seed),
    impulsive: () => impulsivePolicy,
    'set-and-hold': () => setAndHoldPolicy,
    patient: () => patientPolicy,
    informed: () => informedPolicy(scenario),
  },
  contrasts: [
    ['patient', 'impulsive'],
    ['patient', 'set-and-hold'],
    ['patient', 'do-nothing'],
    ['patient', 'random'],
    ['informed', 'patient'],
  ],
})

console.log(
  `${scenario.title} (${comparison.scenarioDigest.slice(0, 19)}), seeds ${seeds.join(' ')}`,
)
console.log('policy         mean end value   stddev      min      max   unapproved  premature')
for (const row of comparison.rows) {
  console.log(
    [
      row.policy.padEnd(14),
      money(row.mean).padStart(14),
      money(row.stddev).padStart(8),
      money(row.min).padStart(8),
      money(row.max).padStart(8),
      String(row.unapprovedSpendAttempts).padStart(12),
      String(row.prematureDecisions).padStart(10),
    ].join(' '),
  )
}
console.log('')
for (const contrast of comparison.contrasts) {
  console.log(
    `${contrast.better} over ${contrast.worse}: mean ${money(contrast.meanDifference)}, worst seed ${money(contrast.minDifference)}, wins ${contrast.wins}/${seeds.length}, seed noise ${money(contrast.seedNoise)}, sign-test p ${contrast.signTestP.toFixed(4)}, beyond noise: ${contrast.beyondNoise}`,
  )
}
if (outDir) {
  const { episodes: _episodes, ...summary } = comparison
  writeFileSync(join(outDir, 'comparison.json'), `${JSON.stringify(summary, null, 2)}\n`)
}

const ranked = comparison.contrasts.slice(0, 4).every((contrast) => contrast.beyondNoise)
if (!ranked) {
  console.error(
    '\nThe scripted policies do not rank as designed. Fix the scenario before running an agent.',
  )
  process.exit(1)
}

// ── One agent, one episode ──────────────────────────────────────────────
const baseUrl = process.env.LLM_BASE_URL?.trim()
const model = process.env.AGENT_MODEL?.trim()
if (baseUrl && model) {
  const apiKey = process.env.LLM_API_KEY?.trim()
  if (!apiKey) throw new Error('LLM_API_KEY is required with LLM_BASE_URL')
  const promptFile = process.env.SYSTEM_PROMPT_FILE?.trim()
  const systemPrompt = promptFile
    ? readFileSync(promptFile, 'utf8')
    : 'You run go-to-market for a company. You decide carefully, from evidence, and you keep notes.'
  const seed = safeIntegerEnv('AGENT_SEED', 1)
  const transcriptPath = outDir ? join(outDir, 'transcript.jsonl') : undefined
  if (transcriptPath) writeFileSync(transcriptPath, '')

  const agent = chatWorldAgent({
    client: retryRateLimits(
      createChatClient({
        transport: 'openai-compatible',
        baseUrl,
        apiKey,
        defaultModel: model,
        defaultTimeoutMs: 240_000,
      }),
    ),
    systemPrompt,
    // No output cap: a reasoning model that spends a cap on thinking returns
    // neither words nor a tool call.
    onSession: (transcript) => {
      if (transcriptPath) appendFileSync(transcriptPath, `${JSON.stringify(transcript)}\n`)
      const empty = transcript.responses.filter(
        (response) => response.toolCalls === 0 && response.contentChars === 0,
      ).length
      console.log(
        `  review ${transcript.session + 1} (day ${transcript.day}): ${transcript.responses.length} model calls, ${empty} empty, ${transcript.ended}`,
      )
    },
  })
  console.log(`\n${model} on seed ${seed}:`)
  const episode = await runWorldEpisode({ scenario, seed, agent })
  const costs = worldDecisionCosts(scenario, episode)
  if (outDir) {
    writeFileSync(
      join(outDir, 'episode.json'),
      `${JSON.stringify({ model, promptFile: promptFile ?? null, episode, decisionCosts: costs }, null, 2)}\n`,
    )
  }

  const failed = episode.sessions.filter((session) => session.error !== undefined)
  console.log(`end value ${money(episode.end.value)} (gain ${money(episode.score.gain)})`)
  for (const row of comparison.rows) {
    const index = seeds.indexOf(seed)
    const same = index >= 0 ? `, ${money(row.values[index]!)} on seed ${seed}` : ''
    console.log(`  ${row.policy.padEnd(14)} mean ${money(row.mean)}${same}`)
  }
  console.log(
    `refused calls ${JSON.stringify(episode.score.refused)}, premature decisions ${episode.score.prematureDecisions.length}, overdrive days ${episode.score.overdriveDays}, late value ${money(episode.score.lateValue)}`,
  )
  if (failed.length > 0) {
    console.log(
      `sessions that failed (${failed.length}): ${failed.map((s) => `${s.index + 1}: ${s.error}`).join('; ')}`,
    )
  }
  console.log('costliest decisions, in expectation:')
  for (const cost of costs.slice(0, 5)) {
    console.log(
      `  day ${cost.day} ${JSON.stringify(cost.action)}: ${money(cost.expectedCost)} (realized ${money(cost.realizedCost)})`,
    )
  }
}

/** A subscription seat answers a burst with 429. Wait and try again, with a growing pause. */
function retryRateLimits(client: ChatClient): ChatClient {
  const waits = [30_000, 60_000, 120_000, 300_000]
  return {
    ...client,
    chat: async (request, opts) => {
      for (let attempt = 0; ; attempt++) {
        try {
          return await client.chat(request, opts)
        } catch (error) {
          const wait = waits[attempt]
          if (wait === undefined || !/\b429\b|rate.?limit/i.test(String(error))) throw error
          console.log(`  rate limited; waiting ${wait / 1000}s`)
          await new Promise((resolve) => setTimeout(resolve, wait))
        }
      }
    },
  }
}
