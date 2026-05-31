import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { AgentProfile } from '../../src/agent-profile'
import {
  inMemoryCampaignStorage,
  type JudgeConfig,
  type ProfileDispatchFn,
  runProfileMatrix,
  type Scenario,
} from '../../src/campaign/index'
import { appendToCorpus, buildDatasetFromCorpus, type RlDatasetConfig } from '../../src/rl'

// END-TO-END COMPOSITION (the substrate the self-improvement loop rests on):
//   runProfileMatrix → multi-dimensional raw (cost/tokens/latency) + corpusText
//   trajectory capture → records ARE CorpusRecords → appendToCorpus →
//   buildDatasetFromCorpus → a publishable bundle.
// Three primitives shipped separately (PR #90 cost seam, #149 corpus store, #150
// multi-dim raw + corpusText); this proves they COMPOSE into "every graded run
// becomes free, multi-dimensional dataset exhaust." A regression here means the
// loop silently loses cost capture, trajectory text, or the harvest.

interface S extends Scenario {
  id: string
  kind: string
}
interface A {
  text: string
}

const SCENARIOS: S[] = [
  { id: 'case-1', kind: 'task' },
  { id: 'case-2', kind: 'task' },
]
const PROFILE: AgentProfile = {
  id: 'agent-v1',
  model: 'deepseek-v4-pro@2026-05-31',
  promptVersion: 'v1',
}

// Real-shaped dispatch: reports cost + tokens (the integrity guard + the cost
// dimension depend on it) and returns the agent's output text.
const dispatch: ProfileDispatchFn<S, A> = async (profile, scenario, ctx) => {
  ctx.cost.observe(0.002, 'llm')
  ctx.cost.observeTokens({ input: 1500, output: 300 })
  return { text: `FORM for ${scenario.id} by ${profile.id}` }
}

const judge: JudgeConfig<A, S> = {
  name: 'objective',
  dimensions: [{ key: 'by_line', description: 'line-match' }],
  score: ({ artifact }) => {
    const by_line = artifact.text.includes('FORM') ? 0.9 : 0.1
    return { dimensions: { by_line }, composite: by_line, notes: `by_line=${by_line}` }
  },
}

const datasetConfig: RlDatasetConfig = {
  name: 'compose-e2e',
  version: '0.1.0',
  domain: 'test',
  license: 'Tangle Commercial',
  createdAtIso: '2026-05-31T00:00:00Z',
  reward: { kind: 'deterministic', source: 'objective judge', description: 'line match' },
  intendedUse: 'compose test',
  outOfScope: 'n/a',
  limitations: 'synthetic',
}

const DIR = mkdtempSync(join(tmpdir(), 'corpus-compose-'))
afterAll(() => rmSync(DIR, { recursive: true, force: true }))

describe('substrate composition: matrix → multi-dim + corpus → dataset (datasets for free)', () => {
  it('a graded matrix run produces multi-dim records that harvest into a publishable bundle', async () => {
    const corpus = join(DIR, 'corpus.jsonl')

    // 1. Run the matrix with trajectory capture wired (corpusText).
    const result = await runProfileMatrix<S, A>({
      profiles: [PROFILE],
      scenarios: SCENARIOS,
      dispatch,
      judges: [judge],
      runDir: join(DIR, 'runs'),
      commitSha: 'deadbeef',
      reps: 2,
      storage: inMemoryCampaignStorage(),
      corpusText: (artifact, scenario) => ({
        prompt: `prepare ${scenario.id}`,
        completion: artifact.text,
      }),
    })

    // 2. Every record is multi-dimensional AND carries trajectory text.
    expect(result.records).toHaveLength(4) // 1 profile × 2 scenarios × 2 reps
    expect(result.integrity.verdict).toBe('real') // cost+tokens flowed (PR #90/#150)
    for (const rec of result.records as Array<
      (typeof result.records)[number] & { prompt?: string; completion?: string }
    >) {
      expect(rec.outcome.raw.cost_usd).toBe(0.002)
      expect(rec.outcome.raw.tokens_input).toBe(1500)
      expect(rec.outcome.raw.tokens_per_dollar).toBeCloseTo(1800 / 0.002, 3)
      expect(rec.prompt).toMatch(/^prepare case-[12]$/)
      expect(rec.completion).toContain('FORM')
    }

    // 3. The records ARE CorpusRecords → append with no transform.
    const appended = appendToCorpus(result.records as Parameters<typeof appendToCorpus>[0], corpus)
    expect(appended.appended).toBe(4)

    // 4. A second matrix run accumulates into the same corpus (the flywheel).
    const result2 = await runProfileMatrix<S, A>({
      profiles: [{ ...PROFILE, id: 'agent-v2', promptVersion: 'v2' }],
      scenarios: SCENARIOS,
      dispatch,
      judges: [judge],
      runDir: join(DIR, 'runs2'),
      commitSha: 'deadbeef',
      reps: 1,
      storage: inMemoryCampaignStorage(),
      corpusText: (artifact, scenario) => ({
        prompt: `prepare ${scenario.id}`,
        completion: artifact.text,
      }),
    })
    const appended2 = appendToCorpus(
      result2.records as Parameters<typeof appendToCorpus>[0],
      corpus,
    )
    expect(appended2.total).toBe(6) // 4 + 2

    // 5. Harvest the accumulated corpus into a publishable bundle.
    const bundle = await buildDatasetFromCorpus(corpus, datasetConfig)
    expect(bundle.manifest.stats.records).toBe(6)
    expect(bundle.files['train.sft.jsonl']!.trim().split('\n')).toHaveLength(6)
    // The SFT rows carry the real trajectory text the matrix captured.
    const firstRow = JSON.parse(bundle.files['train.sft.jsonl']!.trim().split('\n')[0]!)
    expect(firstRow.messages.find((m: { role: string }) => m.role === 'user').content).toMatch(
      /prepare case/,
    )
    expect(
      firstRow.messages.find((m: { role: string }) => m.role === 'assistant').content,
    ).toContain('FORM')
    // Datasheet declares the deterministic reward provenance (the sellability axis).
    expect(bundle.files['DATASHEET.md']).toContain('deterministic')
  })
})
