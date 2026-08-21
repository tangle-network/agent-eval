/**
 * The evidence registry record — the canonical, machine-readable unit for a
 * measured claim about an agent, a prompt, a policy, or an instrument.
 *
 * One record answers, in typed fields, the questions a scattered results doc
 * leaves to prose: what was claimed, what instrument measured it, the exact
 * command that reproduces it, which arms ran, the denominator, what it cost,
 * what confounds the comparison, and how much trust the evidence has earned.
 *
 * Records live as JSON files in `evidence/records/` at the repo root — one
 * file per claim, filename `<id>.json`. The registry lives in agent-eval
 * because the measurement substrate owns evidence legitimacy; every other
 * repo keeps at most a pointer file. `scripts/render-evidence-index.ts`
 * generates the human index from these records, so prose can never drift
 * from data, and `pnpm run evidence:check` (part of `verify:package`) fails
 * on an invalid record or a stale index.
 *
 * The shape extends the `.evolve/experiments.jsonl` session-log vocabulary
 * (ts/hypothesis/change/result/evidence) into a curated registry record.
 * Session logs stay append-only diaries; a registry record is the durable,
 * addressable claim distilled from them.
 */

import { z } from 'zod'

/**
 * Trust ladder for a recorded claim, strongest first.
 *
 * - `CERTIFIED` — pre-registered rule, sealed or held-out data, and either a
 *   defended challenge or a check that re-runs in the suite.
 * - `MEASURED-ONCE` — one honest measurement on the real path, not replicated.
 * - `RESOLVED-NULL` — measured with an adequate instrument; the effect did not
 *   appear under the registered rule. A null is a result, not a failure.
 * - `UNVERIFIED` — stated somewhere load-bearing, but no independent check has
 *   run. Admitting this state is what keeps folklore out of the other four.
 * - `KILLED` — refuted, invalidated, or superseded by a stronger record.
 */
export const EVIDENCE_STATES = [
  'CERTIFIED',
  'MEASURED-ONCE',
  'RESOLVED-NULL',
  'UNVERIFIED',
  'KILLED',
] as const

export type EvidenceState = (typeof EVIDENCE_STATES)[number]

const idPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const datePattern = /^\d{4}-\d{2}-\d{2}$/
const sha256Pattern = /^[0-9a-f]{64}$/

/** Denominator of the measurement. A claim without an `n` is prose, not evidence. */
const evidenceDenominatorSchema = z.strictObject({
  value: z.number().positive().finite(),
  /** What one unit is: rows, cases, rollouts, records, leaves… */
  unit: z.string().min(1),
  /** Clustering, reps, split names — whatever the bare number hides. */
  detail: z.string().min(1).optional(),
})

export type EvidenceDenominator = z.infer<typeof evidenceDenominatorSchema>

export const evidenceRegistryRecordSchema = z.strictObject({
  /** Stable kebab-case identity; the registry filename is `<id>.json`. */
  id: z.string().regex(idPattern),
  /** Date the decisive measurement completed, `YYYY-MM-DD`. */
  date: z.string().regex(datePattern),
  /** The one-sentence load-bearing claim, stated so it can fail. */
  claim: z.string().min(1),
  /** Domain the claim lives in: trace-repair, multishot, analyst, vertical-bench… */
  domain: z.string().min(1),
  /** The instrument that produced the number — script, harness, oracle, judge. */
  instrument: z.string().min(1),
  /**
   * The exact invocation that reproduces the measurement.
   * `null` means the invocation was not preserved — a named gap, never a guess.
   */
  command: z.string().min(1).nullable(),
  /** Compared arms. Empty for a single-arm measurement. */
  arms: z.array(z.string().min(1)),
  n: evidenceDenominatorSchema,
  /** The measured numbers, with uncertainty when it exists. Numbers, not adjectives. */
  result: z.string().min(1),
  evidenceState: z.enum(EVIDENCE_STATES),
  /** Where the raw data lives: repo paths, PR/gist URLs, run directories. Never empty. */
  artifacts: z.array(z.string().min(1)).min(1),
  /**
   * Measured spend in USD. `0` is a true zero (deterministic, no paid calls);
   * `null` means spend was not captured — a named gap, never a silent zero.
   */
  costUsd: z.number().nonnegative().nullable(),
  /** Every known asymmetry or threat to validity. Empty only when none is known. */
  confounds: z.array(z.string().min(1)),
  /** Repo whose work produced the evidence (the registry itself lives here). */
  sourceRepo: z.string().min(1),
  /** Seal digest of the registered experiment (`./experiment`), when one governed the run. */
  experimentDigest: z.string().regex(sha256Pattern).optional(),
  /** Ids of records this one supersedes. */
  supersedes: z.array(z.string().regex(idPattern)).optional(),
  notes: z.string().min(1).optional(),
})

export type EvidenceRegistryRecord = z.infer<typeof evidenceRegistryRecordSchema>

/** Parse one record; throws with the zod issue list on any violation. */
export function parseEvidenceRegistryRecord(raw: unknown): EvidenceRegistryRecord {
  return evidenceRegistryRecordSchema.parse(raw)
}

class EvidenceRegistryError extends Error {}

/**
 * Validate a set of records as one registry: every record parses, ids are
 * unique, and every `supersedes` target exists. Returns records sorted in
 * the registry's canonical order (trust ladder, then date desc, then id).
 */
export function validateEvidenceRegistry(raws: readonly unknown[]): EvidenceRegistryRecord[] {
  const records = raws.map((raw) => parseEvidenceRegistryRecord(raw))
  const seen = new Set<string>()
  for (const record of records) {
    if (seen.has(record.id)) {
      throw new EvidenceRegistryError(`duplicate evidence record id: ${record.id}`)
    }
    seen.add(record.id)
  }
  for (const record of records) {
    for (const target of record.supersedes ?? []) {
      if (!seen.has(target)) {
        throw new EvidenceRegistryError(`record ${record.id} supersedes unknown record: ${target}`)
      }
    }
  }
  const stateRank = new Map(EVIDENCE_STATES.map((state, index) => [state, index]))
  return [...records].sort((a, b) => {
    const byState = (stateRank.get(a.evidenceState) ?? 0) - (stateRank.get(b.evidenceState) ?? 0)
    if (byState !== 0) return byState
    if (a.date !== b.date) return a.date < b.date ? 1 : -1
    return a.id < b.id ? -1 : 1
  })
}

function mdEscape(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\n/g, ' ')
}

function formatCost(costUsd: number | null): string {
  if (costUsd === null) return 'not captured'
  return `$${costUsd.toFixed(2)}`
}

function formatN(n: EvidenceDenominator): string {
  const base = `${n.value} ${n.unit}`
  return n.detail ? `${base} (${n.detail})` : base
}

/**
 * Render the registry's human index from records. Deterministic: identical
 * records always produce identical output, so a byte diff against the
 * committed index is the freshness check. No clocks, no environment.
 */
export function renderEvidenceIndex(raws: readonly unknown[]): string {
  const records = validateEvidenceRegistry(raws)
  const lines: string[] = [
    '# Evidence index',
    '',
    '<!-- GENERATED by scripts/render-evidence-index.ts from evidence/records/*.json.',
    '     Edit the records, run `pnpm run evidence:render`, and commit both.',
    '     `pnpm run evidence:check` (inside verify:package) fails when this file drifts. -->',
    '',
    `${records.length} records. States: ${EVIDENCE_STATES.join(' > ')}.`,
    '',
    '| state | date | id | claim | result |',
    '| --- | --- | --- | --- | --- |',
  ]
  for (const r of records) {
    lines.push(
      `| ${r.evidenceState} | ${r.date} | [\`${r.id}\`](#${r.id}) | ${mdEscape(r.claim)} | ${mdEscape(r.result)} |`,
    )
  }
  for (const r of records) {
    lines.push('', `## ${r.id}`, '')
    lines.push(`**${r.evidenceState}** · ${r.date} · ${r.domain} · source repo \`${r.sourceRepo}\``)
    lines.push('', `**Claim.** ${r.claim}`, '', `**Result.** ${r.result}`, '')
    lines.push(`- **Instrument**: ${r.instrument}`)
    lines.push(`- **Command**: ${r.command === null ? 'not preserved' : `\`${r.command}\``}`)
    lines.push(`- **Arms**: ${r.arms.length === 0 ? 'single-arm' : r.arms.join(' vs ')}`)
    lines.push(`- **n**: ${formatN(r.n)}`)
    lines.push(`- **Cost**: ${formatCost(r.costUsd)}`)
    if (r.experimentDigest) lines.push(`- **Experiment seal**: \`${r.experimentDigest}\``)
    lines.push(`- **Artifacts**:`)
    for (const artifact of r.artifacts) lines.push(`  - ${artifact}`)
    if (r.confounds.length === 0) {
      lines.push('- **Confounds**: none recorded')
    } else {
      lines.push('- **Confounds**:')
      for (const confound of r.confounds) lines.push(`  - ${confound}`)
    }
    if (r.supersedes && r.supersedes.length > 0) {
      lines.push(`- **Supersedes**: ${r.supersedes.map((s) => `\`${s}\``).join(', ')}`)
    }
    if (r.notes) lines.push(`- **Notes**: ${r.notes}`)
  }
  lines.push('')
  return lines.join('\n')
}
