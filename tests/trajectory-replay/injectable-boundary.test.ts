import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The load-bearing property of this module: replay stays runnable anywhere
 * because every environment binding is injected. A direct import of a sandbox
 * client or a model-provider SDK would put that binding back in the substrate
 * and force every consumer to carry it.
 */

const FORBIDDEN_PACKAGES = [
  '@tangle-network/sandbox',
  '@tangle-network/agent-runtime',
  '@tangle-network/agent-knowledge',
  'openai',
  '@anthropic-ai/sdk',
  'dockerode',
] as const

const MODULE_DIR = join(__dirname, '..', '..', 'src', 'trajectory-replay')

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full))
    else if (entry.endsWith('.ts')) out.push(full)
  }
  return out
}

/** Strips comments so a docstring mention is not read as a module edge. */
function importsPackage(source: string, pkg: string): boolean {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const escaped = pkg.replace(/[/\-@.]/g, (m) => `\\${m}`)
  return [
    new RegExp(`from\\s+['"]${escaped}(?:/[^'"]*)?['"]`),
    new RegExp(`import\\s*\\(\\s*['"]${escaped}(?:/[^'"]*)?['"]`),
    new RegExp(`require\\s*\\(\\s*['"]${escaped}(?:/[^'"]*)?['"]`),
  ].some((re) => re.test(code))
}

describe('trajectory-replay keeps every environment binding injectable', () => {
  const files = sourceFiles(MODULE_DIR)

  it('scans every module file', () => {
    expect(files.length).toBeGreaterThanOrEqual(9)
  })

  for (const pkg of FORBIDDEN_PACKAGES) {
    it(`no module file imports ${pkg}`, () => {
      const offenders = files
        .filter((f) => importsPackage(readFileSync(f, 'utf8'), pkg))
        .map((f) => f.slice(MODULE_DIR.length + 1))
      expect(offenders).toEqual([])
    })
  }

  it('imports no third-party package at all — only node: builtins and this repo', () => {
    const offenders: string[] = []
    for (const file of files) {
      const code = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '')
      for (const match of code.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
        const specifier = match[1]!
        const allowed = specifier.startsWith('node:') || specifier.startsWith('.')
        if (!allowed) offenders.push(`${file.slice(MODULE_DIR.length + 1)}: ${specifier}`)
      }
    }
    expect(offenders).toEqual([])
  })
})
