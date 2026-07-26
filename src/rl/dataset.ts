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
 * uses. This module computes those facts from `MintedRolloutLine[]` and renders a
 * "Datasheet for Datasets" (Gebru et al. 2018) card alongside the format files.
 *
 * It composes the existing `rl/exporters` — it does not reimplement any trainer
 * format. The renderers token-identity step (DeepSeek/Kimi/Qwen tokenization
 * with per-token loss masks) is a downstream Python stage that consumes the
 * `messages`/`completions` this bundle emits.
 *
 * Input discipline: the bundle is built from `MintedRolloutLine[]`. The datasheet's
 * reward distribution ships INSIDE the published artifact, so it has to be
 * derived from exactly the same gated number as the rows it describes —
 * otherwise the provenance a buyer checks first is a lie. Taking the same
 * gated input as the exporters is what guarantees that.
 */

import type { MintedRolloutLine, RolloutSplit } from '../rollout/schema'
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
import { trainableLineReward } from './rollout-input'

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
  /** Rollouts carrying an explicit task-quality score. */
  scoredRecords: number
  /** Rollout count per split. */
  splits: Record<RolloutSplit, number>
  reward: RewardStats
  /** Distinct snapshot-pinned models that produced the trajectories. */
  models: string[]
  /** Distinct effective-prompt hashes (the agent profile/prompt versions). */
  promptHashes: string[]
  commitShas: string[]
  totalTokens: { input: number; output: number }
  totalCostUsd: number
  /**
   * Rollouts whose USD cost was never captured (`cost.usd === null`). When
   * non-zero, `totalCostUsd` is a floor, not the bill — a published dataset
   * must not present an unbilled run as a $0 one.
   */
  rolloutsWithoutCost: number
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

function distinct(xs: Array<string | null | undefined>): string[] {
  return [...new Set(xs.filter((x): x is string => typeof x === 'string' && x.length > 0))].sort()
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

function computeStatsFromLines(lines: MintedRolloutLine[]): RlDatasetStats {
  const splits: Record<RolloutSplit, number> = { search: 0, dev: 0, holdout: 0, canary: 0 }
  let inTok = 0
  let outTok = 0
  let cost = 0
  let rolloutsWithoutCost = 0
  const rewards: number[] = []
  for (const line of lines) {
    splits[line.task.split] += 1
    inTok += line.cost.tokens_in ?? 0
    outTok += line.cost.tokens_out ?? 0
    if (line.cost.usd === null) rolloutsWithoutCost++
    else cost += line.cost.usd
    const rw = trainableLineReward(line)
    if (rw !== null) rewards.push(rw)
  }
  return {
    records: lines.length,
    scoredRecords: rewards.length,
    splits,
    reward: computeRewardStats(rewards),
    models: distinct(lines.map((l) => l.policy.model)),
    promptHashes: distinct(lines.map((l) => l.policy.prompt_hash)),
    commitShas: distinct(lines.map((l) => l.policy.profile_commit)),
    totalTokens: { input: inTok, output: outTok },
    totalCostUsd: cost,
    rolloutsWithoutCost,
  }
}

/**
 * Package graded rollout lines into a publishable RL dataset bundle: the
 * trainer-format JSONL files + a manifest + a datasheet. DPO requires
 * pre-extracted preference triples (pass `preferences`); GRPO/SFT derive from
 * the lines directly via the supplied lookups. Throws on an empty corpus —
 * an empty dataset must never be published.
 */
export async function buildRlDataset(
  lines: MintedRolloutLine[],
  lookups: GrpoLookups & SftLookups,
  config: RlDatasetConfig,
  preferences?: { triples: PreferenceTriple[]; lookups: DpoLookups },
): Promise<RlDatasetBundle> {
  if (lines.length === 0) {
    throw new Error('buildRlDataset: no rollout lines — refusing to package an empty dataset')
  }
  const formats = validateDatasetFormats(config.formats === undefined ? ['sft'] : config.formats)
  const files: Record<string, string> = {}
  const rowCounts: Partial<Record<DatasetFormat, number>> = {}

  if (formats.includes('grpo')) {
    const rows = await toGrpoRows(lines, lookups)
    requireRows('grpo', rows.length)
    files['train.grpo.jsonl'] = toGrpoJsonl(rows)
    rowCounts.grpo = rows.length
  }
  if (formats.includes('sft')) {
    const rows = await toSftRows(lines, lookups)
    requireRows('sft', rows.length)
    files['train.sft.jsonl'] = toSftJsonl(rows)
    rowCounts.sft = rows.length
  }
  if (formats.includes('dpo')) {
    if (!preferences) {
      throw new Error("buildRlDataset: format 'dpo' requires `preferences` (triples + lookups)")
    }
    const rows = await toDpoRows(preferences.triples, preferences.lookups, { lines })
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
    stats: computeStatsFromLines(lines),
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
  const splitLines = (['search', 'dev', 'holdout', 'canary'] as RolloutSplit[])
    .map((k) => `  - \`${k}\`: ${s.splits[k]} (${pct(s.splits[k] / total)})`)
    .join('\n')
  const costNote =
    s.rolloutsWithoutCost > 0
      ? ` (floor — ${s.rolloutsWithoutCost} rollout(s) never captured a cost)`
      : ''
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
    `- **Tokens:** ${s.totalTokens.input} in / ${s.totalTokens.output} out | **Cost:** $${s.totalCostUsd.toFixed(2)}${costNote}`,
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
