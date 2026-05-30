/**
 * @experimental — surface may evolve as production agents wire it in.
 *
 * Structured agent profile — the system prompt as named, addressable sections
 * instead of one opaque blob. The self-improvement loop targets ONE evolvable
 * `domain` section at a time (via `applyDomainPatch`); the role, environment,
 * tool conventions, and skill roster stay fixed so a candidate diff is
 * attributable to a single section rather than a whole-prompt rewrite.
 *
 * `renderProfile` emits the prompt in a fixed five-zone order — role,
 * Environment, Tool conventions, Skills, Domain guidance — mirroring the layout
 * of Harvey LAB's `harness/system_prompt.md` (workspace root, read-only
 * documents, output dir, skills dir). `profileToSurface` is the bridge to the
 * loop's string `MutableSurface`: a profile renders to exactly the text a
 * candidate is scored on.
 *
 * Distinct from the benchmark-cell `AgentProfile` in `src/agent-profile.ts`,
 * which fingerprints a (model, skills, prompt, tools) cell for the scorecard.
 * That one is the unit of variation; this one is the prompt CONTENT being
 * varied. Consume this module by its own path (`@tangle-network/agent-eval`
 * exposes it under the `profile` namespace) to avoid the name clash.
 */

import { surfaceContentHash } from '../campaign/provenance'

/** A named, addressable region of the system prompt. `evolvable` marks whether
 *  the self-improvement loop is allowed to patch its body; fixed scaffolding
 *  (e.g. a compliance preamble) sets `evolvable: false`. */
export interface AgentProfileSection {
  id: string
  title: string
  body: string
  evolvable: boolean
}

/** A skill the agent can invoke. `triggers` are the phrases/conditions that
 *  should activate it; `scriptsDir` points at its executable scripts when the
 *  skill ships code (mirrors Harvey's `skills/<name>/scripts/`). */
export interface ProfileSkill {
  name: string
  description: string
  triggers: string[]
  scriptsDir?: string
}

/** The structured system prompt. The first four fields are fixed scaffolding;
 *  `domain` is the evolvable surface the loop optimizes. */
export interface AgentProfile {
  role: string
  environment: string
  toolConventions: string
  skills: ProfileSkill[]
  domain: AgentProfileSection[]
}

function renderSkill(skill: ProfileSkill): string {
  const lines = [`### ${skill.name}`, skill.description]
  if (skill.triggers.length > 0) {
    lines.push(`Triggers: ${skill.triggers.join(', ')}`)
  }
  if (skill.scriptsDir !== undefined) {
    lines.push(`Scripts: ${skill.scriptsDir}`)
  }
  return lines.join('\n')
}

/**
 * Emit the sectioned system prompt in fixed order: role text, then
 * `## Environment`, `## Tool conventions`, `## Skills` (each skill as
 * `### <name>` + description + triggers), `## Domain guidance` (each section as
 * `### <title>` + body). The order is load-bearing — the loop diffs rendered
 * text, and reordering would make every candidate look like a full rewrite.
 */
export function renderProfile(p: AgentProfile): string {
  const zones: string[] = [
    p.role.trim(),
    `## Environment\n\n${p.environment.trim()}`,
    `## Tool conventions\n\n${p.toolConventions.trim()}`,
    `## Skills\n\n${
      p.skills.length > 0 ? p.skills.map(renderSkill).join('\n\n') : '_No skills configured._'
    }`,
    `## Domain guidance\n\n${
      p.domain.length > 0
        ? p.domain.map((s) => `### ${s.title}\n\n${s.body.trim()}`).join('\n\n')
        : '_No domain guidance yet._'
    }`,
  ]
  return zones.join('\n\n')
}

/** The string `MutableSurface` the self-improvement loop scores — a profile
 *  renders to exactly the text a candidate is graded on. */
export function profileToSurface(p: AgentProfile): string {
  return renderProfile(p)
}

const STOCK_SKILLS: ProfileSkill[] = [
  {
    name: 'read-documents',
    description:
      'Read every source document under the read-only documents directory before drafting.',
    triggers: [
      'task references a source document',
      'instructions cite an exhibit, filing, or input file',
    ],
  },
  {
    name: 'write-deliverable',
    description:
      'Write deliverables to the output directory; use markdown for notes and the file-type skills for binary artifacts.',
    triggers: ['the task asks for a produced artifact', 'a deliverable is named in the brief'],
  },
]

const ENVIRONMENT_PREAMBLE =
  'You are an AI agent executing a task within a single workspace root.\n\n' +
  '- Workspace root: bash starts here. Use it for notes, scratch files, and intermediate work.\n' +
  '- Documents directory: task source documents live here and are read-only — never write to them.\n' +
  '- Output directory: write every deliverable here; relative write/edit paths route here automatically.\n' +
  '- Skills directory: skill scripts live at <workspace>/skills/<name>/scripts/.'

const TOOL_CONVENTIONS_PREAMBLE =
  'Use read to consume input files. Use write only for plain markdown (typically a response summary). ' +
  'Use edit for incremental refinement of a file you already created. ' +
  'External-boundary calls return typed outcomes — inspect success before using a value.'

/**
 * The fixed-scaffolding baseline: a `role`/`environment`/`toolConventions`
 * profile with the stock skill roster and NO domain guidance. The
 * production profile is this plus shipped domain sections.
 */
export function baselineProfile(args: {
  role: string
  environment?: string
  toolConventions?: string
  skills?: ProfileSkill[]
}): AgentProfile {
  return {
    role: args.role,
    environment: args.environment ?? ENVIRONMENT_PREAMBLE,
    toolConventions: args.toolConventions ?? TOOL_CONVENTIONS_PREAMBLE,
    skills: args.skills ?? STOCK_SKILLS,
    domain: [],
  }
}

/** The production profile: the baseline scaffolding plus the domain sections
 *  shipped after self-improvement. Differs from the baseline ONLY in `domain`
 *  (and any skills the caller layered into the baseline) — the role,
 *  environment, and tool conventions are carried through unchanged. */
export function prodProfile(baseline: AgentProfile, shipped: AgentProfileSection[]): AgentProfile {
  return { ...baseline, domain: [...baseline.domain, ...shipped] }
}

/**
 * Section-scoped edit — replace the body of ONE domain section by id, leaving
 * every other section byte-identical. This is how the loop targets a single
 * evolvable surface. Throws on an unknown section id (a patch that hits no
 * section is a silent no-op otherwise — fail loud). Throws when the targeted
 * section is `evolvable: false`.
 */
export function applyDomainPatch(
  p: AgentProfile,
  sectionId: string,
  newBody: string,
): AgentProfile {
  const idx = p.domain.findIndex((s) => s.id === sectionId)
  if (idx === -1) {
    throw new Error(
      `applyDomainPatch: no domain section "${sectionId}" (have: ${
        p.domain.map((s) => s.id).join(', ') || '<none>'
      })`,
    )
  }
  const target = p.domain[idx]
  if (target === undefined) {
    throw new Error(`applyDomainPatch: domain section "${sectionId}" resolved to undefined`)
  }
  if (!target.evolvable) {
    throw new Error(`applyDomainPatch: domain section "${sectionId}" is not evolvable`)
  }
  const next = [...p.domain]
  next[idx] = { ...target, body: newBody }
  return { ...p, domain: next }
}

/**
 * Content hash of a single section — its loop identity. Delegates to the
 * campaign provenance `surfaceContentHash` (the same helper the loop's
 * provenance record uses for full surfaces), so a section hash is byte-for-byte
 * comparable with the `sha256:`-prefixed content hashes that record carries.
 * Two sections that render identically (same title + body) share a hash; the
 * `id` and `evolvable` flag are excluded — they are routing metadata, not
 * content.
 */
export function sectionHash(section: AgentProfileSection): string {
  return surfaceContentHash(JSON.stringify({ title: section.title, body: section.body }))
}
