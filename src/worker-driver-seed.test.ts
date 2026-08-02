/**
 * The worker-driver knowledge is DATA now. These tests pin the same
 * contract the deleted `buildWorkerDriverSystemPrompt`'s tests pinned — a
 * future edit cannot quietly soften the doctrine or strip a harness brief —
 * plus the discriminating assertion that the deleted function stays deleted:
 * if the role-as-function path returns to the public surface, this suite
 * fails.
 */

import { describe, expect, it } from 'vitest'
import * as api from './index'
import { HARNESS_BRIEFS, WORKER_DRIVER_DOCTRINE } from './worker-driver-seed'

describe('WORKER_DRIVER_DOCTRINE — the driving contract as seed data', () => {
  it('demands rich, high-signal instructions and forbids thin steers', () => {
    expect(WORKER_DRIVER_DOCTRINE).toMatch(/dense, specific/i)
    expect(WORKER_DRIVER_DOCTRINE).toMatch(/thin steer/i)
    expect(WORKER_DRIVER_DOCTRINE).toMatch(/out-drive a human/i)
  })

  it('drives the worker to exploit its harness — parallelize, sub-agents, run-to-completion', () => {
    expect(WORKER_DRIVER_DOCTRINE).toMatch(/parallel/i)
    expect(WORKER_DRIVER_DOCTRINE).toMatch(/sub-agent/i)
    expect(WORKER_DRIVER_DOCTRINE).toMatch(/run to completion/i)
  })

  it('requires verification and refuses self-declared completion', () => {
    expect(WORKER_DRIVER_DOCTRINE).toMatch(/verif/i)
    expect(WORKER_DRIVER_DOCTRINE).toMatch(/never accept "done" without the check/i)
    expect(WORKER_DRIVER_DOCTRINE).toMatch(/the deliverable's checker does/i)
  })

  it('reads the worker trace, decomposes, and names the traps each turn', () => {
    expect(WORKER_DRIVER_DOCTRINE).toMatch(/not what it claims/i)
    expect(WORKER_DRIVER_DOCTRINE).toMatch(/in sequence/i)
    expect(WORKER_DRIVER_DOCTRINE).toMatch(/failure modes/i)
  })
})

describe('HARNESS_BRIEFS — capability briefs as seed data', () => {
  it('covers the conventional harnesses', () => {
    for (const harness of ['claude-code', 'codex', 'opencode', 'router-tools']) {
      expect(HARNESS_BRIEFS[harness], `brief for ${harness}`).toBeTruthy()
    }
  })

  it('claude-code brief names sub-agent fan-out, web access, and MCP', () => {
    const brief = HARNESS_BRIEFS['claude-code']!
    expect(brief).toMatch(/parallel/i)
    expect(brief).toMatch(/sub-agent/i)
    expect(brief).toMatch(/WebSearch/i)
    expect(brief).toMatch(/MCP/i)
  })

  it('every brief carries a caveat, not just capabilities — no brief is a bare feature list', () => {
    for (const [harness, brief] of Object.entries(HARNESS_BRIEFS)) {
      expect(brief.length, `brief for ${harness}`).toBeGreaterThan(80)
      expect(brief, `brief for ${harness} should mention a limit or a "never/no/not"`).toMatch(
        /\b(no|not|never|cannot)\b/i,
      )
    }
  })
})

describe('role-as-function stays deleted (discriminating)', () => {
  it('the package no longer exports buildWorkerDriverSystemPrompt — the knowledge is data', () => {
    expect(api).not.toHaveProperty('buildWorkerDriverSystemPrompt')
    expect(api).toHaveProperty('WORKER_DRIVER_DOCTRINE')
    expect(api).toHaveProperty('HARNESS_BRIEFS')
  })
})
