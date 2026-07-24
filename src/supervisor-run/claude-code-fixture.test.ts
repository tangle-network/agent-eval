/**
 * Invariants over a REAL Claude Code supervision tree.
 *
 * `tests/fixtures/supervisor-run/claude-code-session-*` was produced by
 * `claudeCodeSupervisorRunReader` from an actual Claude Code session
 * (`~/.claude/projects/-home-drew-code-supervisor-lab/fa9c4333-…jsonl` plus its
 * `subagents/` transcripts): 52 spawned agents, 47 settled, 11 mid-task steers.
 *
 * The fixture is here to hold the honesty contract against real data. Synthetic
 * fixtures can be written to pass; this one was written by the harness, and the
 * assertions below are the ones a fabricated zero would break.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isRolloutLine, type RolloutLine } from '../rollout/schema'
import { isUnavailable, SUPERVISOR_RUN_SCHEMA, type SupervisorRunReport } from './types'

const FIXTURES = join(process.cwd(), 'tests', 'fixtures', 'supervisor-run')

const report = JSON.parse(
  readFileSync(join(FIXTURES, 'claude-code-session-report.json'), 'utf8'),
) as SupervisorRunReport

const rows = readFileSync(join(FIXTURES, 'claude-code-session-rollout.jsonl'), 'utf8')
  .trim()
  .split('\n')
  .map((l) => JSON.parse(l) as RolloutLine)

describe('real Claude Code session — supervision tree', () => {
  it('recovered the tree from a harness we do not control', () => {
    expect(report.schema).toBe(SUPERVISOR_RUN_SCHEMA)
    expect(report.orchestration.workersSpawned).toBe(52)
    expect(report.orchestration.workersSettled).toBe(47)
    expect(report.orchestration.maxConcurrency).toBe(6)
    expect(report.orchestration.delegationDepth).toBe(1)
  })

  it('measured mid-task steering — the metric the harness was assumed not to support', () => {
    expect(report.orchestration.steers).toBe(11)
    expect(report.orchestration.steersDelivered).toBe(11)
  })

  it('reports every unmeasurable metric as unavailable-with-a-reason, never as 0', () => {
    for (const v of [
      report.economics.totalUsd,
      report.economics.brain.usd,
      report.economics.workers.usd,
      report.decision.accepted,
      report.decision.rejected,
      report.outcome.patch,
    ]) {
      expect(isUnavailable(v)).toBe(true)
    }
    expect(report.gaps.length).toBeGreaterThan(0)
    for (const gap of report.gaps) expect(gap).toMatch(/: .+/)
  })

  it('keeps the facts the transcript DOES carry as real numbers', () => {
    expect(report.economics.brain.tokensOut).toBe(1224083)
    expect(report.economics.brain.cacheRead).toBe(623246558)
    expect(report.economics.workers.tokensOut).toBe(960195)
    expect(report.decision.workerEvidenceBytes).toBe(75398)
  })

  it('mints one valid tangle.rollout.v1 row per invocation, joined by parent', () => {
    expect(rows).toHaveLength(53)
    expect(rows.every(isRolloutLine)).toBe(true)
    const roots = rows.filter((r) => r.parent_rollout_id === null)
    expect(roots).toHaveLength(1)
    expect(roots[0]?.role).toBe('supervisor')
    const workers = rows.filter((r) => r.role === 'worker')
    expect(workers).toHaveLength(52)
    expect(workers.every((w) => w.parent_rollout_id === roots[0]?.rollout_id)).toBe(true)
  })

  it('never prices a row the harness did not price', () => {
    expect(rows.every((r) => r.cost.usd === null)).toBe(true)
    // 19 of 52 subagent transcripts survived; the rest report null tokens, not 0.
    const withTokens = rows.filter((r) => r.role === 'worker' && r.cost.tokens_out !== null)
    expect(withTokens).toHaveLength(19)
    const pruned = rows.filter((r) => r.role === 'worker' && r.artifacts.transcript_ref === null)
    expect(pruned).toHaveLength(33)
    expect(pruned.every((r) => r.cost.tokens_in === null)).toBe(true)
  })

  it('leaves 5 workers unsettled — the live agents and one orphan that never notified', () => {
    const unsettled = rows.filter(
      (r) => r.role === 'worker' && !r.outcome.is_completed && !r.outcome.is_truncated,
    )
    expect(unsettled).toHaveLength(5)
    // This is why `idlePct` reads 0.5%: an agent with no task-notification is
    // counted live to the end of the transcript. Dropping the one 10-day orphan
    // moves utilization 1.117 → 0.122 and idle 0.5% → 91.5%. The report states
    // the measured value; the sensitivity is a property of the transcript, not
    // a bug in the analyzer.
    expect(report.orchestration.workerUtilization).toBeCloseTo(1.117, 3)
  })
})
