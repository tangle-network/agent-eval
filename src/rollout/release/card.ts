/**
 * HuggingFace dataset-card (README.md) generation for a rollout-ledger release.
 *
 * The card is a pure function of the SCRUBBED lines plus the release options —
 * no timestamps, no environment reads — so rebuilding from the same ledger
 * yields byte-identical output. It documents the schema, provenance (run ids,
 * generations, the official judge), per-role reward semantics including the
 * inherited/contribution caveat, and a role × reward counts table.
 */

import { type MintedRolloutLine, ROLLOUT_ROLES, ROLLOUT_SCHEMA, type RolloutRole } from '../schema'
import { assertGateReport, FORMAT_GATE_DISPOSITION, type GateReport } from './gate-report'
import type { ScrubCounts } from './scrub'

export const RELEASE_FORMATS = ['sft', 'verifiers', 'rft', 'raw'] as const
export type ReleaseFormat = (typeof RELEASE_FORMATS)[number]

/** Format → data file path inside the dataset dir (train split only). */
export const FORMAT_FILES: Record<ReleaseFormat, string> = {
  sft: 'sft/train.jsonl',
  verifiers: 'verifiers/train.jsonl',
  rft: 'rft/train.jsonl',
  raw: 'raw/train.jsonl',
}

const FORMAT_DESCRIPTIONS: Record<ReleaseFormat, string> = {
  sft: 'Successful trainable-split transcripts (`reward >= 1`, never realness-gated) as `{messages, metadata}` chat JSONL.',
  verifiers:
    'Prime Intellect verifiers `RolloutOutput`: prompt/completion split at the first assistant turn, plus reward, metrics, tool defs, and token usage.',
  rft: 'OpenAI RFT items: prompt turns plus `reference.*` verdict fields for a grader (completions are re-sampled during RFT).',
  raw: `Full \`${ROLLOUT_SCHEMA}\` ledger lines (scrubbed), one per agent invocation.`,
}

export interface DatasetCardInputs {
  /** Scrubbed, release-filtered lines (what actually ships). */
  lines: MintedRolloutLine[]
  formats: ReleaseFormat[]
  includeProposers: boolean
  /** Source ledger basenames, for provenance. */
  sourceFiles: string[]
  scrubTotals: ScrubCounts
  excluded: { proposers: number; nonTrain: number }
  formatCounts: Partial<Record<ReleaseFormat, number>>
  /**
   * Per-format anti-Goodhart accounting MEASURED on the rows the build wrote.
   * Required, not optional: the card's only statement about the gate is a
   * render of these numbers, so a card cannot be produced without them and
   * cannot drift from the data files it ships beside.
   */
  gate: GateReport
}

function unique(values: Array<string | null>): string[] {
  return [...new Set(values.filter((v): v is string => v !== null))].sort()
}

function formatReward(reward: number | null): string {
  if (reward === null) return 'null'
  return Number.isInteger(reward) ? String(reward) : reward.toFixed(4)
}

function markdownTable(header: string[], rows: string[][]): string {
  return [
    `| ${header.join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.join(' | ')} |`),
  ].join('\n')
}

/** Where the anti-Goodhart flag lives on each format's emitted row. */
const GATE_FLAG_FIELD: Record<ReleaseFormat, string> = {
  sft: '— (no gated row is written)',
  verifiers: '`info.realness_gated`',
  rft: '`reference.realness_gated`',
  raw: '`outcome.realness_gated`',
}

const GATE_POLICY_LABEL: Record<ReleaseFormat, string> = {
  sft: 'EXCLUDED — an SFT row is an imitation target',
  verifiers: 'INCLUDED, reward forced to 0, flagged',
  rft: 'INCLUDED, reward forced to 0, flagged',
  raw: 'INCLUDED verbatim, flagged',
}

function gateSection(formats: ReleaseFormat[], gate: GateReport, totalLines: number): string {
  const rows = formats.map((format) => {
    const counts = gate.byFormat[format]
    return [
      format,
      GATE_POLICY_LABEL[format],
      String(counts?.emitted ?? 0),
      String(counts?.excluded ?? 0),
      counts?.maxEmittedReward === null || counts === undefined
        ? '—'
        : formatReward(counts.maxEmittedReward),
      GATE_FLAG_FIELD[format],
    ]
  })
  const mixedExclusion = formats.some(
    (format) => FORMAT_GATE_DISPOSITION[format] === 'zero-and-flag',
  )
  return [
    `\`outcome.realness_gated: true\` marks a run whose success signal was faked (it satisfied the proxy without doing the work). **${gate.gatedLines} of ${totalLines} lines in this release are gated.**`,
    '',
    'The gate is enforced, not asserted. A line pairing `realness_gated: true` with a reward above 0 is rejected by the schema validator, so it cannot be read out of a source ledger or written into `raw/train.jsonl` at all; the exporters re-check the same invariant on every line; and the release build measures the rows it is about to write and refuses to write ANY file if a gated row carries a positive reward in ANY config.',
    '',
    'The table below is **measured on the rows in this release**, not a description of intent — the build counts the emitted rows and this card renders those counts:',
    '',
    markdownTable(
      ['config', 'policy', 'gated rows written', 'gated rows not written', 'max reward', 'flag'],
      rows,
    ),
    '',
    'Why gated rows are kept where they are kept: an SFT row is imitated verbatim, so a gamed trajectory must never appear in one at any weight. In `verifiers` the reward is a signed learning signal, and a gamed trajectory at reward 0 is a correct negative — dropping it would bias the negative population toward honest failures and leave a trainer no example of gaming being penalized. `rft` re-samples the completion, so only the prompt and the grader reference ship. `raw` is a faithful audit dump, where the gated row is the one an auditor most wants.',
    '',
    'Reward 0 is never the only label: every included config carries the flag on the row itself, because zeroing alone makes a faked success indistinguishable from an honest failure. Filter on the flag to drop the gamed population, or select on it to mine it.',
    mixedExclusion
      ? '\n"Gated rows not written" is not all gate: `verifiers` also drops gap lines (empty transcript) and `rft` drops lines with no prompt turn, so that column can mix both causes.'
      : '',
  ]
    .join('\n')
    .trimEnd()
}

function roleRewardRows(lines: MintedRolloutLine[]): string[][] {
  const counts = new Map<RolloutRole, Map<string, number>>()
  for (const line of lines) {
    const byReward = counts.get(line.role) ?? new Map<string, number>()
    const key = formatReward(line.outcome.reward)
    byReward.set(key, (byReward.get(key) ?? 0) + 1)
    counts.set(line.role, byReward)
  }
  const rows: string[][] = []
  for (const role of ROLLOUT_ROLES) {
    const byReward = counts.get(role)
    if (!byReward) continue
    const keys = [...byReward.keys()].sort((a, b) => {
      if (a === 'null') return 1
      if (b === 'null') return -1
      return Number(b) - Number(a)
    })
    for (const key of keys) rows.push([role, key, String(byReward.get(key))])
  }
  return rows
}

export function buildDatasetCard(inputs: DatasetCardInputs): string {
  const {
    lines,
    formats,
    includeProposers,
    sourceFiles,
    scrubTotals,
    excluded,
    formatCounts,
    gate,
  } = inputs
  // The card is the artifact a buyer reads; it may not render a gate report
  // that violates the release policy even when called outside the build.
  assertGateReport(gate)

  const runIds = unique(lines.map((line) => line.run_id))
  const generations = [...new Set(lines.map((line) => line.generation))]
    .filter((g): g is number => g !== null)
    .sort((a, b) => a - b)
  const models = unique(lines.map((line) => line.policy.model))
  const harnesses = unique(lines.map((line) => line.policy.harness))
  const captures = unique(lines.map((line) => line.provenance.capture))
  const rewardSources = unique(lines.map((line) => line.outcome.reward_source))
  const gapLines = lines.filter((line) => line.messages.length === 0).length
  const gatedLines = lines.filter((line) => line.outcome.realness_gated).length
  if (gatedLines !== gate.gatedLines) {
    throw new Error(
      `dataset card: gate report claims ${gate.gatedLines} realness-gated line(s) but the lines ` +
        `it describes contain ${gatedLines} — the card and the build measured different data.`,
    )
  }

  const configs = formats
    .map((format) =>
      [
        `  - config_name: ${format}`,
        '    data_files:',
        '      - split: train',
        `        path: ${FORMAT_FILES[format]}`,
      ].join('\n'),
    )
    .join('\n')

  const frontmatter = [
    '---',
    'license: unknown',
    'pretty_name: Tangle rollout ledger — agent trajectories',
    'configs:',
    configs,
    '---',
  ].join('\n')

  const formatsTable = markdownTable(
    ['config', 'path', 'rows', 'contents'],
    formats.map((format) => [
      format,
      `\`${FORMAT_FILES[format]}\``,
      String(formatCounts[format] ?? 0),
      FORMAT_DESCRIPTIONS[format],
    ]),
  )

  const countsTable = markdownTable(['role', 'reward', 'lines'], roleRewardRows(lines))

  const scrubTable = markdownTable(
    ['rule', 'rewrites'],
    Object.entries(scrubTotals).map(([rule, count]) => [rule, String(count)]),
  )

  const proposerNote = includeProposers
    ? 'Proposer sessions are INCLUDED (`--include-proposers`); their transcripts contain improvement-loop harness source.'
    : `Proposer sessions are excluded by default (${excluded.proposers} lines dropped); they contain improvement-loop harness source. Rebuild with \`--include-proposers\` to keep them.`

  return `${frontmatter}

# Tangle rollout ledger — agent trajectories

One line per agent invocation (supervisor episode, worker session, proposer shot, judge call, analyst pass) captured by the \`${ROLLOUT_SCHEMA}\` rollout ledger, labeled with improvement-loop coordinates and the official-judge reward, with the full message transcript inline.

This release contains the **trainable split only** (\`search\`, plus the legacy \`train\` alias). Holdout, dev, and canary splits are structurally excluded at build time (never exported), and the build additionally drops any non-trainable line as a fail-closed filter (${excluded.nonTrain} dropped here).

## Formats

${formatsTable}

## Anti-Goodhart gate (\`realness_gated\`)

${gateSection(formats, gate, lines.length)}

## Schema (\`${ROLLOUT_SCHEMA}\`)

Each raw line carries:

- \`rollout_id\` / \`parent_rollout_id\` — invocation identity; workers point at their spawning supervisor episode.
- \`run_id\`, \`experiment_id\`, \`candidate_id\` — run/experiment/candidate identity from the producing RunRecord, when present.
- \`generation\`, \`candidate_index\` — improvement-loop coordinates (\`-1\` = baseline campaign; \`null\` = not an improvement loop).
- \`role\` — one of ${ROLLOUT_ROLES.map((role) => `\`${role}\``).join(', ')}.
- \`task\` — suite, instance id, split, seed, replicate index.
- \`policy\` — harness, model, provider, profile commit, prompt/config hashes, sampling params.
- \`messages\` / \`tool_defs\` — full transcript in canonical OpenAI chat-with-tools form (including \`reasoning_content\`). An empty \`messages\` array is a labeled gap line; \`provenance.gap\` says why the transcript could not be recovered (${gapLines} gap lines in this release).
- \`outcome\` — \`reward\` (the single scalar), \`reward_source\`, the verbatim judge \`verdict\`, non-scalar \`metrics\`, and \`realness_gated\` (anti-Goodhart flag; see [Anti-Goodhart gate](#anti-goodhart-gate-realness_gated) for the per-config treatment and the measured counts).
- \`cost\` — usd, token counts, wall time.
- \`artifacts\` / \`provenance\` — patch/run-dir/transcript pointers (scrubbed) and capture metadata.

## Provenance

- Source ledgers: ${sourceFiles.map((file) => `\`${file}\``).join(', ')}
- Run ids: ${runIds.map((id) => `\`${id}\``).join(', ')}
- Generations: ${generations.join(', ')} (\`-1\` = baseline campaign)
- Models: ${models.map((m) => `\`${m}\``).join(', ')}
- Harnesses: ${harnesses.map((h) => `\`${h}\``).join(', ')}
- Capture modes: ${captures.join(', ')}
- Every reward traces to a named source (reward sources in this release: ${rewardSources.map((s) => `\`${s}\``).join(', ')}).

${proposerNote}

## Reward semantics per role

- **agent** — the producing RunRecord's holdout/search score, with the realness gate forcing gamed successes to 0.
- **supervisor** — the official-judge verdict on the episode's delivered artifact (1 = resolved, 0 = not).
- **worker** — INHERITED from the parent supervisor episode (\`…/inherited\`). Caveat: reward 1 does not establish this worker's individual contribution (sibling workers in the same episode share the episode outcome), and reward 0 does not prove this worker failed.
- **proposer** — the fraction of improvement-set instances the proposed candidate resolved (\`…/candidate-resolved-fraction\`); a scalar in [0, 1], not a binary verdict.
- **judge / analyst** — carry the episode verdict where one applies; otherwise \`reward: null\` (a labeled gap, never 0).

## Counts

${countsTable}

Total lines: ${lines.length}

## Scrubbing

Absolute home paths were rewritten to \`$WORK\`, credential-shaped strings were replaced with \`[REDACTED:<kind>]\` markers, internal hostnames were normalized to \`*.internal.example\`, and username-bearing incidentals (\`ls -l\` owner columns, per-user pytest tmpdirs) were normalized to \`user\` / \`$USER\`. Rewrite counts for this release (full per-file breakdown in \`scrub-report.json\`):

${scrubTable}

## License

\`license: unknown\` is a placeholder — the releasing operator must set the real SPDX license id in the frontmatter above before publishing.

## Citation

\`\`\`bibtex
@misc{tangle_rollout_ledger,
  title = {Tangle rollout ledger — agent trajectories},
  author = {{Tangle Network}},
  howpublished = {HuggingFace Datasets},
  note = {Operator: fill in the repository URL, authors, and year before publishing}
}
\`\`\`
`
}
