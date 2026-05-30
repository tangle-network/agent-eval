/**
 * Skill-usage analyst — a DETERMINISTIC `Analyst` over a Claude/Codex skill
 * library + its trace corpus. Unlike the trace-store kinds (failure-mode,
 * improvement, ...) this kind calls no LLM: it mines real usage and skill
 * structure and emits findings by rule.
 *
 * It exists because the naive "Skill-tool invocation count" lies low — it
 * misses orchestrated sub-dispatch (a leaf skill run BY /pursue or /governor
 * logs under the parent), slash-command entry, local-script bypass, and
 * on-disk artifacts. The 2026-05-30 skill audit found 39/53 skills at zero
 * direct invocations, yet only one was a genuine cut: the rest were
 * measurement-invisible or discovery-limited. This analyst encodes that
 * lesson as a multi-signal usage model so a cheap repeatable pass can keep
 * the library honest, and so the expensive audit workflow's verdicts can
 * GEPA-distill it toward agreement (see `gold/skill-verdicts.gold.jsonl`).
 *
 * Report-building (`buildSkillUsageReport`, an fs scan) is separated from
 * finding emission (`SkillUsageAnalyst.analyze`, pure) so the slow scan runs
 * once at the registry boundary and the rule logic stays unit-testable.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { Analyst, AnalystContext, AnalystFinding, AnalystSeverity } from '../types'
import { computeFindingId } from '../types'

// ── Input model ──────────────────────────────────────────────────────

export type SkillKind = 'public' | 'private'

/** One skill's multi-signal usage + structure. All counts are deterministic. */
export interface SkillUsageRecord {
  name: string
  kind: SkillKind
  /** Absolute path to the skill's SKILL.md. */
  path: string
  lines: number
  /** `"skill":"<name>"` Skill-tool invocations across the trace corpus. */
  directInvocations: number
  /** `<command-name>/<name>` slash invocations across the trace corpus. */
  slashInvocations: number
  /** Sibling skills whose SKILL.md dispatches to this one (`/<name>`). Proxy
   *  for orchestrated sub-dispatch the per-skill counter cannot see. */
  inboundRefs: number
  /** On-disk artifacts attributable to the skill (e.g. `.evolve/<name>/**`). */
  artifactCount: number
  /** Tangle-private reference count in the body (leak signal for public skills). */
  tanglePrivateRefs: number
  hasReferencesDir: boolean
  hasEvalsDir: boolean
  /** Body mentions `skill-runs.jsonl` (visible to /reflect + /governor). */
  logsRuns: boolean
  /** Description carries an explicit `Triggers:` clause / trigger phrases. */
  hasTriggerPhrases: boolean
}

export interface SkillUsageReport {
  generatedFromTraces: number
  records: SkillUsageRecord[]
}

export interface SkillUsageScanConfig {
  /** Dirs holding `*.jsonl` transcripts (Claude `~/.claude/projects`, Codex sessions). */
  transcriptDirs: string[]
  /** Skill roots to scan; each dir directly under `root` with a `SKILL.md` is a skill. */
  skillRoots: { root: string; kind: SkillKind }[]
  /** Roots scanned for `<root>/.evolve/<skill>` artifact dirs. */
  artifactRoots?: string[]
  /** Token-prefixed mappings: skill name → extra artifact subpaths under an artifactRoot
   *  (e.g. reflect → `.evolve/reflections`). Catches non-eponymous artifact dirs. */
  artifactAliases?: Record<string, string[]>
  /** Cap files read per transcript dir (bounds a huge corpus); 0 = unbounded. */
  maxTranscriptsPerDir?: number
}

// ── Deterministic thresholds ─────────────────────────────────────────

/** Anthropic's authoring guidance keeps SKILL.md short; past this with no
 *  `references/` split the body burns context budget every session. */
const BLOAT_LINE_THRESHOLD = 300

const TANGLE_PRIVATE_RE =
  /\b(cli-bridge|tangletools|ops-board|drew-gtr-pro|@tangle-network\/|~\/company|tangle\.tools|gtm-agent)\b|\bkimi\b|\btcloud\b/gi
const TRIGGER_RE = /triggers?\s*[:-]/i

// ── Report builder (fs scan — slow, runs once at the registry boundary) ──

function listSkillDirs(root: string): { name: string; path: string }[] {
  if (!existsSync(root)) return []
  const out: { name: string; path: string }[] = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
    const skillMd = join(root, entry.name, 'SKILL.md')
    if (existsSync(skillMd)) out.push({ name: entry.name, path: skillMd })
  }
  return out
}

function walkJsonl(dir: string, cap: number): string[] {
  if (!existsSync(dir)) return []
  const files: string[] = []
  const stack = [dir]
  while (stack.length) {
    const cur = stack.pop()!
    let entries
    try {
      entries = readdirSync(cur, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      const full = join(cur, e.name)
      if (e.isDirectory()) stack.push(full)
      else if (e.name.endsWith('.jsonl')) {
        files.push(full)
        if (cap > 0 && files.length >= cap) return files
      }
    }
  }
  return files
}

function frontmatterDescription(body: string): string {
  const fm = /^---\n([\s\S]*?)\n---/.exec(body)
  const block = fm?.[1] ?? ''
  const m = /description:\s*(.+)/i.exec(block)
  return m?.[1] ?? ''
}

function countArtifacts(roots: string[], name: string, aliases: string[]): number {
  let n = 0
  for (const root of roots) {
    const candidates = [join(root, '.evolve', name), ...aliases.map((a) => join(root, a))]
    for (const dir of candidates) {
      if (!existsSync(dir)) continue
      try {
        if (statSync(dir).isDirectory()) n += readdirSync(dir).length
        else n += 1
      } catch {
        /* unreadable — skip */
      }
    }
  }
  return n
}

/** Scan the corpus + skill roots into a {@link SkillUsageReport}. Deterministic. */
export function buildSkillUsageReport(config: SkillUsageScanConfig): SkillUsageReport {
  const skills = config.skillRoots.flatMap(({ root, kind }) =>
    listSkillDirs(root).map((s) => ({ ...s, kind })),
  )
  const names = skills.map((s) => s.name)

  // One pass over the corpus accumulating direct + slash counts per skill.
  const direct = new Map<string, number>(names.map((n) => [n, 0]))
  const slash = new Map<string, number>(names.map((n) => [n, 0]))
  const skillRe = /"skill"\s*:\s*"([a-z0-9_:-]+)"/g
  const cmdRe = /<command-name>\/?([a-z0-9_:-]+)<\/command-name>/g
  let transcripts = 0
  for (const dir of config.transcriptDirs) {
    for (const file of walkJsonl(dir, config.maxTranscriptsPerDir ?? 0)) {
      transcripts += 1
      let data: string
      try {
        data = readFileSync(file, 'utf8')
      } catch {
        continue
      }
      for (const m of data.matchAll(skillRe)) {
        const g = m[1]
        if (!g) continue
        const n = g.split(':').pop() ?? g
        const prev = direct.get(n)
        if (prev !== undefined) direct.set(n, prev + 1)
      }
      for (const m of data.matchAll(cmdRe)) {
        const g = m[1]
        if (g === undefined) continue
        const prev = slash.get(g)
        if (prev !== undefined) slash.set(g, prev + 1)
      }
    }
  }

  // Read each skill body once; compute structure + inbound refs across siblings.
  const bodies = new Map<string, string>()
  for (const s of skills) {
    try {
      bodies.set(s.name, readFileSync(s.path, 'utf8'))
    } catch {
      bodies.set(s.name, '')
    }
  }
  const inbound = new Map<string, number>(names.map((n) => [n, 0]))
  for (const target of names) {
    const ref = new RegExp(`/${target}\\b|\\[\\[${target}\\]\\]`)
    for (const s of skills) {
      if (s.name === target) continue
      if (ref.test(bodies.get(s.name) ?? '')) inbound.set(target, inbound.get(target)! + 1)
    }
  }

  const records: SkillUsageRecord[] = skills.map((s) => {
    const body = bodies.get(s.name) ?? ''
    const dir = s.path.replace(/\/SKILL\.md$/, '')
    return {
      name: s.name,
      kind: s.kind,
      path: s.path,
      lines: body ? body.split('\n').length : 0,
      directInvocations: direct.get(s.name) ?? 0,
      slashInvocations: slash.get(s.name) ?? 0,
      inboundRefs: inbound.get(s.name) ?? 0,
      artifactCount: countArtifacts(
        config.artifactRoots ?? [],
        s.name,
        config.artifactAliases?.[s.name] ?? [],
      ),
      tanglePrivateRefs: (body.match(TANGLE_PRIVATE_RE) ?? []).length,
      hasReferencesDir: existsSync(join(dir, 'references')),
      hasEvalsDir: existsSync(join(dir, 'evals')),
      logsRuns: body.includes('skill-runs.jsonl'),
      hasTriggerPhrases: TRIGGER_RE.test(frontmatterDescription(body) || body.slice(0, 600)),
    }
  })
  return { generatedFromTraces: transcripts, records }
}

// ── Finding emission (pure — unit-testable, no LLM, no fs) ────────────

const ANALYST_ID = 'skill-usage'

function finding(
  area: string,
  subject: string,
  claim: string,
  severity: AnalystSeverity,
  confidence: number,
  producedAt: string,
  recommended: string,
  evidenceUri: string,
  rationale?: string,
): AnalystFinding {
  return {
    schema_version: '1.0.0',
    finding_id: computeFindingId({ analyst_id: ANALYST_ID, area, subject, claim }),
    analyst_id: ANALYST_ID,
    produced_at: producedAt,
    severity,
    area,
    claim,
    rationale,
    evidence_refs: [{ kind: 'artifact', uri: evidenceUri }],
    recommended_action: recommended,
    confidence,
    subject,
  }
}

/** Pure rule pass over a report → findings. Exported for direct/unit use. */
export function emitSkillUsageFindings(
  report: SkillUsageReport,
  producedAt: string,
): AnalystFinding[] {
  const out: AnalystFinding[] = []
  for (const r of report.records) {
    const directTotal = r.directInvocations + r.slashInvocations
    const trueUsage = directTotal + r.inboundRefs + r.artifactCount

    // 1. Dead: no usage signal of ANY kind. The only real deprecation candidate.
    if (trueUsage === 0) {
      out.push(
        finding(
          'skill-usage',
          r.name,
          `Skill '${r.name}' has zero usage across all signals (direct, slash, inbound-refs, artifacts)`,
          'high',
          0.6,
          producedAt,
          'Confirm the skill covers a real recurring job; if not, deprecate. Zero true usage is the only deterministic deprecation candidate.',
          r.path,
          'No Skill-tool call, no slash invocation, no sibling dispatches to it, and no on-disk artifacts.',
        ),
      )
    } else if (directTotal === 0 && r.inboundRefs + r.artifactCount > 0) {
      // 2. Measurement-invisible: real use via orchestration/artifacts, never invoked directly.
      out.push(
        finding(
          'skill-usage',
          r.name,
          `Skill '${r.name}' shows 0 direct invocations but is used via orchestration/artifacts (inbound=${r.inboundRefs}, artifacts=${r.artifactCount})`,
          'info',
          0.8,
          producedAt,
          'Do NOT treat as unused — usage is real but logged under parent skills or on disk. Strengthen direct-invocation discovery only if direct use is desired.',
          r.path,
          'The Skill-tool counter undercounts orchestrated/chained leaf skills.',
        ),
      )
    }

    // 3. Discovery gap: low direct use AND weak trigger surface.
    if (directTotal <= 2 && !r.hasTriggerPhrases) {
      out.push(
        finding(
          'discoverability',
          r.name,
          `Skill '${r.name}' is rarely invoked directly and its description has no explicit trigger phrases`,
          'medium',
          0.7,
          producedAt,
          'Add a `Triggers:` clause with verbatim user phrases to the frontmatter description so the model auto-invokes it.',
          r.path,
        ),
      )
    }

    // 4. Public-repo leak.
    if (r.kind === 'public' && r.tanglePrivateRefs > 0) {
      out.push(
        finding(
          'safety',
          r.name,
          `Public skill '${r.name}' carries ${r.tanglePrivateRefs} Tangle-private reference(s)`,
          'high',
          0.75,
          producedAt,
          'Sanitize incidental internal refs (cli-bridge/kimi/tcloud/~company/private repos) or relocate to a private repo. Verify @tangle-network/* refs are to PUBLISHED packages before treating as a leak.',
          r.path,
        ),
      )
    }

    // 5. Bloat / no progressive disclosure.
    if (r.lines > BLOAT_LINE_THRESHOLD && !r.hasReferencesDir) {
      out.push(
        finding(
          'maintainability',
          r.name,
          `Skill '${r.name}' is ${r.lines} lines with no references/ split (progressive disclosure)`,
          'medium',
          0.8,
          producedAt,
          `Split detail into references/ loaded on demand; keep SKILL.md a short overview. ${r.lines} lines load into every session's context budget.`,
          r.path,
        ),
      )
    }

    // 6. No evals (Anthropic's ">=3 evals before docs" rule).
    if (!r.hasEvalsDir) {
      out.push(
        finding(
          'data-quality',
          r.name,
          `Skill '${r.name}' ships no evals/`,
          'low',
          0.6,
          producedAt,
          'Add evals/evals.json with >=3 scenarios proving the skill beats baseline; gives regression coverage.',
          r.path,
        ),
      )
    }

    // 7. No run logging → invisible to /reflect and /governor.
    if (!r.logsRuns) {
      out.push(
        finding(
          'observability',
          r.name,
          `Skill '${r.name}' never appends to .evolve/skill-runs.jsonl`,
          'low',
          0.55,
          producedAt,
          'Append one run line to .evolve/skill-runs.jsonl on completion, or declare it a non-logging leaf, so the self-improvement loop can see it ran.',
          r.path,
        ),
      )
    }
  }
  return out
}

// ── The Analyst ──────────────────────────────────────────────────────

export class SkillUsageAnalyst implements Analyst<SkillUsageReport> {
  readonly id = ANALYST_ID
  readonly description =
    'Deterministic multi-signal skill-usage analysis: flags dead skills, measurement-invisible (orchestrated) usage, discovery gaps, public-repo leaks, bloat, missing evals, and missing run-logging.'
  readonly inputKind = 'custom' as const
  readonly cost = { kind: 'deterministic' as const, est_usd_per_run: 0 }
  readonly version = '1.0.0'

  async analyze(input: SkillUsageReport, ctx: AnalystContext): Promise<AnalystFinding[]> {
    const producedAt = ctx.tags?.producedAt ?? new Date().toISOString()
    ctx.log?.(
      `skill-usage: ${input.records.length} skills over ${input.generatedFromTraces} transcripts`,
    )
    return emitSkillUsageFindings(input, producedAt)
  }
}

export const SKILL_USAGE_ANALYST = new SkillUsageAnalyst()
