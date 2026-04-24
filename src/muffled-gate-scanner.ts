/**
 * muffled-gate-scanner — test helper that greps consumer source for
 * gate + measurement anti-patterns and fails with file:line locations.
 *
 * Named pattern lives at starter-foundry's `.evolve/patterns/muffled-gate.md`;
 * same shape applies to every consumer (a gate that should fail loud
 * returns silent success; a metric that should emit a real number
 * reports noise/empty).
 *
 * Usage (in a consumer project's test file):
 *
 *   import { scanForMuffledGates, DEFAULT_FINDERS } from '@tangle-network/agent-eval'
 *
 *   test('no muffled gates in eval surface', () => {
 *     const findings = scanForMuffledGates({
 *       repoRoot: process.cwd(),
 *       scanFiles: ['src/eval/scaffold.ts', 'scripts/promote.mjs'],
 *       finders: DEFAULT_FINDERS,
 *     })
 *     if (findings.length) assert.fail(formatFindings(findings))
 *   })
 *
 * Customize by passing your own `finders` — each finder is
 * `(file, text) => Finding[]` and runs per-file.
 *
 * Escape hatch: any line containing `muffle-ok:` is excluded from all
 * finders, letting consumers opt a legitimate fallback out explicitly.
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

export interface MuffledFinding {
  file: string
  line: number
  lineText: string
  pattern: string
}

export type MuffledFinder = (file: string, text: string) => MuffledFinding[]

export interface ScanOptions {
  /** Absolute path to the repo root. */
  repoRoot: string
  /** Explicit file list (paths relative to repoRoot) for context-specific finders. */
  scanFiles: string[]
  /**
   * Auto-derived scan: walk these dirs for files matching importGlob + the
   * string `importsContain` and run the universal finders on them. Pattern
   * from starter-foundry H4 (research/decisions/001) — catches new files
   * with agent-eval import that would otherwise escape context-specific
   * scan lists.
   */
  autoDerive?: {
    roots: string[] // e.g. ['src', 'scripts']
    extensions: RegExp // e.g. /\.(ts|mjs|js)$/
    importsContain: string // e.g. '@tangle-network/agent-eval'
    universalFinders: MuffledFinder[]
  }
  /** Per-file finders (context-specific patterns). */
  finders: MuffledFinder[]
}

/**
 * Strip line comments + block-comment continuation lines from a single line
 * so finders don't match prose about the pattern.
 */
function codeOf(line: string): string {
  return line.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '')
}

/** Skip if the line carries the `muffle-ok:` escape hatch. */
function isMuffleOk(line: string): boolean {
  return line.includes('muffle-ok:')
}

/**
 * Default finder: `command || true` in a testCommand/setupCommand/cmd/command
 * string. Swallows exit codes.
 */
export const findFallbackToPass: MuffledFinder = (file, text) => {
  const out: MuffledFinding[] = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (isMuffleOk(line)) continue
    const code = codeOf(line)
    if (!code.trim()) continue
    if (/\|\| true/.test(code) && /(testCommand|setupCommand|cmd|command)/.test(code)) {
      out.push({ file, line: i + 1, lineText: line.trim(), pattern: 'fallback-to-pass (|| true in command string)' })
    }
  }
  return out
}

/**
 * `testCommand: 'true'` literal silent-pass — an unknown-language dispatch
 * arm that returns a no-op instead of throwing.
 */
export const findLiteralTruePass: MuffledFinder = (file, text) => {
  const out: MuffledFinding[] = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (isMuffleOk(line)) continue
    const code = codeOf(line)
    if (!code.trim()) continue
    if (/testCommand\s*:\s*['"]true['"]/.test(code)) {
      out.push({ file, line: i + 1, lineText: line.trim(), pattern: 'literal-true-pass (testCommand: "true")' })
    }
  }
  return out
}

/**
 * `new SubprocessSandboxDriver({ cwd: ... })` — constructor arg silently
 * dropped in agent-eval <0.7.1. 0.7.1+ honors as fallback, but the form
 * still invites confusion; prefer `new SubprocessSandboxDriver()` with
 * cwd in the per-call HarnessConfig.
 */
export const findConstructorCwdDropped: MuffledFinder = (file, text) => {
  const out: MuffledFinding[] = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (isMuffleOk(line)) continue
    const code = codeOf(line)
    if (!code.trim()) continue
    if (/new\s+SubprocessSandboxDriver\s*\(\s*\{[^}]*cwd\s*:/.test(code)) {
      out.push({
        file,
        line: i + 1,
        lineText: line.trim(),
        pattern: 'construct-vs-call cwd dropped (driver.exec reads config.cwd, not constructor.cwd)',
      })
    }
  }
  return out
}

/**
 * `if (!expected) return true` — matcher auto-passes when ground truth is
 * absent. Inflates accuracy metrics for scenarios without expectations.
 */
export const findAutoMatchNoExpectation: MuffledFinder = (file, text) => {
  const out: MuffledFinding[] = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (isMuffleOk(line)) continue
    const code = codeOf(line)
    if (!code.trim()) continue
    if (/if\s*\(\s*!expected\s*\)\s*return\s+true/.test(code)) {
      out.push({
        file,
        line: i + 1,
        lineText: line.trim(),
        pattern: 'auto-match-no-expectation (if (!expected) return true)',
      })
    }
  }
  return out
}

/**
 * `if (p.skipped) return true` — skip-counts-as-pass in quality scorers.
 * Use three-valued `true | false | 'skipped'` return + explicit partial
 * credit instead.
 */
export const findSkipCountsAsPass: MuffledFinder = (file, text) => {
  const out: MuffledFinding[] = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (isMuffleOk(line)) continue
    const code = codeOf(line)
    if (!code.trim()) continue
    if (/if\s*\(\s*\w+\.skipped\s*\)\s*return\s+true/.test(code)) {
      out.push({
        file,
        line: i + 1,
        lineText: line.trim(),
        pattern: 'skip-counts-as-pass (if (.skipped) return true)',
      })
    }
  }
  return out
}

/**
 * The canonical default bundle. Callers can import these individually,
 * replace them, or append custom finders for project-specific patterns.
 */
export const DEFAULT_FINDERS: MuffledFinder[] = [
  findFallbackToPass,
  findLiteralTruePass,
  findAutoMatchNoExpectation,
  findSkipCountsAsPass,
]

/** Finders that should run on EVERY file with the target import, not just SCAN_FILES. */
export const UNIVERSAL_FINDERS: MuffledFinder[] = [
  findConstructorCwdDropped,
]

/**
 * Walk `roots` under `repoRoot` and return file paths (relative to repoRoot)
 * whose contents include `importsContain`.
 */
function autoDeriveImporters(
  repoRoot: string,
  roots: string[],
  extensions: RegExp,
  importsContain: string,
): string[] {
  const matches: string[] = []
  const walk = (rel: string) => {
    const abs = join(repoRoot, rel)
    if (!existsSync(abs)) return
    for (const entry of readdirSync(abs)) {
      const sub = join(rel, entry)
      const subAbs = join(repoRoot, sub)
      let st
      try { st = statSync(subAbs) } catch { continue }
      if (st.isDirectory()) {
        if (entry === 'node_modules' || entry === 'dist' || entry === 'dist-tests' || entry.startsWith('.')) continue
        walk(sub)
      } else if (st.isFile() && extensions.test(entry)) {
        if (entry.endsWith('.test.ts') || entry.endsWith('.test.mjs') || entry.endsWith('.test.js')) continue
        let text: string
        try { text = readFileSync(subAbs, 'utf8') } catch { continue }
        if (text.includes(importsContain)) matches.push(sub)
      }
    }
  }
  for (const r of roots) walk(r)
  return matches
}

/**
 * Run all finders against the configured files. Returns a flat list of
 * findings. Callers format + assert as they prefer.
 */
export function scanForMuffledGates(opts: ScanOptions): MuffledFinding[] {
  const findings: MuffledFinding[] = []
  const scanned = new Set<string>()

  // Context-specific: run all finders on explicit SCAN_FILES.
  for (const file of opts.scanFiles) {
    const abs = join(opts.repoRoot, file)
    if (!existsSync(abs)) continue
    const text = readFileSync(abs, 'utf8')
    for (const find of opts.finders) findings.push(...find(file, text))
    scanned.add(file)
  }

  // Auto-derived: run universal finders on every importer not already scanned.
  if (opts.autoDerive) {
    const importers = autoDeriveImporters(
      opts.repoRoot,
      opts.autoDerive.roots,
      opts.autoDerive.extensions,
      opts.autoDerive.importsContain,
    )
    for (const file of importers) {
      if (scanned.has(file)) continue
      const abs = join(opts.repoRoot, file)
      if (!existsSync(abs)) continue
      const text = readFileSync(abs, 'utf8')
      for (const find of opts.autoDerive.universalFinders) findings.push(...find(file, text))
    }
  }

  return findings
}

/**
 * Format findings into a single assert.fail-ready message. Each finding
 * carries file:line + pattern name + the offending line.
 */
export function formatFindings(findings: MuffledFinding[]): string {
  if (findings.length === 0) return ''
  return [
    `Found ${findings.length} muffled-gate pattern(s).`,
    `Fix each or annotate the line with "// muffle-ok: <reason>".`,
    '',
    ...findings.map((f) => `  ${f.file}:${f.line} — ${f.pattern}\n    ${f.lineText}`),
  ].join('\n')
}
