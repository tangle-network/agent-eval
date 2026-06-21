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
 *   - canonical `AgentProfile` + `agentProfileHash` — the harness's unit of
 *     variation. Model, prompt, tools, skills, and resources live inside the
 *     profile; the `name` label is excluded from identity.
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
  agentProfileModelId,
  diffScorecard,
  formatScorecardDiff,
  loadScorecard,
  type RunRecord,
  recordRunsToScorecard,
} from '../../src/index'

// ── Two profiles you might benchmark side-by-side ────────────────────────
const sonnet: AgentProfile = {
  name: 'sonnet-v3',
  version: 'v3',
  model: { default: 'claude-sonnet-4-6@2025-04-15' },
  resources: {
    skills: [
      { kind: 'inline', name: 'intake', content: 'intake skill' },
      { kind: 'inline', name: 'drafting', content: 'drafting skill' },
    ],
  },
}
const opus: AgentProfile = {
  name: 'opus-v3',
  version: 'v3',
  model: { default: 'claude-opus-4-7@2025-04-15' },
  resources: sonnet.resources,
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
    makeRun('persona-a', 0, 0.7, agentProfileModelId(sonnet)),
    makeRun('persona-a', 1, 0.72, agentProfileModelId(sonnet)),
    makeRun('persona-a', 2, 0.71, agentProfileModelId(sonnet)),
    makeRun('persona-b', 0, 0.6, agentProfileModelId(sonnet)),
    makeRun('persona-b', 1, 0.61, agentProfileModelId(sonnet)),
    makeRun('persona-b', 2, 0.59, agentProfileModelId(sonnet)),
  ],
  { profile: sonnet, commitSha: 'c1', timestamp: '2026-05-20T00:00:00Z' },
)
recordRunsToScorecard(
  log,
  [
    makeRun('persona-a', 0, 0.78, agentProfileModelId(opus)),
    makeRun('persona-a', 1, 0.8, agentProfileModelId(opus)),
    makeRun('persona-a', 2, 0.79, agentProfileModelId(opus)),
    makeRun('persona-b', 0, 0.55, agentProfileModelId(opus)),
    makeRun('persona-b', 1, 0.58, agentProfileModelId(opus)),
    makeRun('persona-b', 2, 0.56, agentProfileModelId(opus)),
  ],
  { profile: opus, commitSha: 'c1', timestamp: '2026-05-20T00:00:00Z' },
)

// ── Commit 2: a feature lands. sonnet improves on persona-a; opus
//             regresses on persona-b — exactly what an aggregate misses. ──
recordRunsToScorecard(
  log,
  [
    makeRun('persona-a', 0, 0.88, agentProfileModelId(sonnet)),
    makeRun('persona-a', 1, 0.9, agentProfileModelId(sonnet)),
    makeRun('persona-a', 2, 0.89, agentProfileModelId(sonnet)),
    makeRun('persona-b', 0, 0.6, agentProfileModelId(sonnet)),
    makeRun('persona-b', 1, 0.62, agentProfileModelId(sonnet)),
    makeRun('persona-b', 2, 0.61, agentProfileModelId(sonnet)),
  ],
  { profile: sonnet, commitSha: 'c2', timestamp: '2026-05-21T00:00:00Z' },
)
recordRunsToScorecard(
  log,
  [
    makeRun('persona-a', 0, 0.79, agentProfileModelId(opus)),
    makeRun('persona-a', 1, 0.81, agentProfileModelId(opus)),
    makeRun('persona-a', 2, 0.8, agentProfileModelId(opus)),
    makeRun('persona-b', 0, 0.4, agentProfileModelId(opus)), // ← regression
    makeRun('persona-b', 1, 0.42, agentProfileModelId(opus)),
    makeRun('persona-b', 2, 0.41, agentProfileModelId(opus)),
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
