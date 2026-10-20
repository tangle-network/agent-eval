/** Read artifact content and identify normalized paragraph edits with a shortest edit script. */
import type { SearchArtifactRef } from '../../campaign/search-ledger-types'
import { canonicalString, compareCodeUnits } from '../../ledger-core/canonical'
import type {
  EditCreditOptions,
  GeneCut,
  KnownContent,
  NodeContent,
  PathText,
} from './edit-credit-contract'

export function nodeContent(options: EditCreditOptions, ref: SearchArtifactRef): NodeContent {
  const body = options.readArtifact(ref)
  if (body === undefined) return { known: false, reason: `artifact ${ref.role} unreadable` }
  const paths = new Map<string, PathText>()
  const record = body as { kind?: unknown; surface?: unknown }
  if (record && typeof record === 'object' && record.kind === 'mutable-surface') {
    const surface = record.surface as
      | string
      | { kind: 'components'; components: Record<string, string> }
      | { kind: 'code' }
      | undefined
    if (typeof surface === 'string') addText(paths, 'prompt', surface)
    else if (surface?.kind === 'components') {
      for (const name of Object.keys(surface.components).sort(compareCodeUnits)) {
        addText(paths, `component:${name}`, surface.components[name]!)
      }
    } else {
      return { known: false, reason: 'code surface: its patch bytes are not in the ledger' }
    }
  } else {
    flatten(body, '', paths)
  }
  const haystacks = new Map<string, string>()
  for (const [path, text] of paths) {
    haystacks.set(path, `\n${text.norm.filter((line) => line.length > 0).join('\n')}\n`)
  }
  return { known: true, paths, haystacks }
}

/** JSON as text per location: a string's lines at its path, an array's
 * elements as lines at the array's path, any other value as one canonical
 * line. Array elements share a path, so an insertion does not renumber the
 * rest. */
function flatten(value: unknown, path: string, paths: Map<string, PathText>): void {
  const at = path === '' ? '/' : path
  if (typeof value === 'string') {
    addText(paths, at, value)
  } else if (Array.isArray(value)) {
    for (const element of value) {
      addText(paths, at, typeof element === 'string' ? element : canonicalString(element))
    }
  } else if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value).sort(compareCodeUnits)) {
      const escaped = key.replaceAll('~', '~0').replaceAll('/', '~1')
      flatten((value as Record<string, unknown>)[key], `${path}/${escaped}`, paths)
    }
  } else {
    addText(paths, at, canonicalString(value))
  }
}

function addText(paths: Map<string, PathText>, path: string, text: string): void {
  const entry = paths.get(path) ?? { raw: [], norm: [] }
  for (const line of text.split(/\r?\n/)) {
    entry.raw.push(line)
    entry.norm.push(line.replace(/\s+/g, ' ').trim())
  }
  paths.set(path, entry)
}

export function carries(
  content: KnownContent,
  gene: { kind: 'insert' | 'delete'; path: string; needle: string },
): boolean {
  const present = content.haystacks.get(gene.path)?.includes(gene.needle) ?? false
  return gene.kind === 'insert' ? present : !present
}

export function locusOf(cut: { path: string; lines: readonly string[] }): string {
  return canonicalString([cut.path, cut.lines])
}

// ---------------------------------------------------------------------------
// Genes

export function edgeCuts(parent: KnownContent, child: KnownContent): GeneCut[] {
  const cuts: GeneCut[] = []
  const paths = new Set([...parent.paths.keys(), ...child.paths.keys()])
  let position = 0
  for (const path of [...paths].sort(compareCodeUnits)) {
    const before = parent.paths.get(path) ?? { raw: [], norm: [] }
    const after = child.paths.get(path) ?? { raw: [], norm: [] }
    for (const run of changeRuns(before.norm, after.norm)) {
      for (const [kind, side, start, end] of [
        ['delete', before, run.aStart, run.aEnd],
        ['insert', after, run.bStart, run.bEnd],
      ] as const) {
        for (const [from, to] of paragraphs(side.norm, start, end)) {
          const lines = side.norm.slice(from, to).filter((line) => line.length > 0)
          if (lines.length === 0) continue
          cuts.push({
            kind,
            path,
            lines,
            needle: `\n${lines.join('\n')}\n`,
            text: side.raw.slice(from, to).join('\n').trim(),
            position: position++,
          })
        }
      }
    }
  }
  return cuts
}

/** Paragraph ranges of `lines[start, end)`, split at blank lines. */
function paragraphs(lines: readonly string[], start: number, end: number): Array<[number, number]> {
  const ranges: Array<[number, number]> = []
  let from = -1
  for (let index = start; index < end; index++) {
    if (lines[index]!.length === 0) {
      if (from >= 0) ranges.push([from, index])
      from = -1
    } else if (from < 0) {
      from = index
    }
  }
  if (from >= 0) ranges.push([from, end])
  return ranges
}

interface ChangeRun {
  aStart: number
  aEnd: number
  bStart: number
  bEnd: number
}

/** Maximal runs where `a[aStart, aEnd)` became `b[bStart, bEnd)`, from a
 * shortest edit script (Myers, 1986). */
function changeRuns(a: readonly string[], b: readonly string[]): ChangeRun[] {
  let prefix = 0
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix += 1
  let suffix = 0
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix += 1
  }
  const innerA = a.slice(prefix, a.length - suffix)
  const innerB = b.slice(prefix, b.length - suffix)
  const runs: ChangeRun[] = []
  let i = 0
  let j = 0
  const flush = (toI: number, toJ: number) => {
    if (toI > i || toJ > j) {
      runs.push({ aStart: prefix + i, aEnd: prefix + toI, bStart: prefix + j, bEnd: prefix + toJ })
    }
  }
  for (const [mi, mj] of matches(innerA, innerB)) {
    flush(mi, mj)
    i = mi + 1
    j = mj + 1
  }
  flush(innerA.length, innerB.length)
  return runs
}

/** Matched index pairs of a shortest edit script, in increasing order. */
function matches(a: readonly string[], b: readonly string[]): Array<[number, number]> {
  const n = a.length
  const m = b.length
  if (n === 0 || m === 0) return []
  const offset = n + m
  const v = new Int32Array(2 * offset + 2)
  const trace: Int32Array[] = []
  let done = false
  for (let d = 0; d <= n + m && !done; d++) {
    trace.push(v.slice())
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && v[k - 1 + offset]! < v[k + 1 + offset]!)
          ? v[k + 1 + offset]!
          : v[k - 1 + offset]! + 1
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) {
        x += 1
        y += 1
      }
      v[k + offset] = x
      if (x >= n && y >= m) {
        done = true
        break
      }
    }
  }
  const pairs: Array<[number, number]> = []
  let x = n
  let y = m
  for (let d = trace.length - 1; d >= 0; d--) {
    const before = trace[d]!
    const k = x - y
    const prevK =
      k === -d || (k !== d && before[k - 1 + offset]! < before[k + 1 + offset]!) ? k + 1 : k - 1
    const prevX = before[prevK + offset]!
    const prevY = prevX - prevK
    while (x > prevX && y > prevY) {
      x -= 1
      y -= 1
      pairs.push([x, y])
    }
    if (d > 0) {
      x = prevX
      y = prevY
    }
  }
  return pairs.reverse()
}
