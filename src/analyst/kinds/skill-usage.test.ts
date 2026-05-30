import { describe, expect, it } from 'vitest'
import {
  buildSkillUsageReport,
  emitSkillUsageFindings,
  SKILL_USAGE_ANALYST,
  type SkillUsageRecord,
  type SkillUsageReport,
} from './skill-usage'

const AT = '2026-05-30T15:00:00Z'

function rec(over: Partial<SkillUsageRecord>): SkillUsageRecord {
  return {
    name: 'x',
    kind: 'public',
    path: '/skills/x/SKILL.md',
    lines: 120,
    directInvocations: 0,
    slashInvocations: 0,
    inboundRefs: 0,
    artifactCount: 0,
    tanglePrivateRefs: 0,
    hasReferencesDir: false,
    hasEvalsDir: false,
    logsRuns: false,
    hasTriggerPhrases: false,
    ...over,
  }
}

function report(records: SkillUsageRecord[]): SkillUsageReport {
  return { generatedFromTraces: 100, records }
}

describe('emitSkillUsageFindings', () => {
  it('flags a truly dead skill (zero across all signals) as the deprecation candidate', () => {
    // Regression: a skill with no usage of any kind must surface a high finding.
    const fs = emitSkillUsageFindings(
      report([rec({ name: 'dead', hasEvalsDir: true, logsRuns: true, hasTriggerPhrases: true })]),
      AT,
    )
    const dead = fs.find((f) => f.area === 'skill-usage')
    expect(dead).toBeDefined()
    expect(dead!.severity).toBe('high')
    expect(dead!.claim).toContain('zero usage across all signals')
  })

  it('does NOT flag an orchestrated/measurement-invisible skill as dead (the counter-lies case)', () => {
    // Regression: critical-audit/reflect (0 direct, but dispatched + 100s of artifacts)
    // must produce an INFO "usage is real" finding, never a dead/deprecate one.
    const fs = emitSkillUsageFindings(
      report([
        rec({
          name: 'critical-audit',
          inboundRefs: 2,
          artifactCount: 47,
          hasEvalsDir: true,
          logsRuns: true,
          hasTriggerPhrases: true,
        }),
      ]),
      AT,
    )
    const usage = fs.filter((f) => f.area === 'skill-usage')
    expect(usage).toHaveLength(1)
    expect(usage[0]!.severity).toBe('info')
    expect(usage[0]!.claim).toContain('used via orchestration/artifacts')
    // crucially: no "zero usage" / high-severity dead finding
    expect(fs.some((f) => f.claim.includes('zero usage'))).toBe(false)
  })

  it('flags a public-repo Tangle leak as a high safety finding', () => {
    const fs = emitSkillUsageFindings(
      report([
        rec({
          name: 'agent-eval',
          kind: 'public',
          tanglePrivateRefs: 5,
          directInvocations: 3,
          hasEvalsDir: true,
          logsRuns: true,
          hasTriggerPhrases: true,
        }),
      ]),
      AT,
    )
    const leak = fs.find((f) => f.area === 'safety')
    expect(leak).toBeDefined()
    expect(leak!.severity).toBe('high')
    expect(leak!.claim).toContain('5 Tangle-private reference')
  })

  it('does NOT flag a private skill with Tangle refs as a leak', () => {
    const fs = emitSkillUsageFindings(
      report([
        rec({
          name: 'blueprint-launch',
          kind: 'private',
          tanglePrivateRefs: 9,
          directInvocations: 3,
          hasEvalsDir: true,
          logsRuns: true,
          hasTriggerPhrases: true,
        }),
      ]),
      AT,
    )
    expect(fs.some((f) => f.area === 'safety')).toBe(false)
  })

  it('flags bloat only when over the line threshold AND no references/ split', () => {
    const bloated = emitSkillUsageFindings(
      report([
        rec({
          name: 'big',
          lines: 1392,
          hasReferencesDir: false,
          directInvocations: 3,
          hasEvalsDir: true,
          logsRuns: true,
          hasTriggerPhrases: true,
        }),
      ]),
      AT,
    )
    expect(bloated.find((f) => f.area === 'maintainability')?.claim).toContain('1392 lines')
    // same size but WITH references/ → no bloat finding
    const split = emitSkillUsageFindings(
      report([
        rec({
          name: 'big',
          lines: 1392,
          hasReferencesDir: true,
          directInvocations: 3,
          hasEvalsDir: true,
          logsRuns: true,
          hasTriggerPhrases: true,
        }),
      ]),
      AT,
    )
    expect(split.some((f) => f.area === 'maintainability')).toBe(false)
  })

  it('emits NOTHING for a healthy, well-used skill', () => {
    // Regression: no false positives on a skill that is used, discoverable,
    // split, evaluated, logged, and clean.
    const fs = emitSkillUsageFindings(
      report([
        rec({
          name: 'evolve',
          kind: 'public',
          lines: 234,
          directInvocations: 11,
          hasTriggerPhrases: true,
          hasReferencesDir: true,
          hasEvalsDir: true,
          logsRuns: true,
          tanglePrivateRefs: 0,
        }),
      ]),
      AT,
    )
    expect(fs).toEqual([])
  })

  it('produces stable finding_ids and propagates produced_at', () => {
    const r = report([rec({ name: 'dead' })])
    const a = emitSkillUsageFindings(r, AT)
    const b = emitSkillUsageFindings(r, '2099-01-01T00:00:00Z')
    expect(a[0]!.produced_at).toBe(AT)
    // identity (finding_id) is independent of produced_at
    expect(a[0]!.finding_id).toBe(b[0]!.finding_id)
    expect(a[0]!.finding_id).toMatch(/^f_[0-9a-f]{20}$/)
  })

  it('the analyst wires emission through analyze() with the canonical envelope', async () => {
    const fs = await SKILL_USAGE_ANALYST.analyze(report([rec({ name: 'dead' })]), {
      runId: 'r',
      correlationId: 'c',
      tags: { producedAt: AT },
    })
    expect(fs.length).toBeGreaterThan(0)
    for (const f of fs) {
      expect(f.schema_version).toBe('1.0.0')
      expect(f.analyst_id).toBe('skill-usage')
      expect(f.evidence_refs[0]!.kind).toBe('artifact')
      expect(f.confidence).toBeGreaterThan(0)
    }
  })
})

// Opt-in: scan the REAL local corpus + skill library. Skipped in CI (no corpus).
describe.skipIf(!process.env.SKILL_USAGE_REAL)('buildSkillUsageReport (real corpus)', () => {
  it('mines the live skill library and surfaces the audit-known findings', () => {
    const home = process.env.HOME ?? ''
    const report = buildSkillUsageReport({
      transcriptDirs: [`${home}/.claude/projects`],
      skillRoots: [
        { root: `${home}/code/dotfiles/claude/skills`, kind: 'public' },
        { root: `${home}/company/skills`, kind: 'private' },
      ],
      artifactRoots: [`${home}/code`, `${home}/company`],
      artifactAliases: { reflect: ['.evolve/reflections'] },
      maxTranscriptsPerDir: 0,
    })
    expect(report.records.length).toBeGreaterThan(20)
    const findings = emitSkillUsageFindings(report, AT)
    // eslint-disable-next-line no-console
    console.log(
      `[skill-usage] ${report.records.length} skills, ${report.generatedFromTraces} transcripts, ${findings.length} findings`,
    )
    expect(findings.length).toBeGreaterThan(0)
  })
})
