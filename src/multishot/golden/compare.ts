// Structural comparison with a readable failure path.
//
// A golden mismatch has to name the field that moved, not print two blobs.
// Every mismatch is one line: the dotted path, what the record holds, and what
// the engine produced.

const MAX_RENDER = 240

export interface CompareOptions {
  /** Stop after this many mismatches. A structural divergence high in the
   *  tree would otherwise report every leaf below it. */
  limit?: number
}

export function compareJson(
  expected: unknown,
  actual: unknown,
  path: string,
  options: CompareOptions = {},
): string[] {
  const mismatches: string[] = []
  walk(expected, actual, path, mismatches, options.limit ?? 25)
  return mismatches
}

function walk(
  expected: unknown,
  actual: unknown,
  path: string,
  out: string[],
  limit: number,
): void {
  if (out.length >= limit) return

  if (Array.isArray(expected) || Array.isArray(actual)) {
    if (!Array.isArray(expected) || !Array.isArray(actual)) {
      out.push(mismatch(path, expected, actual))
      return
    }
    if (expected.length !== actual.length) {
      out.push(`${path}: expected ${expected.length} entries, received ${actual.length}`)
    }
    const shared = Math.min(expected.length, actual.length)
    for (let i = 0; i < shared; i++) walk(expected[i], actual[i], `${path}[${i}]`, out, limit)
    return
  }

  const expectedIsRow = isRow(expected)
  const actualIsRow = isRow(actual)
  if (expectedIsRow || actualIsRow) {
    if (!expectedIsRow || !actualIsRow) {
      out.push(mismatch(path, expected, actual))
      return
    }
    const keys = [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort()
    for (const key of keys) {
      const inExpected = key in expected
      const inActual = key in actual
      const child = path ? `${path}.${key}` : key
      if (!inActual) {
        out.push(`${child}: expected ${render(expected[key])}, received nothing`)
        continue
      }
      if (!inExpected) {
        out.push(`${child}: expected nothing, received ${render(actual[key])}`)
        continue
      }
      walk(expected[key], actual[key], child, out, limit)
      if (out.length >= limit) return
    }
    return
  }

  if (!Object.is(expected, actual)) out.push(mismatch(path, expected, actual))
}

function isRow(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function mismatch(path: string, expected: unknown, actual: unknown): string {
  return `${path}: expected ${render(expected)}, received ${render(actual)}`
}

function render(value: unknown): string {
  if (value === undefined) return 'undefined'
  let text: string
  try {
    text = JSON.stringify(value) ?? String(value)
  } catch {
    text = String(value)
  }
  return text.length > MAX_RENDER ? `${text.slice(0, MAX_RENDER)}…` : text
}
