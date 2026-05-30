import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Mechanically enforces the load-bearing layering invariant from CLAUDE.md:
 * agent-eval is the SUBSTRATE — it must have ZERO upward dependency on its
 * consumers (agent-runtime, agent-knowledge). The rule was prose-only; an
 * `import type` from a consumer is the smell that silently inverts the layer.
 * This test makes the rule a red build instead of an audit finding.
 *
 * Matches only real import/require edges — comments and string literals that
 * mention the package names (domain vocabulary, finding-subject namespaces)
 * are allowed.
 */

const FORBIDDEN = ['@tangle-network/agent-runtime', '@tangle-network/agent-knowledge'] as const
const ROOT = join(__dirname, '..')
const SCAN_DIRS = ['src', 'tests']

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const s = statSync(full)
    if (s.isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist' || entry.startsWith('.')) continue
      walk(full, out)
    } else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) {
      out.push(full)
    }
  }
}

/** An actual module edge: `import ... from '<pkg>'`, `import('<pkg>')`,
 *  `require('<pkg>')` — NOT a mention inside a comment or string literal. */
function importsForbidden(source: string, pkg: string): boolean {
  const escaped = pkg.replace(/[/-]/g, (m) => `\\${m}`)
  const patterns = [
    new RegExp(`from\\s+['"]${escaped}(?:/[^'"]*)?['"]`),
    new RegExp(`import\\s*\\(\\s*['"]${escaped}(?:/[^'"]*)?['"]`),
    new RegExp(`require\\s*\\(\\s*['"]${escaped}(?:/[^'"]*)?['"]`),
  ]
  // Strip line + block comments so a docstring mention does not trip the guard.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  return patterns.some((re) => re.test(code))
}

describe('boundary integrity — agent-eval is the substrate (zero upward deps)', () => {
  const files: string[] = []
  for (const d of SCAN_DIRS) walk(join(ROOT, d), files)

  it(`scans a non-trivial number of source files (sanity)`, () => {
    expect(files.length).toBeGreaterThan(50)
  })

  for (const pkg of FORBIDDEN) {
    it(`no src/tests file imports ${pkg}`, () => {
      const offenders = files.filter((f) => importsForbidden(readFileSync(f, 'utf8'), pkg))
      expect(offenders.map((f) => f.slice(ROOT.length + 1))).toEqual([])
    })
  }
})
