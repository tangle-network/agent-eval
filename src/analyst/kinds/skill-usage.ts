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

import { type Dirent, existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'




// ── Input model ──────────────────────────────────────────────────────

type SkillKind = 'public' | 'private'

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
    let entries: Dirent[]
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







// ── The Analyst ──────────────────────────────────────────────────────




