/**
 * RL dataset packaging + datasheet — the publishable, sellable bundle.
 *
 * The format exporters (`toGrpoRows` / `toSftRows` / `toDpoRows`) already
 * produce trainer-ready shapes (prime-rl GRPO, TRL DPO, conversational SFT).
 * What turns that into a dataset someone can PUBLISH or BUY is the provenance
 * + a datasheet: which models produced it, which prompt/agent versions, how the
 * reward was derived (deterministic verifiable vs probabilistic judge — the
 * credibility axis a buyer checks first), the split discipline, the reward
 * distribution, the quality gates, the license, and the intended/out-of-scope
 * uses. This module computes those facts from the `RunRecord[]` and renders a
 * "Datasheet for Datasets" (Gebru et al. 2018) card alongside the format files.
 *
 * It composes the existing `rl/exporters` — it does not reimplement any trainer
 * format. The renderers token-identity step (DeepSeek/Kimi/Qwen tokenization
 * with per-token loss masks) is a downstream Python stage that consumes the
 * `messages`/`completions` this bundle emits.
 */

import { type RunRecord, type RunSplitTag, runTaskScore } from '../run-record'
import {
  type DpoLookups,
  type GrpoLookups,
  type SftLookups,
  toDpoJsonl,
  toDpoRows,
  toGrpoJsonl,
  toGrpoRows,
  toSftJsonl,
  toSftRows,
} from './exporters'
import type { PreferenceTriple } from './preferences'

export type RewardKind = 'deterministic' | 'probabilistic' | 'mixed'
const DATASET_FORMATS = ['grpo', 'sft', 'dpo'] as const
export type DatasetFormat = (typeof DATASET_FORMATS)[number]

const DATASET_FORMAT_SET = new Set<unknown>(DATASET_FORMATS)

export function validateDatasetFormats(value: unknown): DatasetFormat[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('buildRlDataset: formats must contain at least one of: grpo, sft, dpo')
  }

  const formats: DatasetFormat[] = []
  const seen = new Set<DatasetFormat>()
  for (const format of value) {
    if (!DATASET_FORMAT_SET.has(format)) {
      throw new Error(
        `buildRlDataset: unsupported format ${JSON.stringify(format)}; expected exactly one of: grpo, sft, dpo`,
      )
    }
    const datasetFormat = format as DatasetFormat
    if (seen.has(datasetFormat)) {
      throw new Error(
        `buildRlDataset: duplicate format ${JSON.stringify(datasetFormat)}; each format may be requested once`,
      )
    }
    seen.add(datasetFormat)
    formats.push(datasetFormat)
  }
  return formats
}

/** Caller-declared context — the qualitative half of the datasheet that can't
 *  be computed from records. */
export interface RlDatasetConfig {
  name: string
  version: string
  /** Product/task domain, e.g. 'legal-m&a', 'tax-1040'. */
  domain: string
  /** SPDX id or a named commercial license. Required — an unlicensed dataset
   *  cannot be published or sold. */
  license: string
  /** How the reward was produced. `kind: 'deterministic'` (a test/schema/XPath
   *  decided it) is the credibility signal; 'probabilistic' = LLM-judge. */
  reward: { kind: RewardKind; source: string; description: string }
  intendedUse: string
  outOfScope: string
  limitations: string
  /** ISO timestamp — passed in (the substrate forbids Date.now()). */
  createdAtIso: string
  /** Default: ['sft']. GRPO must be requested for multi-completion groups. */
  formats?: DatasetFormat[]
  /** Quality gates already run, recorded on the card for the buyer. */
  qualityGates?: {
    contaminationProbe?: 'passed' | 'failed' | 'not-run'
    dedup?: boolean
    verifiableRewardFilter?: boolean
  }
}

export interface RewardStats {
  n: number
  mean: number | null
  median: number | null
  min: number | null
  max: number | null
  std: number | null
}

export interface RlDatasetStats {
  records: number
  /** Records carrying an explicit task-quality score. */
  scoredRecords: number
  /** Record count per split — a publishable dataset must declare its holdout. */
  splits: Record<RunSplitTag, number>
  reward: RewardStats
  /** Distinct snapshot-pinned models that produced the trajectories. */
  models: string[]
  /** Distinct effective-prompt hashes (the agent profile/prompt versions). */
  promptHashes: string[]
  commitShas: string[]
  totalTokens: { input: number; output: number }
  totalCostUsd: number
}

export interface RlDatasetManifest extends RlDatasetConfig {
  formats: DatasetFormat[]
  rowCounts: Partial<Record<DatasetFormat, number>>
  stats: RlDatasetStats
}

export interface RlDatasetBundle {
  manifest: RlDatasetManifest
  /** Relative filename -> contents. Write these to a directory to publish. */
  files: Record<string, string>
}

function reward(r: RunRecord, rewardOf?: GrpoLookups['rewardOf']): number | null {
  const value = rewardOf ? rewardOf(r) : (runTaskScore(r) ?? null)
  if (value !== null && !Number.isFinite(value)) {
    throw new Error(`buildRlDataset: reward for run "${r.runId}" must be finite`)
  }
  return value
}

function distinct(xs: string[]): string[] {
  return [...new Set(xs)].sort()
}

function computeRewardStats(values: number[]): RewardStats {
  if (values.length === 0) {
    return { n: 0, mean: null, median: null, min: null, max: null, std: null }
  }
  const sorted = [...values].sort((a, b) => a - b)
  const n = sorted.length
  const mean = sorted.reduce((s, x) => s + x, 0) / n
  const mid = Math.floor(n / 2)
  const median = n % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!
  const variance = sorted.reduce((s, x) => s + (x - mean) ** 2, 0) / n
  return { n, mean, median, min: sorted[0]!, max: sorted[n - 1]!, std: Math.sqrt(variance) }
}

function computeStats(records: RunRecord[], rewardOf?: GrpoLookups['rewardOf']): RlDatasetStats {
  const splits: Record<RunSplitTag, number> = { search: 0, dev: 0, holdout: 0 }
  let inTok = 0
  let outTok = 0
  let cost = 0
  const rewards: number[] = []
  for (const r of records) {
    splits[r.splitTag] = (splits[r.splitTag] ?? 0) + 1
    inTok += r.tokenUsage.input
    outTok += r.tokenUsage.output
    cost += r.costUsd ?? 0
    const rw = reward(r, rewardOf)
    if (rw !== null) rewards.push(rw)
  }
  return {
    records: records.length,
    scoredRecords: rewards.length,
    splits,
    reward: computeRewardStats(rewards),
    models: distinct(records.map((r) => r.model)),
    promptHashes: distinct(records.map((r) => r.promptHash)),
    commitShas: distinct(records.map((r) => r.commitSha)),
    totalTokens: { input: inTok, output: outTok },
    totalCostUsd: cost,
  }
}

/**
 * Package graded `RunRecord[]` into a publishable RL dataset bundle: the
 * trainer-format JSONL files + a manifest + a datasheet. DPO requires
 * pre-extracted preference triples (pass `preferences`); GRPO/SFT derive from
 * the records directly via the supplied lookups. Throws on an empty corpus —
 * an empty dataset must never be published.
 */
export async function buildRlDataset(
  records: RunRecord[],
  lookups: GrpoLookups & SftLookups,
  config: RlDatasetConfig,
  preferences?: { triples: PreferenceTriple[]; lookups: DpoLookups },
): Promise<RlDatasetBundle> {
  if (records.length === 0) {
    throw new Error('buildRlDataset: no records — refusing to package an empty dataset')
  }
  const formats = validateDatasetFormats(config.formats === undefined ? ['sft'] : config.formats)
  const files: Record<string, string> = {}
  const rowCounts: Partial<Record<DatasetFormat, number>> = {}

  if (formats.includes('grpo')) {
    const rows = await toGrpoRows(records, lookups)
    requireRows('grpo', rows.length)
    files['train.grpo.jsonl'] = toGrpoJsonl(rows)
    rowCounts.grpo = rows.length
  }
  if (formats.includes('sft')) {
    const rows = await toSftRows(records, lookups)
    requireRows('sft', rows.length)
    files['train.sft.jsonl'] = toSftJsonl(rows)
    rowCounts.sft = rows.length
  }
  if (formats.includes('dpo')) {
    if (!preferences) {
      throw new Error("buildRlDataset: format 'dpo' requires `preferences` (triples + lookups)")
    }
    const rows = await toDpoRows(preferences.triples, preferences.lookups)
    requireRows('dpo', rows.length)
    files['train.dpo.jsonl'] = toDpoJsonl(rows)
    rowCounts.dpo = rows.length
  }
  if (!Object.keys(files).some((name) => name.startsWith('train.') && name.endsWith('.jsonl'))) {
    throw new Error('buildRlDataset: no trainer file was emitted')
  }

  const manifest: RlDatasetManifest = {
    ...config,
    formats,
    rowCounts,
    stats: computeStats(records, lookups.rewardOf),
  }
  files['manifest.json'] = `${JSON.stringify(manifest, null, 2)}\n`
  files['DATASHEET.md'] = datasheetToMarkdown(manifest)
  return { manifest, files }
}

function requireRows(format: DatasetFormat, rows: number): void {
  if (rows === 0) {
    throw new Error(`buildRlDataset: requested '${format}' format produced no trainable rows`)
  }
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`
}

function stat(value: number | null): string {
  return value === null ? 'n/a' : value.toFixed(3)
}

/** Render the "Datasheet for Datasets" card that a buyer reads. */
export function datasheetToMarkdown(m: RlDatasetManifest): string {
  const s = m.stats
  const total = s.records || 1
  const splitLines = (['search', 'dev', 'holdout'] as RunSplitTag[])
    .map((k) => `  - \`${k}\`: ${s.splits[k]} (${pct(s.splits[k] / total)})`)
    .join('\n')
  const deterministic = m.reward.kind === 'deterministic'
  return [
    `# Dataset: ${m.name} \`v${m.version}\``,
    '',
    `**Domain:** ${m.domain} | **Created:** ${m.createdAtIso} | **License:** ${m.license}`,
    '',
    '## Reward provenance',
    `- **Kind:** ${m.reward.kind}${deterministic ? ' (decidable, not judge noise)' : ''}`,
    `- **Source:** ${m.reward.source}`,
    `- **Description:** ${m.reward.description}`,
    '',
    '## Composition',
    `- **Records (trajectories):** ${s.records}`,
    `- **Scored records:** ${s.scoredRecords}`,
    `- **Formats:** ${m.formats.map((f) => `${f} (${m.rowCounts[f] ?? 0} rows)`).join(', ')}`,
    '- **Splits:**',
    splitLines,
    '',
    '## Reward distribution',
    `- n=${s.reward.n} | mean=${stat(s.reward.mean)} | median=${stat(s.reward.median)} | min=${stat(s.reward.min)} | max=${stat(s.reward.max)} | std=${stat(s.reward.std)}`,
    '',
    '## Provenance',
    `- **Models:** ${s.models.join(', ')}`,
    `- **Prompt/agent versions (sha256):** ${s.promptHashes.length} distinct`,
    `- **Commits:** ${s.commitShas.join(', ')}`,
    `- **Tokens:** ${s.totalTokens.input} in / ${s.totalTokens.output} out | **Cost:** $${s.totalCostUsd.toFixed(2)}`,
    '',
    '## Quality gates',
    `- Contamination probe: ${m.qualityGates?.contaminationProbe ?? 'not-run'}`,
    `- Dedup: ${m.qualityGates?.dedup ? 'yes' : 'no'} | Verifiable-reward filter: ${m.qualityGates?.verifiableRewardFilter ? 'yes' : 'no'}`,
    '',
    '## Recommended uses',
    m.intendedUse,
    '',
    '## Out of scope',
    m.outOfScope,
    '',
    '## Limitations',
    m.limitations,
    '',
    '## Token rendering',
    'For RL/SFT training, tokenize with the per-model renderer (DeepSeek-V3 / Kimi-K2 / Qwen3) to preserve token identity and per-token loss masks across tool-call turns. See `renderers` (PrimeIntellect). The `messages` / `completions` here are the renderer input.',
    '',
  ].join('\n')
}
