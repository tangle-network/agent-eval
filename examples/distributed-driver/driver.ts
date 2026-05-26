/**
 * Distributed-driver reference — DRIVER side.
 *
 * Runs `runEval` against a remote worker via `httpDispatch`. Worker
 * should be running in another terminal: `pnpm tsx
 * examples/distributed-driver/worker.ts`.
 *
 * Run: `pnpm tsx examples/distributed-driver/driver.ts`
 * Env:
 *   WORKER_URL   single worker (default http://localhost:8080/dispatch)
 *   WORKER_TOKEN bearer token (default dev-token)
 *
 * For multi-region fan-out, set:
 *   WORKER_URL_US   http://us.example.com/dispatch
 *   WORKER_URL_EU   http://eu.example.com/dispatch
 *   WORKER_URL_AP   http://ap.example.com/dispatch
 * The driver picks the region per scenario from `tags`.
 */

import { httpDispatch } from '../../src/adapters/http'
import {
  type JudgeConfig,
  type Scenario,
  inMemoryCampaignStorage,
  runEval,
} from '../../src/contract'

interface MarketingScenario extends Scenario {
  blurb: string
  surface: 'landing-hero' | 'tweet' | 'email-subject'
  audience: string
}

interface MarketingArtifact {
  rewrite: string
  workerId: string
}

const scenarios: MarketingScenario[] = [
  { id: 's-us-1', kind: 'marketing', blurb: 'B2B SaaS for engineers.', surface: 'landing-hero', audience: 'engineering leaders', tags: ['us'] },
  { id: 's-eu-1', kind: 'marketing', blurb: 'Privacy-first analytics.', surface: 'tweet', audience: 'EU SMBs', tags: ['eu'] },
  { id: 's-ap-1', kind: 'marketing', blurb: 'Mobile-first fintech.', surface: 'email-subject', audience: 'APAC consumers', tags: ['ap'] },
  { id: 's-us-2', kind: 'marketing', blurb: 'Cloud cost optimization.', surface: 'landing-hero', audience: 'CTOs', tags: ['us'] },
]

const judge: JudgeConfig<MarketingArtifact, MarketingScenario> = {
  name: 'length-and-audience',
  dimensions: [
    { key: 'length_ok', description: 'Output is non-empty and not absurdly long.' },
    { key: 'audience_mention', description: 'Mentions the audience by name.' },
  ],
  async score({ artifact, scenario }) {
    const lengthOk = artifact.rewrite.length > 10 && artifact.rewrite.length < 500
    const audienceMention = artifact.rewrite.toLowerCase().includes(scenario.audience.split(' ')[0]?.toLowerCase() ?? '')
    const dims = {
      length_ok: lengthOk ? 1 : 0,
      audience_mention: audienceMention ? 1 : 0,
    }
    return {
      dimensions: dims,
      composite: (dims.length_ok + dims.audience_mention) / 2,
      notes: `worker=${artifact.workerId}`,
    }
  },
}

const TOKEN = process.env.WORKER_TOKEN ?? 'dev-token'

// Multi-region URL resolution. When the per-region env vars are set
// the driver fans cells across them via cellPlacement; otherwise
// everything routes to WORKER_URL.
const SINGLE_URL = process.env.WORKER_URL ?? 'http://localhost:8080/dispatch'
const REGION_URLS: Record<string, string | undefined> = {
  us: process.env.WORKER_URL_US,
  eu: process.env.WORKER_URL_EU,
  ap: process.env.WORKER_URL_AP,
}
const IS_MULTIREGION = Object.values(REGION_URLS).some((u) => u)

const dispatch = httpDispatch<MarketingScenario, MarketingArtifact>({
  resolveUrl: ({ placement }) => {
    if (!IS_MULTIREGION) return SINGLE_URL
    return REGION_URLS[placement ?? 'us'] ?? SINGLE_URL
  },
  auth: TOKEN,
  timeoutMs: 60_000,
  retries: 2,
})

async function main() {
  console.log(IS_MULTIREGION ? '═══ Multi-region campaign ═══' : '═══ Single-worker campaign ═══')
  if (IS_MULTIREGION) {
    for (const [k, v] of Object.entries(REGION_URLS)) console.log(`  ${k}: ${v ?? '(unset)'}`)
  } else {
    console.log(`  worker: ${SINGLE_URL}`)
  }

  const result = await runEval<MarketingScenario, MarketingArtifact>({
    scenarios,
    dispatch,
    judges: [judge],
    storage: inMemoryCampaignStorage(),
    runDir: `mem://distributed-driver-${Date.now()}`,
    maxConcurrency: 4,
    cellPlacement: IS_MULTIREGION
      ? ({ scenario }) => {
          const tag = scenario.tags?.find((t) => t === 'us' || t === 'eu' || t === 'ap')
          return tag ?? 'us'
        }
      : undefined,
  })

  console.log('\n─── Per-scenario composite ───')
  for (const [id, agg] of Object.entries(result.aggregates.byScenario)) {
    console.log(`  ${id}: ${agg.meanComposite.toFixed(3)} (n=${agg.n})`)
  }
  const mean = Object.values(result.aggregates.byScenario).reduce((s, a) => s + a.meanComposite, 0) / scenarios.length
  console.log(`\nOverall composite mean: ${mean.toFixed(3)}`)
  console.log(`Cells executed: ${result.aggregates.cellsExecuted}, failed: ${result.aggregates.cellsFailed}`)
}

main().catch((err) => {
  console.error('driver failed:', err)
  process.exit(1)
})
