/**
 * Persona adapters — wrap legacy persona formats so consumers don't have
 * to rewrite their persona files to adopt `runPersonaEval`.
 *
 *   - `loadYamlPersonas`  — tax-agent, legal-agent (20+25 YAML files)
 *   - `loadTsPersonas`    — creative-agent, gtm-agent (TS persona modules)
 *
 * Both adapters are decoupled from the file format: the caller supplies
 * a parser (`parseYaml` callback) or a TS module shape (`extract`
 * callback), so the package itself takes no new dependency on a YAML
 * parser. That keeps `agent-eval` lean — bring your own `yaml` /
 * `js-yaml` or `import`.
 */

import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import type { PersonaSpec } from './types'

// ── YAML adapter ─────────────────────────────────────────────────────────

export interface LoadYamlPersonasOptions {
  /**
   * Either a glob (a single path with `*` wildcards) or an explicit
   * list of absolute filesystem paths. The simple wildcard expansion
   * supported here is intentional — production callers should pass an
   * array of paths from `fast-glob` or similar.
   */
  paths: string[] | string
  /**
   * Parse YAML text into an arbitrary JS object. Required — bring
   * your own parser (`yaml.parse` from the `yaml` npm package is the
   * canonical choice).
   */
  parseYaml: (yamlText: string) => unknown
  /**
   * Convert the parsed YAML object into a `PersonaSpec`. Defaults to a
   * heuristic that matches the tax-agent/legal-agent canonical shape:
   *
   *   id, name, turns?  → PersonaSpec { id, label: name, turns: [...] }
   *
   * If your YAML files lack a `turns` array (as in `01-w2-single-standard`,
   * which is a single-turn artifact-shaped persona), the heuristic
   * synthesises one turn from `prompt`, `query`, or the persona's `name`.
   * Pass a custom `toPersonaSpec` to override.
   */
  toPersonaSpec?: (parsed: unknown, sourcePath: string) => PersonaSpec
}

/**
 * Load and parse a set of YAML persona files into `PersonaSpec[]`.
 * Throws if any file is missing or unparseable; never returns a
 * partial list (the campaign primitive prefers fail-loud over
 * "we silently dropped half your personas").
 */
export async function loadYamlPersonas(opts: LoadYamlPersonasOptions): Promise<PersonaSpec[]> {
  const files = await resolvePaths(opts.paths)
  const toSpec = opts.toPersonaSpec ?? defaultYamlToPersona
  const out: PersonaSpec[] = []
  for (const file of files) {
    const text = await fs.readFile(file, 'utf8')
    const parsed = opts.parseYaml(text)
    const spec = toSpec(parsed, file)
    out.push(spec)
  }
  return out
}

function defaultYamlToPersona(parsed: unknown, sourcePath: string): PersonaSpec {
  if (parsed === null || typeof parsed !== 'object') {
    throw new Error(`loadYamlPersonas: ${sourcePath} did not parse to an object.`)
  }
  const obj = parsed as Record<string, unknown>
  const id = pickString(obj.id) ?? path.basename(sourcePath).replace(/\.[a-z]+$/, '')
  const label = pickString(obj.name) ?? pickString(obj.label) ?? id
  let turns: unknown = obj.turns
  if (!Array.isArray(turns)) {
    // Synthesise a single turn from the most likely prompt field.
    const synth =
      pickString(obj.prompt) ??
      pickString(obj.query) ??
      pickString(obj.userMessage) ??
      `Run the ${label} scenario end-to-end.`
    turns = [{ id: 't0', input: synth }]
  }
  return {
    id,
    label,
    domain: extractDomain(obj),
    turns: (turns as unknown[]).map((t, i) => normalizeTurn(t, i)),
    constraints: pickStringArray(obj.constraints),
    badData: pickStringArray(obj.bad_data) ?? pickStringArray(obj.badData),
    mustAsk: pickStringArray(obj.must_ask) ?? pickStringArray(obj.mustAsk),
    tags: pickStringRecord(obj.tags),
  }
}

function extractDomain(obj: Record<string, unknown>): Record<string, unknown> {
  // Everything that isn't a recognised top-level field becomes domain data.
  const known = new Set([
    'id',
    'name',
    'label',
    'turns',
    'prompt',
    'query',
    'userMessage',
    'constraints',
    'bad_data',
    'badData',
    'must_ask',
    'mustAsk',
    'tags',
  ])
  const domain: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj)) {
    if (!known.has(k)) domain[k] = v
  }
  return domain
}

function normalizeTurn(turn: unknown, idx: number): { id: string; input: unknown; expect?: Record<string, unknown>; metadata?: Record<string, unknown> } {
  if (typeof turn === 'string') return { id: `t${idx}`, input: turn }
  if (turn === null || typeof turn !== 'object') return { id: `t${idx}`, input: turn }
  const obj = turn as Record<string, unknown>
  const id = pickString(obj.id) ?? `t${idx}`
  const input =
    'input' in obj
      ? obj.input
      : pickString(obj.userMessage) ??
        pickString(obj.prompt) ??
        pickString(obj.message) ??
        obj
  const expect = obj.expect && typeof obj.expect === 'object' ? (obj.expect as Record<string, unknown>) : undefined
  const metadata = obj.metadata && typeof obj.metadata === 'object' ? (obj.metadata as Record<string, unknown>) : undefined
  return { id, input, expect, metadata }
}

// ── TS adapter ───────────────────────────────────────────────────────────

export interface LoadTsPersonasOptions<T> {
  /** Absolute path to a TS/JS module that exports persona data. */
  modulePath: string
  /**
   * Pull the persona list out of the imported module. The default
   * tries `default`, `personas`, `buildPersonas()`, then any exported
   * array. Pass a custom extractor for non-standard module shapes.
   */
  extract?: (mod: Record<string, unknown>) => T[]
  /**
   * Convert a legacy persona object into a `PersonaSpec`. Required —
   * legacy shapes vary too much for a useful default.
   */
  toPersonaSpec: (legacy: T) => PersonaSpec
}

/**
 * Dynamically import a TS persona module (creative-agent /
 * gtm-agent style) and convert its personas to `PersonaSpec`. The
 * module is `await import()`-loaded; pass a fully-resolved
 * absolute path.
 */
export async function loadTsPersonas<T>(opts: LoadTsPersonasOptions<T>): Promise<PersonaSpec[]> {
  const mod = (await import(opts.modulePath)) as Record<string, unknown>
  const extract = opts.extract ?? defaultExtract<T>
  const legacy = extract(mod)
  return legacy.map(opts.toPersonaSpec)
}

function defaultExtract<T>(mod: Record<string, unknown>): T[] {
  if (Array.isArray(mod.default)) return mod.default as T[]
  if (Array.isArray(mod.personas)) return mod.personas as T[]
  for (const key of Object.keys(mod)) {
    const value = mod[key]
    if (typeof value === 'function') {
      try {
        const result = (value as () => unknown)()
        if (Array.isArray(result)) return result as T[]
      } catch {
        // Continue searching.
      }
    }
    if (Array.isArray(value)) return value as T[]
  }
  throw new Error('loadTsPersonas: could not find a persona array on the imported module — pass `extract`.')
}

// ── Helpers ──────────────────────────────────────────────────────────────

async function resolvePaths(input: string[] | string): Promise<string[]> {
  if (Array.isArray(input)) return input
  // Minimal wildcard expansion: `dir/*.yaml` only. Anything fancier =>
  // caller passes an explicit array (use `fast-glob` etc.).
  if (!input.includes('*')) return [input]
  const dir = path.dirname(input)
  const pattern = path.basename(input)
  const re = new RegExp('^' + pattern.replace(/\./g, '\\.').replace(/\*/g, '.*') + '$')
  const entries = await fs.readdir(dir)
  return entries.filter((e) => re.test(e)).map((e) => path.join(dir, e))
}

function pickString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function pickStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out = value.filter((v): v is string => typeof v === 'string')
  return out.length > 0 ? out : undefined
}

function pickStringRecord(value: unknown): Record<string, string> | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === 'string') out[k] = v
  }
  return Object.keys(out).length > 0 ? out : undefined
}
