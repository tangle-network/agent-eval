// Original local integration fixture: an actual file/process measurement, not a model or a
// simulation of a published benchmark. Native absolute error is deliberately unbounded.
import { readFileSync } from 'node:fs'

const values = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const expected = JSON.parse(process.argv[3])
if (!Array.isArray(values) || values.length !== expected.length ||
  values.some((value) => typeof value !== 'number' || !Number.isFinite(value))) {
  throw new Error('invalid numerical artifact')
}
const absoluteError = values.reduce((sum, value, i) => sum + Math.abs(value - expected[i]), 0)
process.stdout.write(JSON.stringify({
  score: Math.max(0, 1 - absoluteError / 10),
  passed: absoluteError === 0,
  dimensions: { absoluteError },
  raw: { absoluteError, values, expected },
}))
