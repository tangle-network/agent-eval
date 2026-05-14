/**
 * Anti-slop quality judge.
 *
 * Deterministic pattern-based quality check — no LLM call. Catches the
 * 80% of AI slop that every production agent leaks:
 *   - Banned phrases (voice-specific: "delve", "it's worth noting", etc.)
 *   - N-gram repetition (same phrase over and over)
 *   - Hedging overuse ("I could be wrong, but...")
 *   - Apology padding ("I'm so sorry for the confusion...")
 *   - Unused opening formulas ("Great question!")
 *   - Length bounds (too short to be useful, too long to be read)
 *
 * Produces a JudgeScore in the same shape as LLM judges so it composes into
 * `BenchmarkRunner`'s judge array transparently.
 */

import type { JudgeFn, JudgeInput, JudgeScore } from './types'

export interface AntiSlopConfig {
  /** Domain label — appears in the JudgeScore output */
  domain?: string

  /** Case-insensitive substrings that must not appear. Each occurrence = penalty. */
  bannedPhrases?: string[]

  /** Regexes matching opening formulas to penalize (e.g. /^great question/i). */
  bannedOpenings?: RegExp[]

  /** Regexes matching hedges (e.g. /i could be wrong/i). Ratio of hedged sentences drives score. */
  hedgingPatterns?: RegExp[]

  /** Regexes matching apology padding. */
  apologyPatterns?: RegExp[]

  /** Fraction of sentences that can be duplicates before penalty (default 0.15 = 15%). */
  repetitionThreshold?: number

  /** Min output length in chars; below this the turn is deemed too terse. */
  minLength?: number

  /** Max output length in chars; above this the turn is deemed too verbose. */
  maxLength?: number

  /** How heavily each violation class reduces the score (default 1). */
  penaltyWeights?: Partial<Record<SlopCategory, number>>
}

export type SlopCategory =
  | 'banned_phrase'
  | 'banned_opening'
  | 'hedging'
  | 'apology'
  | 'repetition'
  | 'length'

const DEFAULT_HEDGES: RegExp[] = [
  /\bi\s+could\s+be\s+wrong\b/i,
  /\bi\s+think\s+maybe\b/i,
  /\bit\s+might\s+be\s+that\b/i,
  /\bperhaps\s+(?:you\s+)?could\b/i,
]

const DEFAULT_APOLOGIES: RegExp[] = [
  /\bi\s+(?:apologize|apologise)\s+(?:for|if)\b/i,
  /\bi'?m\s+(?:so\s+|really\s+)?sorry\s+(?:for|if|about)\b/i,
  /\bmy\s+apologies\b/i,
]

/** Create a reusable Judge function from an anti-slop config. */
export function createAntiSlopJudge(config: AntiSlopConfig = {}): JudgeFn {
  const conf: Required<Omit<AntiSlopConfig, 'penaltyWeights'>> & {
    penaltyWeights: Record<SlopCategory, number>
  } = {
    domain: config.domain ?? 'general',
    bannedPhrases: config.bannedPhrases ?? [],
    bannedOpenings: config.bannedOpenings ?? [],
    hedgingPatterns: config.hedgingPatterns ?? DEFAULT_HEDGES,
    apologyPatterns: config.apologyPatterns ?? DEFAULT_APOLOGIES,
    repetitionThreshold: config.repetitionThreshold ?? 0.15,
    minLength: config.minLength ?? 20,
    maxLength: config.maxLength ?? 8000,
    penaltyWeights: {
      banned_phrase: 1,
      banned_opening: 1,
      hedging: 0.5,
      apology: 0.5,
      repetition: 0.75,
      length: 0.5,
      ...config.penaltyWeights,
    },
  }

  const judge: JudgeFn = async (_tc, input: JudgeInput): Promise<JudgeScore[]> => {
    const outputs = input.turns.map((t) => t.agentResponse ?? '')
    const report = analyzeAntiSlop(outputs, conf)
    return [
      {
        judgeName: `anti-slop(${conf.domain})`,
        dimension: 'anti_slop',
        score: report.score,
        reasoning: report.issues.length
          ? report.issues
              .slice(0, 5)
              .map((i) => `${i.category}: ${i.detail}`)
              .join('; ')
          : 'No slop patterns detected.',
        evidence: report.issues[0]?.example,
      },
    ]
  }
  return judge
}

export interface AntiSlopIssue {
  category: SlopCategory
  detail: string
  example?: string
}

export interface AntiSlopReport {
  /** 0–10 score; 10 is clean, lower values mean more slop. */
  score: number
  issues: AntiSlopIssue[]
  /** Count of each category for programmatic aggregation. */
  counts: Record<SlopCategory, number>
}

/**
 * Pure function — analyze one or more outputs against the config. Exposed
 * separately so consumers can build their own reporters on top.
 */
export function analyzeAntiSlop(
  outputs: string[],
  config: Omit<Required<AntiSlopConfig>, 'domain'> & {
    penaltyWeights: Record<SlopCategory, number>
  },
): AntiSlopReport {
  const issues: AntiSlopIssue[] = []
  const counts: Record<SlopCategory, number> = {
    banned_phrase: 0,
    banned_opening: 0,
    hedging: 0,
    apology: 0,
    repetition: 0,
    length: 0,
  }

  for (const output of outputs) {
    if (!output) continue
    const lower = output.toLowerCase()

    for (const phrase of config.bannedPhrases) {
      const needle = phrase.toLowerCase()
      let idx = 0
      while ((idx = lower.indexOf(needle, idx)) !== -1) {
        counts.banned_phrase += 1
        if (issues.length < 20) {
          issues.push({
            category: 'banned_phrase',
            detail: `"${phrase}"`,
            example: snippet(output, idx, phrase.length),
          })
        }
        idx += needle.length
      }
    }

    for (const re of config.bannedOpenings) {
      if (re.test(output)) {
        counts.banned_opening += 1
        issues.push({ category: 'banned_opening', detail: re.source, example: output.slice(0, 80) })
      }
    }

    for (const re of config.hedgingPatterns) {
      const matches = output.match(
        new RegExp(re, re.flags.includes('g') ? re.flags : `${re.flags}g`),
      )
      if (matches) {
        counts.hedging += matches.length
        issues.push({
          category: 'hedging',
          detail: `${matches.length}x ${re.source}`,
          example: matches[0],
        })
      }
    }

    for (const re of config.apologyPatterns) {
      const matches = output.match(
        new RegExp(re, re.flags.includes('g') ? re.flags : `${re.flags}g`),
      )
      if (matches) {
        counts.apology += matches.length
        issues.push({
          category: 'apology',
          detail: `${matches.length}x ${re.source}`,
          example: matches[0],
        })
      }
    }

    // Repetition: compare sentence-level dupes
    const sentences = splitSentences(output)
    if (sentences.length >= 4) {
      const seen = new Map<string, number>()
      for (const s of sentences) {
        const key = normalizeForDupe(s)
        if (!key) continue
        seen.set(key, (seen.get(key) ?? 0) + 1)
      }
      let dupes = 0
      for (const n of seen.values()) if (n > 1) dupes += n - 1
      const ratio = dupes / sentences.length
      if (ratio > config.repetitionThreshold) {
        counts.repetition += 1
        issues.push({
          category: 'repetition',
          detail: `${(ratio * 100).toFixed(0)}% duplicated (threshold ${(config.repetitionThreshold * 100).toFixed(0)}%)`,
        })
      }
    }

    // Length
    if (output.length < config.minLength) {
      counts.length += 1
      issues.push({
        category: 'length',
        detail: `too short (${output.length} < ${config.minLength})`,
      })
    } else if (output.length > config.maxLength) {
      counts.length += 1
      issues.push({
        category: 'length',
        detail: `too long (${output.length} > ${config.maxLength})`,
      })
    }
  }

  // Score: 10 minus weighted violations, clamped. Each violation of category c
  // subtracts `penaltyWeights[c]` points. Violations beyond 10/weight saturate.
  let penalty = 0
  for (const cat of Object.keys(counts) as SlopCategory[]) {
    penalty += counts[cat] * (config.penaltyWeights[cat] ?? 1)
  }
  const score = Math.max(0, Math.min(10, 10 - penalty))

  return { score, issues, counts }
}

function snippet(source: string, at: number, len: number): string {
  const pad = 24
  const start = Math.max(0, at - pad)
  const end = Math.min(source.length, at + len + pad)
  return (start > 0 ? '…' : '') + source.slice(start, end) + (end < source.length ? '…' : '')
}

function splitSentences(text: string): string[] {
  // Simple sentence split — good enough for slop detection; not linguistically perfect.
  return text
    .split(/[.!?\n]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

function normalizeForDupe(s: string): string {
  return s
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^a-z0-9 ]/g, '')
    .trim()
}
