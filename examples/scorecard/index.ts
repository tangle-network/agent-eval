/**
 * Eval scorecard — `(persona × profile)` score timeline + per-cell diff.
 *
 * A single eval run answers "what's the score now." It cannot answer the
 * question that gates a feature PR: did this change regress persona P on
 * profile F, even while the aggregate improved? The scorecard answers it.
 *
 * Run with:
 *   pnpm tsx examples/scorecard/index.ts
 *
 * What this shows:
 *   - `AgentProfile` + `agentProfileHash` — the harness's unit of variation.
 *     Model lives inside the profile; skill/tool order does not matter; the
 *     `id` label is excluded from identity.
 *   - `recordRunsToScorecard` — fold any harness's `RunRecord[]` into the
 *     append-only JSONL log.
 *   - `loadScorecard` — fold the log into the queryable `Scorecard`.
 *   - `diffScorecard` — per-cell verdict using Cohen's d + Welch's t-test
 *     (`improved`/`regressed`/`flat`/`new`).
 *   - `formatScorecardDiff` — the PR-facing report.
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type AgentProfile,
  agentProfileHash,
  diffScorecard,
  formatScorecardDiff,
  loadScorecard,
  type RunRecord,
  recordRunsToScorecard,
} from '../../src/index'

// ── Two profiles you might benchmark side-by-side ────────────────────────
const sonnet: AgentProfile = {
  id: 'sonnet-v3',
  model: 'claude-sonnet-4-6@2025-04-15',
  skills: ['intake', 'drafting'],
  promptVersion: 'v3',
}
const opus: AgentProfile = {
  id: 'opus-v3',
  model: 'claude-opus-4-7@2025-04-15',
  skills: ['intake', 'drafting'],
  promptVersion: 'v3',
}

console.log('sonnet hash:', agentProfileHash(sonnet).slice(0, 12))
console.log('opus   hash:', agentProfileHash(opus).slice(0, 12))

// ── A minimal RunRecord-shaped object. Real harnesses build these via
//    `runEvalCampaign`; here we hand-roll them so the example runs offline. ──
function makeRun(scenarioId: string, seed: number, score: number, model: string): RunRecord {
  return {
    runId: `${scenarioId}-${model}-${seed}`,
    experimentId: 'demo',
    candidateId: 'cand',
    scenarioId,
    seed,
    model,
    promptHash: 'p',
    configHash: 'c',
    commitSha: 'sha',
    wallMs: 1,
    costUsd: 0,
    tokenUsage: { input: 1, output: 1 },
    outcome: { holdoutScore: score, raw: { score } },
    splitTag: 'holdout',
  } as RunRecord
}

const log = join(mkdtempSync(join(tmpdir(), 'scorecard-')), 'scorecard.jsonl')
console.log('log path:   ', log)

// ── Commit 1: baseline sweep across two personas on both profiles ────────
recordRunsToScorecard(
  log,
  [
    makeRun('persona-a', 0, 0.7, sonnet.model),
    makeRun('persona-a', 1, 0.72, sonnet.model),
    makeRun('persona-a', 2, 0.71, sonnet.model),
    makeRun('persona-b', 0, 0.6, sonnet.model),
    makeRun('persona-b', 1, 0.61, sonnet.model),
    makeRun('persona-b', 2, 0.59, sonnet.model),
  ],
  { profile: sonnet, commitSha: 'c1', timestamp: '2026-05-20T00:00:00Z' },
)
recordRunsToScorecard(
  log,
  [
    makeRun('persona-a', 0, 0.78, opus.model),
    makeRun('persona-a', 1, 0.8, opus.model),
    makeRun('persona-a', 2, 0.79, opus.model),
    makeRun('persona-b', 0, 0.55, opus.model),
    makeRun('persona-b', 1, 0.58, opus.model),
    makeRun('persona-b', 2, 0.56, opus.model),
  ],
  { profile: opus, commitSha: 'c1', timestamp: '2026-05-20T00:00:00Z' },
)

// ── Commit 2: a feature lands. sonnet improves on persona-a; opus
//             regresses on persona-b — exactly what an aggregate misses. ──
recordRunsToScorecard(
  log,
  [
    makeRun('persona-a', 0, 0.88, sonnet.model),
    makeRun('persona-a', 1, 0.9, sonnet.model),
    makeRun('persona-a', 2, 0.89, sonnet.model),
    makeRun('persona-b', 0, 0.6, sonnet.model),
    makeRun('persona-b', 1, 0.62, sonnet.model),
    makeRun('persona-b', 2, 0.61, sonnet.model),
  ],
  { profile: sonnet, commitSha: 'c2', timestamp: '2026-05-21T00:00:00Z' },
)
recordRunsToScorecard(
  log,
  [
    makeRun('persona-a', 0, 0.79, opus.model),
    makeRun('persona-a', 1, 0.81, opus.model),
    makeRun('persona-a', 2, 0.8, opus.model),
    makeRun('persona-b', 0, 0.4, opus.model), // ← regression
    makeRun('persona-b', 1, 0.42, opus.model),
    makeRun('persona-b', 2, 0.41, opus.model),
  ],
  { profile: opus, commitSha: 'c2', timestamp: '2026-05-21T00:00:00Z' },
)

// ── The PR-facing diff: per-cell verdict with Cohen's d + p-value. ───────
const card = loadScorecard(log)
const diff = diffScorecard(card)
console.log(`\n${formatScorecardDiff(diff)}`)

// Programmatic access — for a CI check that fails the build on regressions.
const regressions = diff.cells.filter((c) => c.verdict === 'regressed')
if (regressions.length > 0) {
  console.log(`\n${regressions.length} cell(s) regressed — a CI check would block the merge.`)
}
