/**
 * Track a hillclimb with `ExperimentTracker`: N repetitions per candidate, a
 * KEEP / ITERATE / NOISE / REGRESSION verdict against the parent, and evidence
 * references on every repetition.
 *
 * The tracker answers the question every improvement loop ends on: "I ran the
 * candidate N times — is the median measurably better than the parent, or is
 * the delta inside the noise band?" Each repetition may carry the `runId` that
 * produced it plus `EvidenceRef` pointers to traces, artifacts, or metrics, so
 * a verdict is never a bare number: every rep resolves back to its proof.
 *
 * This example is offline and deterministic. Scores are fixed; a live loop
 * appends each rep as its run completes.
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ExperimentTracker, fileExperimentStore } from '../../src/experiment/index'

async function main(): Promise<void> {
  const storePath = join(mkdtempSync(join(tmpdir(), 'experiment-evidence-')), 'experiments.json')
  const tracker = new ExperimentTracker({
    store: fileExperimentStore(storePath),
    // The default provenance reader shells out to git (commit, subject,
    // changed files). This example pins provenance so its output is stable.
    provenanceReader: () => ({
      commit: 'a1b2c3d',
      message: 'feat: tighten the extraction prompt',
      changedFiles: ['prompts/extraction.md'],
    }),
    // Scores below are percentages, matching the default thresholds:
    // KEEP needs medianDelta > 5, REGRESSION needs < -5, iqr >= 10 is NOISE.
    now: () => Date.parse('2026-08-18T00:00:00Z'),
  })

  await tracker.create({
    id: 'baseline',
    label: 'shipped extraction prompt',
    changeSummary: 'the current production prompt',
  })
  for (const [rep, score] of [62, 60, 64].entries()) {
    await tracker.addRep('baseline', {
      score,
      passed: score >= 60,
      runId: `baseline-rep-${rep}`,
      evidence: [{ kind: 'artifact', uri: `file://runs/baseline/${rep}/report.json` }],
    })
  }

  await tracker.create({
    id: 'tighter-prompt',
    label: 'candidate: schema-first prompt',
    parentId: 'baseline',
    changeSummary: 'lead with the output schema, then the rules',
  })
  for (const [rep, score] of [70, 68, 71].entries()) {
    await tracker.addRep('tighter-prompt', {
      score,
      passed: true,
      runId: `candidate-rep-${rep}`,
      evidence: [
        { kind: 'artifact', uri: `file://runs/tighter-prompt/${rep}/report.json` },
        { kind: 'metric', uri: `metric://tighter-prompt/${rep}/composite` },
      ],
    })
  }

  const log = await tracker.list()
  for (const experiment of log) {
    const { stats } = experiment
    console.log(
      `${experiment.id}: verdict ${experiment.verdict} — median ${stats.median}, iqr ${stats.iqr}, n=${stats.n}`,
    )
  }

  const candidate = log.find((e) => e.id === 'tighter-prompt')
  const firstRep = candidate?.reps[0]
  console.log(`evidence for ${firstRep?.runId}: ${firstRep?.evidence?.map((e) => e.uri).join(', ')}`)
  console.log(`log persisted at ${storePath}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
