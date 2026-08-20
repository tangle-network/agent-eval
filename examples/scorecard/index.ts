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
import { agentProfileModelId } from '../../src/agent-profile'
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
const flash: AgentProfile = {
  name: 'flash-v3',
  version: 'v3',
  model: { default: 'deepseek-v4-flash' },
  resources: {
    skills: [
      { kind: 'inline', name: 'intake', content: 'intake skill' },
      { kind: 'inline', name: 'drafting', content: 'drafting skill' },
    ],
  },
}
const glm: AgentProfile = {
  name: 'glm-v3',
  version: 'v3',
  model: { default: 'glm-5.3' },
  resources: flash.resources,
}

console.log('flash hash:', agentProfileHash(flash).slice(0, 12))
console.log('glm   hash:', agentProfileHash(glm).slice(0, 12))

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
    costProvenance: { kind: 'observed', usd: 0 },
    tokenUsage: { input: 1, output: 1 },
    terminalOutcome: 'succeeded',
    outcome: { holdoutScore: score, raw: { score } },
    splitTag: 'holdout',
  }
}

const log = join(mkdtempSync(join(tmpdir(), 'scorecard-')), 'scorecard.jsonl')
console.log('log path:   ', log)

// ── Commit 1: baseline sweep across two personas on both profiles ────────
recordRunsToScorecard(
  log,
  [
    makeRun('persona-a', 0, 0.7, agentProfileModelId(flash)),
    makeRun('persona-a', 1, 0.72, agentProfileModelId(flash)),
    makeRun('persona-a', 2, 0.71, agentProfileModelId(flash)),
    makeRun('persona-b', 0, 0.6, agentProfileModelId(flash)),
    makeRun('persona-b', 1, 0.61, agentProfileModelId(flash)),
    makeRun('persona-b', 2, 0.59, agentProfileModelId(flash)),
  ],
  { profile: flash, commitSha: 'c1', timestamp: '2026-05-20T00:00:00Z' },
)
recordRunsToScorecard(
  log,
  [
    makeRun('persona-a', 0, 0.78, agentProfileModelId(glm)),
    makeRun('persona-a', 1, 0.8, agentProfileModelId(glm)),
    makeRun('persona-a', 2, 0.79, agentProfileModelId(glm)),
    makeRun('persona-b', 0, 0.55, agentProfileModelId(glm)),
    makeRun('persona-b', 1, 0.58, agentProfileModelId(glm)),
    makeRun('persona-b', 2, 0.56, agentProfileModelId(glm)),
  ],
  { profile: glm, commitSha: 'c1', timestamp: '2026-05-20T00:00:00Z' },
)

// ── Commit 2: a feature lands. flash improves on persona-a; glm
//             regresses on persona-b — exactly what an aggregate misses. ──
recordRunsToScorecard(
  log,
  [
    makeRun('persona-a', 0, 0.88, agentProfileModelId(flash)),
    makeRun('persona-a', 1, 0.9, agentProfileModelId(flash)),
    makeRun('persona-a', 2, 0.89, agentProfileModelId(flash)),
    makeRun('persona-b', 0, 0.6, agentProfileModelId(flash)),
    makeRun('persona-b', 1, 0.62, agentProfileModelId(flash)),
    makeRun('persona-b', 2, 0.61, agentProfileModelId(flash)),
  ],
  { profile: flash, commitSha: 'c2', timestamp: '2026-05-21T00:00:00Z' },
)
recordRunsToScorecard(
  log,
  [
    makeRun('persona-a', 0, 0.79, agentProfileModelId(glm)),
    makeRun('persona-a', 1, 0.81, agentProfileModelId(glm)),
    makeRun('persona-a', 2, 0.8, agentProfileModelId(glm)),
    makeRun('persona-b', 0, 0.4, agentProfileModelId(glm)), // ← regression
    makeRun('persona-b', 1, 0.42, agentProfileModelId(glm)),
    makeRun('persona-b', 2, 0.41, agentProfileModelId(glm)),
  ],
  { profile: glm, commitSha: 'c2', timestamp: '2026-05-21T00:00:00Z' },
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
