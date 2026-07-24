import { createHash } from 'node:crypto'
import type { CodeSurface, ComponentSurface, MutableSurface } from './types'

const GIT_OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/
const SHA256 = /^sha256:[a-f0-9]{64}$/

/** Validate the immutable identity shape; the owning executor verifies the Git objects and patch. */
export function assertCodeSurfaceIdentity(surface: unknown): asserts surface is CodeSurface {
  if (!surface || typeof surface !== 'object') {
    throw new TypeError('CodeSurface must be an object')
  }
  const candidate = surface as Partial<CodeSurface>
  if (candidate.kind !== 'code') throw new TypeError('CodeSurface.kind must be "code"')
  if (typeof candidate.worktreeRef !== 'string' || candidate.worktreeRef.trim().length === 0) {
    throw new TypeError('CodeSurface.worktreeRef must be a non-empty locator')
  }
  if (typeof candidate.baseRef !== 'string' || candidate.baseRef.trim().length === 0) {
    throw new TypeError('CodeSurface.baseRef must be a non-empty ref label')
  }
  for (const [field, value] of [
    ['baseCommit', candidate.baseCommit],
    ['baseTree', candidate.baseTree],
    ['candidateCommit', candidate.candidateCommit],
    ['candidateTree', candidate.candidateTree],
  ] as const) {
    if (typeof value !== 'string' || !GIT_OBJECT_ID.test(value)) {
      throw new TypeError(`CodeSurface.${field} must be a full Git object id`)
    }
  }
  const patch = candidate.patch
  if (!patch || typeof patch !== 'object' || patch.format !== 'git-diff-binary') {
    throw new TypeError('CodeSurface.patch.format must be "git-diff-binary"')
  }
  if (typeof patch.sha256 !== 'string' || !SHA256.test(patch.sha256)) {
    throw new TypeError('CodeSurface.patch.sha256 must be a sha256 digest')
  }
  if (!Number.isSafeInteger(patch.byteLength) || patch.byteLength < 0) {
    throw new TypeError('CodeSurface.patch.byteLength must be a non-negative safe integer')
  }
}

export function assertComponentSurface(surface: unknown): asserts surface is ComponentSurface {
  if (!surface || typeof surface !== 'object') {
    throw new TypeError('ComponentSurface must be an object')
  }
  const candidate = surface as Partial<ComponentSurface>
  if (candidate.kind !== 'components') {
    throw new TypeError('ComponentSurface.kind must be "components"')
  }
  if (
    !candidate.components ||
    typeof candidate.components !== 'object' ||
    Array.isArray(candidate.components)
  ) {
    throw new TypeError('ComponentSurface.components must be an object')
  }
  const entries = Object.entries(candidate.components)
  if (entries.length === 0) {
    throw new TypeError('ComponentSurface.components must not be empty')
  }
  for (const [name, content] of entries) {
    if (!name.trim() || name.trim() !== name) {
      throw new TypeError('ComponentSurface component names must be trimmed and non-empty')
    }
    if (typeof content !== 'string') {
      throw new TypeError(`ComponentSurface component '${name}' must be a string`)
    }
  }
}

export function componentSurfaceIdentityMaterial(surface: ComponentSurface): string {
  assertComponentSurface(surface)
  return JSON.stringify({
    schema: 'tangle.component-surface',
    components: Object.fromEntries(
      Object.entries(surface.components).sort(([left], [right]) => left.localeCompare(right)),
    ),
  })
}

/** Canonical, location-independent identity of a finalized code candidate.
 *  Commit metadata is excluded: two commits with the same base, final tree,
 *  and patch bytes are the same executable candidate. */
export function codeSurfaceIdentityMaterial(surface: CodeSurface): string {
  assertCodeSurfaceIdentity(surface)
  return JSON.stringify({
    schema: 'tangle.code-surface',
    baseCommit: surface.baseCommit,
    baseTree: surface.baseTree,
    candidateTree: surface.candidateTree,
    patch: {
      format: surface.patch.format,
      sha256: surface.patch.sha256,
      byteLength: surface.patch.byteLength,
    },
  })
}

/** Full SHA-256 content identity for a prompt or finalized code surface. */
export function surfaceContentHash(surface: MutableSurface): `sha256:${string}` {
  const material =
    typeof surface === 'string'
      ? surface
      : surface.kind === 'components'
        ? componentSurfaceIdentityMaterial(surface)
        : codeSurfaceIdentityMaterial(surface)
  return `sha256:${createHash('sha256').update(material).digest('hex')}`
}

/** Short loop key derived from the same content identity as provenance. */
export function surfaceHash(surface: MutableSurface): string {
  return surfaceContentHash(surface).slice('sha256:'.length, 'sha256:'.length + 16)
}

/** Canonical customer-visible description of the exact before/after surfaces. */
export function renderSurfaceDiff(
  winnerSurface: MutableSurface,
  baselineSurface: MutableSurface,
): string {
  if (typeof winnerSurface === 'string' && typeof baselineSurface === 'string') {
    return [
      '--- baseline',
      '+++ winner',
      ...baselineSurface.split('\n').map((line) => `- ${line}`),
      ...winnerSurface.split('\n').map((line) => `+ ${line}`),
    ].join('\n')
  }

  const describe = (surface: MutableSurface): string => {
    if (typeof surface === 'string') return '(prompt surface)'
    if (surface.kind === 'components') {
      assertComponentSurface(surface)
      return Object.entries(surface.components)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, content]) => `[${name}]\n${content}`)
        .join('\n\n')
    }
    assertCodeSurfaceIdentity(surface)
    return [
      `baseCommit=${surface.baseCommit}`,
      `baseTree=${surface.baseTree}`,
      `candidateCommit=${surface.candidateCommit}`,
      `candidateTree=${surface.candidateTree}`,
      `patch=${surface.patch.sha256}`,
      `patchBytes=${surface.patch.byteLength}`,
      ...(surface.summary ? [surface.summary] : []),
    ].join('\n')
  }

  return `--- baseline\n${describe(baselineSurface)}\n+++ winner\n${describe(winnerSurface)}`
}
