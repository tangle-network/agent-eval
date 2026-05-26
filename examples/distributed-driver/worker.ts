/**
 * Distributed-driver reference — WORKER side.
 *
 * Exposes a local `Dispatch` over HTTP via `runDispatchServer`. Pair with
 * `driver.ts` (which calls `httpDispatch` pointing here).
 *
 * Run: `pnpm tsx examples/distributed-driver/worker.ts`
 * Env:  PORT (default 8080), WORKER_TOKEN (default 'dev-token')
 */

import type { Dispatch } from '../../src/contract'
import type { Scenario } from '../../src/contract'
import { runDispatchServer } from '../../src/adapters/http'

interface MarketingScenario extends Scenario {
  blurb: string
  surface: 'landing-hero' | 'tweet' | 'email-subject'
  audience: string
}

interface MarketingArtifact {
  rewrite: string
  workerId: string
}

const workerId = process.env.WORKER_ID ?? `worker-${Math.random().toString(36).slice(2, 8)}`

// Stub agent — replace with your real one. Returns a deterministic
// rewrite plus the worker id so the driver can see which worker
// handled each cell.
const dispatch: Dispatch<MarketingScenario, MarketingArtifact> = async (scenario, ctx) => {
  // Real implementations call your LLM here. The point is the wire shape
  // is transparent: ctx.signal cancels, ctx.placement carries the
  // routing key the driver supplied (so a multi-tenant worker could
  // pick a sub-route based on placement).
  await new Promise((r) => setTimeout(r, 50))
  if (ctx.signal.aborted) throw new Error('aborted before completion')
  const rewrite = `[${workerId}] ${scenario.blurb} → punchier for ${scenario.audience}`
  return { rewrite, workerId }
}

const port = Number.parseInt(process.env.PORT ?? '8080', 10)
const token = process.env.WORKER_TOKEN ?? 'dev-token'

const handle = await runDispatchServer<MarketingScenario, MarketingArtifact>({
  dispatch,
  port,
  auth: token,
  onRequest: ({ cellId, durationMs, success, error }) => {
    if (success) console.log(`✓ ${workerId} ${cellId} (${durationMs}ms)`)
    else console.error(`✗ ${workerId} ${cellId} (${durationMs}ms): ${error instanceof Error ? error.message : error}`)
  },
})

console.log(`worker ${workerId} listening on http://localhost:${handle.port}/dispatch`)
console.log(`auth: Bearer ${token}`)
console.log(`Ctrl-C to stop.`)

process.on('SIGINT', async () => {
  console.log('\nshutting down...')
  await handle.close()
  process.exit(0)
})
