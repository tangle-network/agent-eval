import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  scanForMuffledGates,
  formatFindings,
  DEFAULT_FINDERS,
  UNIVERSAL_FINDERS,
  findFallbackToPass,
  findConstructorCwdDropped,
  findSkipCountsAsPass,
} from '../src/muffled-gate-scanner'

/**
 * Build an isolated temp repo with the given file map and return its path.
 */
function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'muffled-gate-scanner-'))
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel)
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, content)
  }
  return root
}

describe('muffled-gate-scanner', () => {
  it('finds `|| true` in a testCommand string', () => {
    const root = fixture({
      'src/runner.ts': `
        const config = {
          testCommand: 'pnpm run validate || pnpm run build || true',
        }
      `,
    })
    try {
      const findings = scanForMuffledGates({
        repoRoot: root,
        scanFiles: ['src/runner.ts'],
        finders: [findFallbackToPass],
      })
      expect(findings).toHaveLength(1)
      expect(findings[0]!.pattern).toMatch(/fallback-to-pass/)
      expect(findings[0]!.line).toBe(3)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('`muffle-ok:` annotation on the same line excludes the finding', () => {
    const root = fixture({
      'src/runner.ts': `
        const config = {
          testCommand: 'forge install || true', // muffle-ok: setup is best-effort; forge build is the real gate
        }
      `,
    })
    try {
      const findings = scanForMuffledGates({
        repoRoot: root,
        scanFiles: ['src/runner.ts'],
        finders: [findFallbackToPass],
      })
      expect(findings).toHaveLength(0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('auto-derive walks importers + applies universal finders to files not on explicit list', () => {
    const root = fixture({
      'src/a.ts': `
        import { SubprocessSandboxDriver } from '@tangle-network/agent-eval'
        const driver = new SubprocessSandboxDriver({ cwd: '/tmp' })
      `,
      'src/b.ts': `
        import assert from 'node:assert'
        const noop = true
      `,
      'scripts/c.mjs': `
        import { SubprocessSandboxDriver } from '@tangle-network/agent-eval'
        const driver2 = new SubprocessSandboxDriver({ cwd: '/tmp' })
      `,
    })
    try {
      const findings = scanForMuffledGates({
        repoRoot: root,
        scanFiles: [], // empty — rely entirely on auto-derive
        finders: [],
        autoDerive: {
          roots: ['src', 'scripts'],
          extensions: /\.(ts|mjs|js)$/,
          importsContain: '@tangle-network/agent-eval',
          universalFinders: [findConstructorCwdDropped],
        },
      })
      // b.ts does NOT import agent-eval → skipped.
      // a.ts and c.mjs both import + both have the bug → 2 findings.
      expect(findings).toHaveLength(2)
      expect(findings.map((f) => f.file).sort()).toEqual(['scripts/c.mjs', 'src/a.ts'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('scanFiles takes precedence over auto-derive (dedup — no double-scan)', () => {
    const root = fixture({
      'src/a.ts': `
        import { SubprocessSandboxDriver } from '@tangle-network/agent-eval'
        const driver = new SubprocessSandboxDriver({ cwd: '/tmp' })
      `,
    })
    try {
      const findings = scanForMuffledGates({
        repoRoot: root,
        scanFiles: ['src/a.ts'], // explicit
        finders: [findConstructorCwdDropped], // applied via explicit
        autoDerive: {
          roots: ['src'],
          extensions: /\.ts$/,
          importsContain: '@tangle-network/agent-eval',
          universalFinders: [findConstructorCwdDropped], // also applied via auto — should NOT double-count
        },
      })
      expect(findings).toHaveLength(1)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('DEFAULT_FINDERS is a stable bundle that catches the common cases', () => {
    const root = fixture({
      'src/scorer.ts': `
        function phaseOk(p) {
          if (p.skipped) return true
          return p.ok === true
        }
      `,
    })
    try {
      const findings = scanForMuffledGates({
        repoRoot: root,
        scanFiles: ['src/scorer.ts'],
        finders: DEFAULT_FINDERS,
      })
      expect(findings.length).toBeGreaterThan(0)
      expect(findings.some((f) => f.pattern.includes('skip-counts-as-pass'))).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('formatFindings returns assert.fail-ready message with file:line + pattern + line body', () => {
    const msg = formatFindings([
      { file: 'src/a.ts', line: 42, lineText: "testCommand: 'foo || true',", pattern: 'fallback-to-pass' },
    ])
    expect(msg).toMatch(/src\/a\.ts:42/)
    expect(msg).toMatch(/fallback-to-pass/)
    expect(msg).toMatch(/muffle-ok:/) // escape-hatch hint included
  })

  it('exports UNIVERSAL_FINDERS which includes the construct-vs-call cwd finder', () => {
    expect(UNIVERSAL_FINDERS).toContain(findConstructorCwdDropped)
  })
})
