import { HeldOutGate } from '../src/held-out-gate'
import { build } from './fixtures'

function shifted(before: number[], after: number[], off: number) {
  return build(before.map((x) => x + off), after.map((x) => x + off))
}
const decide = (before: number[], after: number[], off: number, thr: number) => {
  const p = shifted(before, after, off)
  return new HeldOutGate({ baselineKey: 'base', seed: 1337, pairedDeltaThreshold: thr, overfitGapThreshold: 1e9 }).evaluate(p.candidate, p.baseline)
}
const shapes: Array<[string, number[]]> = [
  ['pass/fail {0,1}', [0, 1]],
  ['blocks {0,1/3,2/3,1}', [0, 1 / 3, 2 / 3, 1]],
  ['0-100', [0, 100]],
  ['continuous', [0.11, 0.37, 0.52, 0.68, 0.94]],
]
let seed = 20260727
const rand = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296 }
let shown = 0
for (const [label, levels] of shapes) {
  for (const n of [3, 6, 12, 26]) {
    for (let t = 0; t < 6; t++) {
      const before: number[] = [], after: number[] = []
      for (let i = 0; i < n; i++) { before.push(levels[Math.floor(rand() * levels.length)]!); after.push(levels[Math.floor(rand() * levels.length)]!) }
      const b = decide(before, after, 0, 0)
      for (const off of [1 / 3, 2 / 3, 1, 10, -7.25, 1e4]) {
        const s = decide(before, after, off, 0)
        const diff: string[] = []
        if (s.promote !== b.promote) diff.push(`promote ${b.promote}->${s.promote}`)
        if (s.rejectionCode !== b.rejectionCode) diff.push(`code ${b.rejectionCode}->${s.rejectionCode}`)
        const near = (x: any, y: any) => (x == null || y == null ? x === y : Math.abs(x - y) <= 1e-9 * Math.max(1, Math.abs(y)))
        if (!near(s.evidence.deltaMagnitude, b.evidence.deltaMagnitude)) diff.push(`mag ${b.evidence.deltaMagnitude}->${s.evidence.deltaMagnitude}`)
        if (!near(s.evidence.decidingDelta, b.evidence.decidingDelta)) diff.push(`delta ${b.evidence.decidingDelta}->${s.evidence.decidingDelta}`)
        if (!near(s.evidence.pairedCI?.low, b.evidence.pairedCI?.low)) diff.push(`low ${b.evidence.pairedCI?.low}->${s.evidence.pairedCI?.low}`)
        if (!near(s.evidence.pairedCI?.high, b.evidence.pairedCI?.high)) diff.push(`high ${b.evidence.pairedCI?.high}->${s.evidence.pairedCI?.high}`)
        const pa = s.evidence.signFlip?.pValue, pb = b.evidence.signFlip?.pValue
        if (pa == null || pb == null ? pa !== pb : Math.abs(pa - pb) > 1e-12 * Math.max(1, pb)) diff.push(`p ${pb}->${pa}`)
        if (diff.length && shown++ < 12) console.log(`${label} n=${n} t=${t} off=${off}: ${diff.join(' | ')}`)
      }
    }
  }
}
console.log('TOTAL mismatching comparisons (verdict/code/numbers, p to 1e-12 rel):', shown)
