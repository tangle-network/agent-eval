/**
 * Analyst-vs-HALO head-to-head on a single OTLP trace — findings quality.
 *
 * OURS: the deterministic `behavioralAnalyst` (zero LLM) via `AnalystRegistry`
 *   → structured `AnalystFinding[]`, IDENTICAL on any model.
 * THEIRS: the real halo-engine over the same trace (chat-completions launcher
 *   so it runs on DeepSeek / any OpenAI-compatible backend) → free-form prose.
 *
 * The point this makes concrete: our analyst reproduces HALO's behavioral
 * diagnosis (context bloat, output decay, tool monoculture, missing
 * self-verification) deterministically, structured, at $0 — where HALO spends
 * tokens re-deriving the same numbers and can hallucinate the trend.
 *
 *   npx tsx analyst-vs-halo.ts <traces.jsonl> [--with-halo]
 *
 * --with-halo additionally runs the halo CLI (needs HALO_BIN + HALO_VENV_PY +
 * OPENAI_BASE_URL/OPENAI_API_KEY); omit it to print only the deterministic side.
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { AnalystRegistry, behavioralAnalyst, OtlpFileTraceStore } from '../../../src'

const execFileAsync = promisify(execFile)

async function ours(tracePath: string) {
  const reg = new AnalystRegistry()
  reg.register(behavioralAnalyst())
  const res = await reg.run('analyst-vs-halo', {
    traceStore: new OtlpFileTraceStore({ path: tracePath }),
  })
  return res.findings
}

async function theirs(tracePath: string): Promise<string> {
  const bin = process.env.HALO_BIN ?? 'halo'
  const args = [
    tracePath,
    '-p',
    'Diagnose the agent failures in these traces and suggest concrete, generalizable fixes.',
    '-m',
    process.env.BENCH_REFLECT_MODEL ?? 'deepseek-chat',
    '--max-depth',
    '0',
    '--max-turns',
    '20',
  ]
  const env = {
    ...process.env,
    ...(process.env.HALO_VENV_PY ? { HALO_VENV_PY: process.env.HALO_VENV_PY } : {}),
  }
  const { stdout } = await execFileAsync(bin, args, { maxBuffer: 64 * 1024 * 1024, env })
  return stdout.trim()
}

async function main() {
  const tracePath = process.argv[2]
  if (!tracePath) throw new Error('usage: analyst-vs-halo.ts <traces.jsonl> [--with-halo]')
  const withHalo = process.argv.includes('--with-halo')

  const t0 = Date.now()
  const findings = await ours(tracePath)
  console.log(
    `\n=== OURS — behavioralAnalyst (deterministic, $0, any-model) — ${Date.now() - t0}ms ===`,
  )
  console.log(`findings: ${findings.length}`)
  for (const f of findings) console.log(`  - [${f.severity}] ${f.subject}: ${f.claim}`)

  if (withHalo) {
    const h0 = Date.now()
    const out = await theirs(tracePath)
    console.log(`\n=== THEIRS — real halo-engine — ${Date.now() - h0}ms ===`)
    console.log(out.slice(-1600))
  } else {
    console.log('\n(run with --with-halo to print the real halo-engine diagnosis alongside)')
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e))
  process.exitCode = 1
})
