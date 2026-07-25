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
 *
 * Input discipline: the bundle is built from `MintedRolloutLine[]`. The datasheet's
 * reward distribution ships INSIDE the published artifact, so it has to be
 * derived from exactly the same gated number as the rows it describes —
 * otherwise the provenance a buyer checks first is a lie. Taking the same
 * gated input as the exporters is what guarantees that.
 */

import type { MintedRolloutLine, RolloutSplit } from '../rollout/schema'
import type { RunRecord, RunSplitTag } from '../run-record'
import {
  type DpoLookups,
  type GrpoLineLookups,
  type GrpoLookups,
  type SftLineLookups,
  type SftLookups,
  toDpoJsonl,
  toDpoRows,
  toGrpoJsonl,
  toGrpoRows,
  toSftJsonl,
  toSftRows,
} from './exporters'
import type { PreferenceTriple } from './preferences'
import { isRolloutLineInput, mintLinesFromRecords, trainableLineReward } from './rollout-input'

export type RewardKind = 'deterministic' | 'probabilistic' | 'mixed'
export type DatasetFormat = 'grpo' | 'sft' | 'dpo'

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
  /** Default: ['grpo', 'sft']. */
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
  mean: number
  median: number
  min: number
  max: number
  std: number
}

export interface RlDatasetStats {
  records: number
  /** Record count per split — a publishable dataset must declare its holdout. */
  splits: Record<RunSplitTag, number>
  /**
   * Exact per-split counts, including the rollout-only splits a RunRecord
   * cannot express. `splits` folds `'train'` into `'search'` (the schema
   * declares it a legacy alias) and has no bucket for `'canary'` at all, so a
   * canary line would vanish from the published split table without this.
   */
  rolloutSplits: Partial<Record<RolloutSplit, number>>
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

/** `'train'` is the pre-unification alias for `'search'` (see rollout/schema). */
const RUN_SPLIT_OF: Partial<Record<RolloutSplit, RunSplitTag>> = {
  search: 'search',
  train: 'search',
  dev: 'dev',
  holdout: 'holdout',
}

function computeRewardStats(values: number[]): RewardStats {
  if (values.length === 0) return { n: 0, mean: 0, median: 0, min: 0, max: 0, std: 0 }
  const sorted = [...values].sort((a, b) => a - b)
  const n = sorted.length
  const mean = sorted.reduce((s, x) => s + x, 0) / n
  const mid = Math.floor(n / 2)
  const median = n % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!
  const variance = sorted.reduce((s, x) => s + (x - mean) ** 2, 0) / n
  return { n, mean, median, min: sorted[0]!, max: sorted[n - 1]!, std: Math.sqrt(variance) }
}

function computeStats(lines: MintedRolloutLine[]): RlDatasetStats {
  const splits: Record<RunSplitTag, number> = { search: 0, dev: 0, holdout: 0 }
  const rolloutSplits: Partial<Record<RolloutSplit, number>> = {}
  let inTok = 0
  let outTok = 0
  let cost = 0
  let rolloutsWithoutCost = 0
  const rewards: number[] = []
  for (const line of lines) {
    const split = line.task.split
    rolloutSplits[split] = (rolloutSplits[split] ?? 0) + 1
    const runSplit = RUN_SPLIT_OF[split]
    if (runSplit !== undefined) splits[runSplit] += 1
    inTok += line.cost.tokens_in ?? 0
    outTok += line.cost.tokens_out ?? 0
    if (line.cost.usd === null) rolloutsWithoutCost++
    else cost += line.cost.usd
    const rw = trainableLineReward(line)
    if (rw !== null) rewards.push(rw)
  }
  return {
    records: lines.length,
    splits,
    rolloutSplits,
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
  lookups: GrpoLineLookups & SftLineLookups,
  config: RlDatasetConfig,
  preferences?: { triples: PreferenceTriple[]; lookups: DpoLookups },
): Promise<RlDatasetBundle>
/**
 * @deprecated Pass `RolloutLine[]` (mint with `mintRolloutRows`). This
 * signature mints internally so the realness gate reaches both the rows and the
 * datasheet's reward distribution.
 */
export async function buildRlDataset(
  records: RunRecord[],
  lookups: GrpoLookups & SftLookups,
  config: RlDatasetConfig,
  preferences?: { triples: PreferenceTriple[]; lookups: DpoLookups },
): Promise<RlDatasetBundle>
export async function buildRlDataset(
  input: MintedRolloutLine[] | RunRecord[],
  lookups: (GrpoLineLookups & SftLineLookups) | (GrpoLookups & SftLookups),
  config: RlDatasetConfig,
  preferences?: { triples: PreferenceTriple[]; lookups: DpoLookups },
): Promise<RlDatasetBundle> {
  if (input.length === 0) {
    throw new Error('buildRlDataset: no records — refusing to package an empty dataset')
  }
  const formats = config.formats ?? ['grpo', 'sft']
  const files: Record<string, string> = {}
  const rowCounts: Partial<Record<DatasetFormat, number>> = {}

  const fromLines = isRolloutLineInput(input)
  // The datasheet describes the rows, so both are derived from lines. On the
  // deprecated path the exporters mint their own copy from the same records —
  // mint is a pure function of the record apart from `captured_at`, which the
  // stats do not read, so the two agree by construction. Minting the same
  // records more than once is the price of a SINGLE reward derivation; it is an
  // in-memory map with no I/O.
  const lines = fromLines ? input : (await mintLinesFromRecords(input)).map((m) => m.line)

  if (formats.includes('grpo')) {
    const rows = fromLines
      ? await toGrpoRows(input, lookups as GrpoLineLookups)
      : await toGrpoRows(input, lookups as GrpoLookups)
    files['train.grpo.jsonl'] = toGrpoJsonl(rows)
    rowCounts.grpo = rows.length
  }
  if (formats.includes('sft')) {
    const rows = fromLines
      ? await toSftRows(input, lookups as SftLineLookups)
      : await toSftRows(input, lookups as SftLookups)
    files['train.sft.jsonl'] = toSftJsonl(rows)
    rowCounts.sft = rows.length
  }
  if (formats.includes('dpo')) {
    if (!preferences) {
      throw new Error("buildRlDataset: format 'dpo' requires `preferences` (triples + lookups)")
    }
    // The bundle's own lines are the gate context. Without them this call
    // wrote `train.dpo.jsonl` with a gamed run on the CHOSEN side while the
    // datasheet beside it reported that same run at reward 0.
    const rows = await toDpoRows(preferences.triples, preferences.lookups, { lines })
    files['train.dpo.jsonl'] = toDpoJsonl(rows)
    rowCounts.dpo = rows.length
  }

  const manifest: RlDatasetManifest = {
    ...config,
    formats,
    rowCounts,
    stats: computeStats(lines),
  }
  files['manifest.json'] = `${JSON.stringify(manifest, null, 2)}\n`
  files['DATASHEET.md'] = datasheetToMarkdown(manifest)
  return { manifest, files }
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`
}

/** Render the "Datasheet for Datasets" card — the artifact a buyer reads. */
export function datasheetToMarkdown(m: RlDatasetManifest): string {
  const s = m.stats
  const total = s.records || 1
  const splitLines = (['search', 'dev', 'holdout'] as RunSplitTag[])
    .map((k) => `  - \`${k}\`: ${s.splits[k]} (${pct(s.splits[k] / total)})`)
    .join('\n')
  // Splits with no RunRecord equivalent would otherwise be invisible in the
  // table above even though they are counted in `records`.
  const extraSplitLines = (['canary', 'train'] as RolloutSplit[])
    .filter((k) => (s.rolloutSplits[k] ?? 0) > 0)
    .map((k) => `\n  - \`${k}\`: ${s.rolloutSplits[k]} (${pct((s.rolloutSplits[k] ?? 0) / total)})`)
    .join('')
  const costNote =
    s.rolloutsWithoutCost > 0
      ? ` (floor — ${s.rolloutsWithoutCost} rollout(s) never captured a cost)`
      : ''
  const deterministic = m.reward.kind === 'deterministic'
  return [
    `# Dataset: ${m.name} \`v${m.version}\``,
    '',
    `**Domain:** ${m.domain} · **Created:** ${m.createdAtIso} · **License:** ${m.license}`,
    '',
    '## Reward provenance',
    `- **Kind:** ${m.reward.kind}${deterministic ? ' ✅ (decidable — not judge-noise)' : ''}`,
    `- **Source:** ${m.reward.source}`,
    `- **Description:** ${m.reward.description}`,
    '',
    '## Composition',
    `- **Records (trajectories):** ${s.records}`,
    `- **Formats:** ${m.formats.map((f) => `${f} (${m.rowCounts[f] ?? 0} rows)`).join(', ')}`,
    '- **Splits:**',
    `${splitLines}${extraSplitLines}`,
    '',
    '## Reward distribution',
    `- n=${s.reward.n} · mean=${s.reward.mean.toFixed(3)} · median=${s.reward.median.toFixed(3)} · min=${s.reward.min.toFixed(3)} · max=${s.reward.max.toFixed(3)} · std=${s.reward.std.toFixed(3)}`,
    '',
    '## Provenance',
    `- **Models:** ${s.models.join(', ')}`,
    `- **Prompt/agent versions (sha256):** ${s.promptHashes.length} distinct`,
    `- **Commits:** ${s.commitShas.join(', ')}`,
    `- **Tokens:** ${s.totalTokens.input} in / ${s.totalTokens.output} out · **Cost:** $${s.totalCostUsd.toFixed(2)}${costNote}`,
    '',
    '## Quality gates',
    `- Contamination probe: ${m.qualityGates?.contaminationProbe ?? 'not-run'}`,
    `- Dedup: ${m.qualityGates?.dedup ? 'yes' : 'no'} · Verifiable-reward filter: ${m.qualityGates?.verifiableRewardFilter ? 'yes' : 'no'}`,
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
    'For RL/SFT training, tokenize with the per-model renderer (DeepSeek-V3 / Kimi-K2 / Qwen3) to preserve token identity and per-token loss masks across tool-call turns — see `renderers` (PrimeIntellect). The `messages` / `completions` here are the renderer input.',
    '',
  ].join('\n')
}
