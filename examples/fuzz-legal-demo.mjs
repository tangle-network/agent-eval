// Demo: run the coverage-guided fuzzer against a legal-flavored behavior cube and
// emit a real capsule. The TARGET here is synthetic (deterministic, patterned) so
// the artifact is reproducible offline — flip `runner.run` to the live router-backed
// legal loop to get real numbers. The ARTIFACT (heat-map + gate-verified failures)
// is identical to a live run.
import { writeFileSync } from 'node:fs'
import {
  fuzzAgent,
  renderCapsuleHtml,
  composeGates,
  severityFloorGate,
  perturbationStabilityGate,
} from '../dist/fuzz.js'

const cube = {
  axes: [
    { name: 'matterType', values: ['nda', 'employment', 'ip-license', 'm&a'] },
    { name: 'difficulty', values: ['routine', 'novel'] },
    { name: 'personaRigor', values: ['cooperative', 'relentless'] },
  ],
}

// deterministic per-id jitter so equal-coord scenarios still differ slightly
const hash = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) } return ((h >>> 0) % 1000) / 1000 }

// Synthetic legal agent: robust on routine+cooperative; degrades on novel matters,
// relentless personas, and complex matter types — and as the fuzzer pressures it.
const score = (s) => {
  let v = 0.9
  if (s.coords.difficulty === 'novel') v -= 0.32
  if (s.coords.personaRigor === 'relentless') v -= 0.22
  if (s.coords.matterType === 'm&a') v -= 0.14
  if (s.coords.matterType === 'ip-license') v -= 0.1
  v -= 0.09 * s.hardness
  v += (hash(s.id) - 0.5) * 0.08
  return Math.max(0, Math.min(1, v))
}

const runner = {
  run: async (s) => {
    const v = score(s)
    return { score: v, passed: v >= 0.5, output: `legal-answer(${s.id})`, failureClass: v < 0.5 ? (s.coords.difficulty === 'novel' ? 'wrong_on_novel_law' : 'missed_protection') : undefined }
  },
}

const generator = {
  seedsFor: (cell) => [{ id: `${cell.id}#0`, coords: cell.coords, hardness: 0 }],
  mutationsFor: () => [
    { id: 'pressure', mutate: (p) => [{ ...p, id: `${p.id}>p`, hardness: p.hardness + 1 }] },
    { id: 'rephrase', mutate: (p) => [{ ...p, id: `${p.id}>r` }] },
  ],
}

// Minimize: shrink the pressure depth to the smallest that still fails.
const minimize = async (s, r, cell) => {
  let lo = 0
  let best = s
  for (let h = 0; h <= s.hardness; h++) {
    const probe = { ...s, id: `${s.id}~m${h}`, hardness: h }
    const o = await r.run(probe, cell)
    if (o.score < 0.5) { best = probe; break }
    lo = h
  }
  return best
}

const text = (s) =>
  `[${s.coords.matterType} · ${s.coords.difficulty} · ${s.coords.personaRigor}] A ${s.coords.personaRigor} client pushes a ${s.coords.difficulty} ${s.coords.matterType} matter (pressure ${s.hardness}). Does the agent hold?`

const { capsule } = await fuzzAgent({
  target: 'legal-agent',
  cube,
  generator,
  runner,
  scenarioId: (s) => s.id,
  scenarioText: text,
  failureThreshold: 0.5,
  budget: 160,
  floorPerCell: 3,
  roundsPerCell: 2,
  seed: 11,
  minimize,
  gates: composeGates(
    severityFloorGate({ margin: 0.04 }),
    perturbationStabilityGate({ runner, perturb: (s) => ({ ...s, id: `${s.id}~rephrase` }) }),
  ),
})

const html = renderCapsuleHtml(capsule, { generatedAt: new Date().toISOString(), maxFailures: 8 })
writeFileSync('/tmp/legal-fuzz-capsule.html', html)
writeFileSync('/tmp/legal-fuzz-capsule.json', JSON.stringify(capsule, null, 2))

const s = capsule.stats
console.log(JSON.stringify({
  totalRuns: s.totalRuns,
  cells: `${s.cellsCovered}/${s.cellsTotal}`,
  meanRobustness: +s.meanRobustness.toFixed(3),
  candidateFailures: s.candidateFailures,
  verifiedFailures: s.verifiedFailures,
  weakestCells: capsule.coverage
    .filter((c) => c.robustness != null)
    .sort((a, b) => a.robustness - b.robustness)
    .slice(0, 4)
    .map((c) => ({ cell: Object.values(c.cell.coords).join('·'), robustness: +c.robustness.toFixed(2), failRate: +c.failureRate.toFixed(2) })),
  topFailure: capsule.failures[0] ? { cell: Object.values(capsule.failures[0].cell.coords).join('·'), severity: +capsule.failures[0].severity.toFixed(2), class: capsule.failures[0].failureClass } : null,
}, null, 2))
