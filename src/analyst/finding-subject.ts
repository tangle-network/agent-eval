/**
 * Typed `FindingSubject` — the canonical grammar every analyst kind emits.
 *
 * Background: kind actor prompts have always documented a subject grammar
 * (e.g. `system-prompt:<section>`, `agent-knowledge:wiki:<slug>`) but the
 * LLM was unconstrained — it could emit `subject: "fix the prompt"`
 * (prose) and downstream adapters routed on `startsWith(...)` would
 * silently skip it. Every per-vertical `ImprovementAdapter` had a
 * routing table that mostly caught nothing.
 *
 * This module fixes that:
 *   - `parseFindingSubject(raw)` — returns the typed `FindingSubject`
 *     when `raw` matches the grammar, else `null`. Used at the
 *     `RawAnalystFindingSchema` boundary so malformed subjects are
 *     rejected loudly instead of silently lifted into the registry.
 *   - `FindingSubjectKind` — the union of valid locus categories. Each
 *     variant carries the typed components downstream adapters resolve
 *     against the agent's surface manifest (no string parsing in the
 *     adapter).
 *   - `FINDING_SUBJECT_GRAMMAR_PROMPT` — single source of truth for the
 *     grammar string embedded in kind actor prompts. Drift between
 *     prompt and parser is impossible if every kind imports this.
 *
 * The grammar is intentionally NARROW — only loci the substrate's
 * default `ImprovementAdapter` / `KnowledgeAdapter` can act on. A
 * finding with a subject outside this set fails the parser; the kind
 * author either extends the grammar here (and adds adapter routing)
 * or rephrases the prompt to map onto an existing variant.
 *
 * `failure-mode` is the one exception — its subjects are free-form
 * cluster labels, not loci. The schema preserves them as
 * `{ kind: 'cluster', label }` and the adapters skip them (cluster
 * findings are evidence, not actionable mutations).
 */

import { z } from 'zod'

// ── canonical grammar ─────────────────────────────────────────────────

/**
 * Discriminated union of every locus the substrate can route findings to.
 *
 * Adapters narrow on `kind` and use the typed components (no string
 * parsing). Adding a variant here REQUIRES updating the parser, the
 * grammar prompt, and at least one adapter — by design.
 */
export type FindingSubject =
  // ── agent-knowledge:* — routed to the KnowledgeAdapter ──
  | { kind: 'knowledge.wiki'; slug: string; heading?: string }
  | { kind: 'knowledge.claim'; topic: string }
  | { kind: 'knowledge.raw'; sourceId: string }
  | { kind: 'knowledge.stale'; slug: string }
  // ── system-prompt / tool / new-tool / rag / memory / scaffolding / output-schema ──
  // routed to the ImprovementAdapter
  | { kind: 'system-prompt'; section: string }
  | { kind: 'skill'; name: string }
  | { kind: 'tool-doc'; tool: string; aspect?: string }
  | { kind: 'new-tool'; name: string }
  | { kind: 'mcp'; server: string; tool?: string }
  | { kind: 'hook'; name: string }
  | { kind: 'subagent'; name: string }
  | { kind: 'workflow'; name: string }
  | { kind: 'rollout-policy'; field: string }
  | { kind: 'agent-profile'; field: string }
  | { kind: 'code'; path: string }
  | { kind: 'rag'; corpus: string; docId: string }
  | { kind: 'memory'; key: string }
  | { kind: 'scaffolding'; concern: string }
  | { kind: 'output-schema'; field: string }
  // ── websearch / prior-run-summary — routed to the KnowledgeAdapter as stale signals
  | { kind: 'websearch.outdated'; topic: string }
  | { kind: 'prior-run-summary'; topic: string }
  // ── failure-mode cluster label — preserved verbatim, not routed
  | { kind: 'cluster'; label: string }

export type FindingSubjectKind = FindingSubject['kind']

export const FINDING_SUBJECT_KINDS: ReadonlyArray<FindingSubjectKind> = [
  'knowledge.wiki',
  'knowledge.claim',
  'knowledge.raw',
  'knowledge.stale',
  'system-prompt',
  'skill',
  'tool-doc',
  'new-tool',
  'mcp',
  'hook',
  'subagent',
  'workflow',
  'rollout-policy',
  'agent-profile',
  'code',
  'rag',
  'memory',
  'scaffolding',
  'output-schema',
  'websearch.outdated',
  'prior-run-summary',
  'cluster',
]

// ── parser ────────────────────────────────────────────────────────────

/**
 * Parse a raw subject string emitted by an analyst kind's actor.
 *
 * Returns the typed `FindingSubject` when `raw` matches the grammar,
 * else `null`. Callers use the `null` return as a signal to either
 * (a) reject the finding at parse time (kinds that emit typed loci —
 * knowledge-gap, improvement, knowledge-poisoning) or (b) lift it as
 * a cluster label (failure-mode).
 *
 * Slugs are constrained to `[a-z0-9-]+` (lowercase kebab) to keep file
 * paths sane downstream. Topics / keys / sections allow any non-empty
 * string (free-form for the LLM's voice) but get trimmed.
 *
 * Empty / whitespace-only inputs return `null`. `undefined` returns
 * `null`. Both are surfaced by the caller as a rejected subject.
 */
export function parseFindingSubject(raw: string | null | undefined): FindingSubject | null {
  if (raw === null || raw === undefined) return null
  const trimmed = raw.trim()
  if (trimmed.length === 0) return null

  // agent-knowledge:wiki:<slug>[#<heading>]
  const wiki = trimmed.match(
    /^agent-knowledge:wiki:([a-z0-9][a-z0-9-]*)(?:#([a-z0-9][a-z0-9-]*))?$/,
  )
  if (wiki)
    return { kind: 'knowledge.wiki', slug: wiki[1]!, ...(wiki[2] ? { heading: wiki[2] } : {}) }

  // agent-knowledge:claim:<topic>
  const claim = trimmed.match(/^agent-knowledge:claim:(.+)$/)
  if (claim && claim[1]!.trim().length > 0)
    return { kind: 'knowledge.claim', topic: claim[1]!.trim() }

  // agent-knowledge:raw:<source-id>
  const raw_ = trimmed.match(/^agent-knowledge:raw:(.+)$/)
  if (raw_ && raw_[1]!.trim().length > 0)
    return { kind: 'knowledge.raw', sourceId: raw_[1]!.trim() }

  // agent-knowledge:stale:<slug>
  const stale = trimmed.match(/^agent-knowledge:stale:([a-z0-9][a-z0-9-]*)$/)
  if (stale) return { kind: 'knowledge.stale', slug: stale[1]! }

  // system-prompt:<section>
  const sp = trimmed.match(/^system-prompt:(.+)$/)
  if (sp && sp[1]!.trim().length > 0) return { kind: 'system-prompt', section: sp[1]!.trim() }

  // skill:<name>
  const skill = trimmed.match(/^skill:([a-z0-9][a-z0-9_.-]*)$/)
  if (skill) return { kind: 'skill', name: skill[1]! }

  // tool-doc:<tool>[:<aspect>]
  const tdAspect = trimmed.match(/^tool-doc:([a-z0-9][a-z0-9_-]*):(.+)$/)
  if (tdAspect && tdAspect[2]!.trim().length > 0) {
    return { kind: 'tool-doc', tool: tdAspect[1]!, aspect: tdAspect[2]!.trim() }
  }
  const td = trimmed.match(/^tool-doc:([a-z0-9][a-z0-9_-]*)$/)
  if (td) return { kind: 'tool-doc', tool: td[1]! }

  // new-tool:<name>
  const nt = trimmed.match(/^new-tool:([a-z0-9][a-z0-9_-]*)$/)
  if (nt) return { kind: 'new-tool', name: nt[1]! }

  // mcp:<server>[:<tool>]
  const mcp = trimmed.match(/^mcp:([a-z0-9][a-z0-9_.-]*)(?::([a-z0-9][a-z0-9_.-]*))?$/)
  if (mcp) {
    return { kind: 'mcp', server: mcp[1]!, ...(mcp[2] ? { tool: mcp[2] } : {}) }
  }

  // hook / subagent / workflow:<name>
  const hook = trimmed.match(/^hook:([a-z0-9][a-z0-9_.-]*)$/)
  if (hook) return { kind: 'hook', name: hook[1]! }
  const subagent = trimmed.match(/^subagent:([a-z0-9][a-z0-9_.-]*)$/)
  if (subagent) return { kind: 'subagent', name: subagent[1]! }
  const workflow = trimmed.match(/^workflow:([a-z0-9][a-z0-9_.-]*)$/)
  if (workflow) return { kind: 'workflow', name: workflow[1]! }

  // rollout-policy / agent-profile:<field>
  const rolloutPolicy = trimmed.match(/^rollout-policy:(.+)$/)
  if (rolloutPolicy && rolloutPolicy[1]!.trim().length > 0) {
    return { kind: 'rollout-policy', field: rolloutPolicy[1]!.trim() }
  }
  const agentProfile = trimmed.match(/^agent-profile:(.+)$/)
  if (agentProfile && agentProfile[1]!.trim().length > 0) {
    return { kind: 'agent-profile', field: agentProfile[1]!.trim() }
  }

  // code:<path>
  const code = trimmed.match(/^code:(.+)$/)
  if (code && code[1]!.trim().length > 0) return { kind: 'code', path: code[1]!.trim() }

  // rag:<corpus>:<doc-id>
  const rag = trimmed.match(/^rag:([a-z0-9][a-z0-9_-]*):(.+)$/)
  if (rag && rag[2]!.trim().length > 0) {
    return { kind: 'rag', corpus: rag[1]!, docId: rag[2]!.trim() }
  }

  // memory:<key>
  const mem = trimmed.match(/^memory:(.+)$/)
  if (mem && mem[1]!.trim().length > 0) return { kind: 'memory', key: mem[1]!.trim() }

  // scaffolding:<concern>
  const sc = trimmed.match(/^scaffolding:(.+)$/)
  if (sc && sc[1]!.trim().length > 0) return { kind: 'scaffolding', concern: sc[1]!.trim() }

  // output-schema:<field>
  const os = trimmed.match(/^output-schema:(.+)$/)
  if (os && os[1]!.trim().length > 0) return { kind: 'output-schema', field: os[1]!.trim() }

  // websearch:outdated:<topic>
  const ws = trimmed.match(/^websearch:outdated:(.+)$/)
  if (ws && ws[1]!.trim().length > 0) return { kind: 'websearch.outdated', topic: ws[1]!.trim() }

  // prior-run-summary:<topic>
  const prs = trimmed.match(/^prior-run-summary:(.+)$/)
  if (prs && prs[1]!.trim().length > 0) return { kind: 'prior-run-summary', topic: prs[1]!.trim() }

  // cluster (no prefix — a free-form evidence label, never a routed locus, so
  // it admits dotted/underscored identifiers like `appworld.task.530b157_1`.
  // ':' stays excluded so it cannot collide with the prefixed grammars above.)
  if (/^[a-z0-9][a-z0-9._-]*$/.test(trimmed) && trimmed.length <= 80) {
    return { kind: 'cluster', label: trimmed }
  }

  return null
}

/**
 * Render the parsed subject back to its canonical string form. Inverse
 * of `parseFindingSubject`; useful when the substrate constructs new
 * findings programmatically (e.g. for tests, replays, or
 * `id_basis` carry-forward).
 */
export function renderFindingSubject(s: FindingSubject): string {
  switch (s.kind) {
    case 'knowledge.wiki':
      return s.heading
        ? `agent-knowledge:wiki:${s.slug}#${s.heading}`
        : `agent-knowledge:wiki:${s.slug}`
    case 'knowledge.claim':
      return `agent-knowledge:claim:${s.topic}`
    case 'knowledge.raw':
      return `agent-knowledge:raw:${s.sourceId}`
    case 'knowledge.stale':
      return `agent-knowledge:stale:${s.slug}`
    case 'system-prompt':
      return `system-prompt:${s.section}`
    case 'skill':
      return `skill:${s.name}`
    case 'tool-doc':
      return s.aspect ? `tool-doc:${s.tool}:${s.aspect}` : `tool-doc:${s.tool}`
    case 'new-tool':
      return `new-tool:${s.name}`
    case 'mcp':
      return s.tool ? `mcp:${s.server}:${s.tool}` : `mcp:${s.server}`
    case 'hook':
      return `hook:${s.name}`
    case 'subagent':
      return `subagent:${s.name}`
    case 'workflow':
      return `workflow:${s.name}`
    case 'rollout-policy':
      return `rollout-policy:${s.field}`
    case 'agent-profile':
      return `agent-profile:${s.field}`
    case 'code':
      return `code:${s.path}`
    case 'rag':
      return `rag:${s.corpus}:${s.docId}`
    case 'memory':
      return `memory:${s.key}`
    case 'scaffolding':
      return `scaffolding:${s.concern}`
    case 'output-schema':
      return `output-schema:${s.field}`
    case 'websearch.outdated':
      return `websearch:outdated:${s.topic}`
    case 'prior-run-summary':
      return `prior-run-summary:${s.topic}`
    case 'cluster':
      return s.label
  }
}

// ── grammar prompt — single source of truth for actor instructions ──

/**
 * The grammar text embedded into kind actor prompts. Kinds opt into
 * the subset of variants they emit (e.g. `improvement` excludes the
 * cluster variant; `failure-mode` includes ONLY the cluster variant).
 *
 * Drift between prompt and parser is impossible: every kind imports
 * this constant + the matching `expects` set, and the unit tests below
 * lock the table to the parser.
 */
export const FINDING_SUBJECT_SYNTAX: Readonly<Record<FindingSubjectKind, string>> = {
  'knowledge.wiki': 'agent-knowledge:wiki:<slug>[#<heading>]',
  'knowledge.claim': 'agent-knowledge:claim:<topic>',
  'knowledge.raw': 'agent-knowledge:raw:<source-id>',
  'knowledge.stale': 'agent-knowledge:stale:<slug>',
  'system-prompt': 'system-prompt:<section>',
  skill: 'skill:<name>',
  'tool-doc': 'tool-doc:<tool>[:<aspect>]',
  'new-tool': 'new-tool:<name>',
  mcp: 'mcp:<server>[:<tool>]',
  hook: 'hook:<name>',
  subagent: 'subagent:<name>',
  workflow: 'workflow:<name>',
  'rollout-policy': 'rollout-policy:<field>',
  'agent-profile': 'agent-profile:<field>',
  code: 'code:<path>',
  rag: 'rag:<corpus>:<doc-id>',
  memory: 'memory:<key>',
  scaffolding: 'scaffolding:<concern>',
  'output-schema': 'output-schema:<field>',
  'websearch.outdated': 'websearch:outdated:<topic>',
  'prior-run-summary': 'prior-run-summary:<topic>',
  cluster: '<lowercase-cluster-label>',
}

const FINDING_SUBJECT_PURPOSE: Readonly<Record<FindingSubjectKind, string>> = {
  'knowledge.wiki': 'create or update a wiki page',
  'knowledge.claim': 'draft a claim or relation',
  'knowledge.raw': 'curate a raw source',
  'knowledge.stale': 'mark a stale page',
  'system-prompt': 'revise a system-prompt section',
  skill: 'create or revise a skill',
  'tool-doc': 'revise a tool contract',
  'new-tool': 'propose a new tool',
  mcp: 'revise an MCP server or tool',
  hook: 'revise a lifecycle hook',
  subagent: 'revise a delegated agent',
  workflow: 'revise an orchestration workflow',
  'rollout-policy': 'revise budget, sampling, or stop policy',
  'agent-profile': 'revise another AgentProfile field',
  code: 'revise an implementation path',
  rag: 'ingest or correct a RAG document',
  memory: 'invalidate or set memory',
  scaffolding: 'revise preconditions, retries, or verification',
  'output-schema': 'constrain the output shape',
  'websearch.outdated': 'identify a stale web result',
  'prior-run-summary': 'identify a stale prior-run summary',
  cluster: 'name one failure cluster',
}

function renderFindingSubjectGrammar(kinds: ReadonlyArray<FindingSubjectKind>): string {
  return [
    'Subjects MUST match one of these forms — anything else is rejected at parse time:',
    ...kinds.map((kind) => `  ${FINDING_SUBJECT_SYNTAX[kind]} — ${FINDING_SUBJECT_PURPOSE[kind]}`),
    'Runtime ids are lowercase [a-z0-9_.-]+. Topics, keys, paths, and sections are free-form and trimmed.',
  ].join('\n')
}

export const FINDING_SUBJECT_GRAMMAR_PROMPT = renderFindingSubjectGrammar(FINDING_SUBJECT_KINDS)

// ── kind expects sets ─────────────────────────────────────────────────

/**
 * The variants each kind is allowed to emit. Used at the kind factory
 * boundary so a knowledge-gap finding can't sneak in a `system-prompt:*`
 * subject (the improvement-analyst's job) and vice versa.
 *
 * `failure-mode` is restricted to `cluster` — the only kind that emits
 * a non-locus subject.
 */
export const KIND_EXPECTED_SUBJECTS: Record<string, ReadonlyArray<FindingSubjectKind>> = {
  'failure-mode': ['cluster'],
  'knowledge-gap': [
    'knowledge.wiki',
    'knowledge.claim',
    'knowledge.raw',
    'knowledge.stale',
    'tool-doc',
    'system-prompt',
    'skill',
    'mcp',
    'subagent',
    'workflow',
    'memory',
    'websearch.outdated',
    'prior-run-summary',
  ],
  'knowledge-poisoning': [
    'knowledge.wiki',
    'knowledge.claim',
    'knowledge.raw',
    'tool-doc',
    'system-prompt',
    'skill',
    'mcp',
    'hook',
    'memory',
    'websearch.outdated',
    'prior-run-summary',
  ],
  improvement: [
    'system-prompt',
    'skill',
    'tool-doc',
    'new-tool',
    'mcp',
    'hook',
    'subagent',
    'workflow',
    'rollout-policy',
    'agent-profile',
    'code',
    'rag',
    'memory',
    'scaffolding',
    'output-schema',
    'knowledge.wiki',
    'knowledge.claim',
  ],
}

/** Render only the subject forms one analyst kind is permitted to emit. */
export function findingSubjectGrammarPromptFor(kindId: string): string {
  const kinds = KIND_EXPECTED_SUBJECTS[kindId]
  if (!kinds) throw new Error(`unknown analyst kind: ${kindId}`)
  return renderFindingSubjectGrammar(kinds)
}

// ── Zod schema for boundary validation ───────────────────────────────

/**
 * Zod schema that validates a raw subject string and returns the parsed
 * `FindingSubject`. Embedded in `RawAnalystFindingSchema` via
 * `transform`, so `subject` arrives at the kind factory either as a
 * typed locus or as a parse error attached to a single Zod issue.
 *
 * Optionality is preserved: subjects ARE optional on the wire (some
 * findings are descriptive, not actionable). When present, they MUST
 * parse — emitting a malformed subject is a contract violation, not a
 * soft signal.
 */
export const FindingSubjectStringSchema = z
  .string()
  .refine((s) => parseFindingSubject(s) !== null, {
    message: 'subject does not match the finding-subject grammar',
  })
