/** Profile distances: lineage hops, verified text edits, or caller-supplied vectors. */
import type { SearchCandidateSurface } from '../../campaign/search-ledger-types'
import type { SearchNode } from '../../campaign/search-state'
import { canonicalString, compareCodeUnits } from '../../ledger-core/canonical'
import type { LandscapeEmbedding } from './landscape-contract'

/** The default: edits recorded between two profiles along the lineage. */
export function lineageEdits(): LandscapeEmbedding {
  return {
    kind: 'lineage',
    name: 'lineage-edits',
    method:
      'edits between the two profiles along the recorded lineage: the fewest improve, debug or merge edges joining them (a re-proposal edge counts; a draft is written afresh, so its edge is no edit of its anchor)',
  }
}

/**
 * Line edits between the surfaces' texts: for each declared surface, the
 * fewest line insertions and deletions that turn one text into the other
 * (Myers, 1986), summed over surfaces. `read` returns a surface's content:
 * a string, parsed JSON (flattened with `profileTextLines`), or null when it
 * cannot be read, which leaves every distance of that node unknown. The lens
 * stays pure; the caller owns the I/O and its verification.
 */
export function surfaceTextEdits(
  read: (surface: SearchCandidateSurface) => unknown,
): LandscapeEmbedding {
  const lines = new Map<string, string[] | null>()
  const linesOf = (surface: SearchCandidateSurface): string[] | null => {
    const key = surface.artifact.sha256
    if (!lines.has(key)) {
      const content = read(surface)
      lines.set(
        key,
        content === null || content === undefined
          ? null
          : typeof content === 'string'
            ? content.split('\n')
            : profileTextLines(content),
      )
    }
    return lines.get(key)!
  }
  return {
    kind: 'distance',
    name: 'surface-text-edits',
    method:
      'line insertions plus deletions between the surface texts (Myers diff), summed over declared surfaces; JSON is flattened to one line per leaf and per line of a string',
    distance(a, b) {
      const right = new Map(b.surfaces.map((surface) => [surface.surfaceId, surface]))
      let total = 0
      const seen = new Set<string>()
      for (const surface of a.surfaces) {
        seen.add(surface.surfaceId)
        const own = linesOf(surface)
        if (own === null) return null
        const other = right.get(surface.surfaceId)
        if (!other) {
          total += own.length
          continue
        }
        if (other.artifact.sha256 === surface.artifact.sha256) continue
        const theirs = linesOf(other)
        if (theirs === null) return null
        total += lineEditDistance(own, theirs)
      }
      for (const surface of b.surfaces) {
        if (seen.has(surface.surfaceId)) continue
        const theirs = linesOf(surface)
        if (theirs === null) return null
        total += theirs.length
      }
      return total
    },
  }
}

/** A caller's vector per node, for example a model embedding of its profile. */
export function vectorEmbedding(
  name: string,
  vector: (node: SearchNode) => readonly number[] | null,
): LandscapeEmbedding {
  return {
    kind: 'vector',
    name,
    method: `Euclidean distance between ${name} vectors`,
    vector,
  }
}

/**
 * JSON as lines a diff can count: one line per scalar leaf, `path=value`, and
 * one line per line of a string, so an edit inside a long prompt counts the
 * lines it changed rather than the whole prompt. Object keys are visited in
 * code-unit order.
 */
function profileTextLines(value: unknown, path = '$'): string[] {
  if (typeof value === 'string') {
    const parts = value.split('\n')
    return parts.length === 1
      ? [`${path}=${canonicalString(value)}`]
      : parts.map((line, index) => `${path}[${index}]=${canonicalString(line)}`)
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return [`${path}=[]`]
    return value.flatMap((entry, index) => profileTextLines(entry, `${path}[${index}]`))
  }
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).sort(compareCodeUnits)
    if (keys.length === 0) return [`${path}={}`]
    return keys.flatMap((key) =>
      profileTextLines((value as Record<string, unknown>)[key], `${path}.${key}`),
    )
  }
  return [`${path}=${canonicalString(value ?? null)}`]
}

/** Fewest line insertions plus deletions turning `a` into `b` (Myers' O(ND)
 * greedy algorithm, which is fast when the texts are close). */
export function lineEditDistance(a: readonly string[], b: readonly string[]): number {
  const n = a.length
  const m = b.length
  const max = n + m
  if (max === 0) return 0
  const offset = max
  const v = new Int32Array(2 * max + 2)
  for (let d = 0; d <= max; d++) {
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)
          ? v[offset + k + 1]!
          : v[offset + k - 1]! + 1
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) {
        x += 1
        y += 1
      }
      v[offset + k] = x
      if (x >= n && y >= m) return d
    }
  }
  return max
}
