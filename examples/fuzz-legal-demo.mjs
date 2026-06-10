// Demo: adversarial exploration of a legal-flavored behavior space → a real capsule.
// The TARGET here is synthetic (deterministic, patterned) so the artifact is
// reproducible offline — point `evaluate` at the live router-backed legal loop for
// real numbers. The ARTIFACT (heat-map + per-dimension chips + gate-verified
// findings) is identical to a live run.
import { writeFileSync } from 'node:fs'
import {
  composeGates,
  fuzzAgent,
  mutationProposer,
  perturbationStabilityGate,
  renderCapsuleHtml,
  severityFloorGate,
} from '../dist/fuzz.js'

const space = {
  axes: [
    { name: 'matterType', values: ['nda', 'employment', 'ip-license', 'm&a'] },
    { name: 'difficulty', values: ['routine', 'novel'] },
    { name: 'personaRigor', values: ['cooperative', 'relentless'] },
  ],
}

// deterministic per-id jitter so equal-coord scenarios still differ slightly
const hash = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) } return ((h >>> 0) % 1000) / 1000 }

// Synthetic legal agent: robust on routine+cooperative; degrades on novel matters,
// relentless personas, complex matter types — and under the fuzzer's pressure.
const evaluate = async (s) => {
  let v = 0.9
  if (s.coords.difficulty === 'novel') v -= 0.32
  if (s.coords.personaRigor === 'relentless') v -= 0.22
  if (s.coords.matterType === 'm&a') v -= 0.14
  if (s.coords.matterType === 'ip-license') v -= 0.1
  v -= 0.09 * s.hardness
  v += (hash(s.id) - 0.5) * 0.08
  const score = Math.max(0, Math.min(1, v))
  const failed = score < 0.5
  return {
    valid: true,
    score,
    scores: {
      correctness: score,
      citation: Math.max(0, Math.min(1, score + (s.coords.difficulty === 'novel' ? -0.1 : 0.15))),
      safety: Math.min(1, score + 0.25),
    },
    descriptor: { outcome: failed ? (s.coords.difficulty === 'novel' ? 'wrong_on_novel_law' : 'missed_protection') : 'held' },
    labels: failed ? [s.coords.difficulty === 'novel' ? 'wrong_on_novel_law' : 'missed_protection'] : undefined,
    output: `legal-answer(${s.id})`,
  }
}

const seedsFor = (cell) => [{ id: `${cell.id}#0`, coords: cell.coords, hardness: 0 }]
const scenarioId = (s) => s.id
const proposer = mutationProposer({
  scenarioId,
  mutationsFor: () => [
    { id: 'pressure', mutate: (p) => [{ ...p, id: `${p.id}>p`, hardness: p.hardness + 1 }] },
    { id: 'rephrase', mutate: (p) => [{ ...p, id: `${p.id}>r` }] },
  ],
})

// Minimize: smallest pressure depth that still fails.
const minimize = async (s, evaluateFn, cell) => {
  for (let h = 0; h <= s.hardness; h++) {
    const probe = { ...s, id: `${s.id}~m${h}`, hardness: h }
    const o = await evaluateFn(probe, cell)
    if (o.score < 0.5) return probe
  }
  return s
}

const text = (s) =>
  `[${s.coords.matterType} · ${s.coords.difficulty} · ${s.coords.personaRigor}] A ${s.coords.personaRigor} client pushes a ${s.coords.difficulty} ${s.coords.matterType} matter (pressure ${s.hardness}). Does the agent hold?`

const { capsule } = await fuzzAgent({
  target: 'legal-agent',
  space,
  proposer,
  evaluate,
  seedsFor,
  scenarioId,
  scenarioText: text,
  budget: 160,
  floorPerCell: 3,
  seed: 11,
  minimize,
  gates: composeGates(
    severityFloorGate({ margin: 0.04 }),
    perturbationStabilityGate({ evaluate, perturb: (s) => ({ ...s, id: `${s.id}~rephrase` }) }),
  ),
})

const html = renderCapsuleHtml(capsule, { generatedAt: new Date().toISOString(), maxFindings: 8 })
writeFileSync('/tmp/legal-fuzz-capsule.html', html)
writeFileSync('/tmp/legal-fuzz-capsule.json', JSON.stringify(capsule, null, 2))

const s = capsule.stats
console.log(JSON.stringify({
  totalRuns: s.totalRuns,
  cells: `${s.cellsCovered}/${s.cellsTotal}`,
  behaviorBinsObserved: s.behaviorBinsObserved,
  meanRobustness: +s.meanRobustness.toFixed(3),
  candidateFindings: s.candidateFindings,
  verifiedFindings: s.verifiedFindings,
  weakestCells: capsule.coverage
    .filter((c) => c.robustness != null)
    .sort((a, b) => a.robustness - b.robustness)
    .slice(0, 4)
    .map((c) => ({
      cell: Object.values(c.cell.coords).join('·'),
      robustness: +c.robustness.toFixed(2),
      weakestDim: Object.entries(c.dimensions).sort((a, b) => a[1] - b[1])[0]?.[0],
    })),
  topFinding: capsule.findings[0]
    ? {
        cell: Object.values(capsule.findings[0].cell.coords).join('·'),
        interest: +capsule.findings[0].interest.toFixed(2),
        labels: capsule.findings[0].evaluation.labels,
      }
    : null,
}, null, 2))
