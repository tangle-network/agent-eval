/**
 * Shared canonical task for the substrate empirical-proof examples — ONE copy
 * of the transaction-extraction corpus + deterministic judge + real worker, so
 * `substrate-lift-proof` (single-proposer lift) and `compare-proposers-canonical`
 * (head-to-head proposer lift) measure the SAME thing and cannot drift apart.
 *
 * Task: structured field extraction. Each scenario is a short transaction
 * sentence; the worker emits `{merchant, amount, date, category}`. A
 * DETERMINISTIC checker scores per-field exact-match → composite in [0,1] — no
 * LLM judge, no variance, so a real prompt improvement moves the number and
 * nothing else can. The baseline prompt is deliberately weak (under-specified
 * format) so the search split scores low and a proposer has real failures to
 * reflect on.
 */

import { createHash } from 'node:crypto'
import type { DispatchContext, JudgeConfig, JudgeScore, Scenario } from '../../src/campaign'
import { callLlm, type LlmClientOptions } from '../../src/llm-client'
import type { RunRecord } from '../../src/run-record'

export interface ExtractScenario extends Scenario {
  text: string
  gold: { merchant: string; amount: string; date: string; category: string }
}

export interface Artifact {
  text: string
  parsed: Record<string, unknown> | null
}

export const CATEGORIES = [
  'groceries',
  'dining',
  'transport',
  'utilities',
  'entertainment',
] as const

function sc(
  id: string,
  text: string,
  gold: ExtractScenario['gold'],
  tag: 'search' | 'holdout',
): ExtractScenario {
  return { id, kind: 'extraction', tags: [tag], text, gold }
}

export const SEARCH: ExtractScenario[] = [
  sc(
    's1',
    'On March 3rd 2024 I spent $42.50 at Whole Foods Market on weekly groceries.',
    { merchant: 'Whole Foods Market', amount: '42.50', date: '2024-03-03', category: 'groceries' },
    'search',
  ),
  sc(
    's2',
    'Paid Uber $18.20 for a ride downtown on Jan 7, 2024.',
    { merchant: 'Uber', amount: '18.20', date: '2024-01-07', category: 'transport' },
    'search',
  ),
  sc(
    's3',
    'Dinner at Olive Garden cost 67 dollars on 2024-02-14.',
    { merchant: 'Olive Garden', amount: '67', date: '2024-02-14', category: 'dining' },
    'search',
  ),
  sc(
    's4',
    'My electric bill from ConEdison was $130.99, billed on 12/01/2023.',
    { merchant: 'ConEdison', amount: '130.99', date: '2023-12-01', category: 'utilities' },
    'search',
  ),
  sc(
    's5',
    'Bought movie tickets at AMC Theatres for $24 on the 5th of April 2024.',
    { merchant: 'AMC Theatres', amount: '24', date: '2024-04-05', category: 'entertainment' },
    'search',
  ),
  sc(
    's6',
    "Trader Joe's receipt: $55.10, dated Feb 28 2024, mostly produce.",
    { merchant: "Trader Joe's", amount: '55.10', date: '2024-02-28', category: 'groceries' },
    'search',
  ),
  sc(
    's7',
    'Lyft charged me 9.75 on 2024-03-19 for an airport drop-off.',
    { merchant: 'Lyft', amount: '9.75', date: '2024-03-19', category: 'transport' },
    'search',
  ),
  sc(
    's8',
    'Netflix monthly subscription of $15.49 hit my card on January 22 2024.',
    { merchant: 'Netflix', amount: '15.49', date: '2024-01-22', category: 'entertainment' },
    'search',
  ),
]

export const HOLDOUT: ExtractScenario[] = [
  sc(
    'h1',
    'Spent $88.00 at Costco Wholesale on 2024-05-02 stocking up on groceries.',
    { merchant: 'Costco Wholesale', amount: '88.00', date: '2024-05-02', category: 'groceries' },
    'holdout',
  ),
  sc(
    'h2',
    'Chipotle lunch was 12.40 dollars on May 9th, 2024.',
    { merchant: 'Chipotle', amount: '12.40', date: '2024-05-09', category: 'dining' },
    'holdout',
  ),
  sc(
    'h3',
    'Water utility payment to City Water Dept: $44.20 on 04/15/2024.',
    { merchant: 'City Water Dept', amount: '44.20', date: '2024-04-15', category: 'utilities' },
    'holdout',
  ),
  sc(
    'h4',
    'Took a taxi with Yellow Cab for $21.00 on the 11th of June 2024.',
    { merchant: 'Yellow Cab', amount: '21.00', date: '2024-06-11', category: 'transport' },
    'holdout',
  ),
  sc(
    'h5',
    'Spotify Premium billed 10.99 on 2024-05-30.',
    { merchant: 'Spotify', amount: '10.99', date: '2024-05-30', category: 'entertainment' },
    'holdout',
  ),
  sc(
    'h6',
    'Dinner at The Cheesecake Factory: $54.75, dated June 1 2024.',
    { merchant: 'The Cheesecake Factory', amount: '54.75', date: '2024-06-01', category: 'dining' },
    'holdout',
  ),
]

/** The deliberately WEAK baseline: no schema, no field names, no date format,
 *  no taxonomy — so the exact-match checker penalizes the model's drift and a
 *  proposer has real room to improve. */
export const BASELINE_SURFACE = 'Extract the transaction info from the message as JSON.'

export const PROPOSER_TARGET =
  'a system prompt that makes the model extract transaction fields into strict JSON with keys ' +
  'merchant, amount, date, category — amount as a bare number, date as ISO YYYY-MM-DD, ' +
  `category from {${CATEGORIES.join(', ')}}`

export const MUTATION_PRIMITIVES = [
  'specify the exact JSON keys the output must contain',
  'pin the date format to ISO YYYY-MM-DD',
  'pin amount to a bare decimal number with no currency symbol',
  `constrain category to the fixed taxonomy: ${CATEGORIES.join(', ')}`,
]

function norm(s: unknown): string {
  return String(s ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
}
function normAmount(s: unknown): string {
  const m = /-?\d+(\.\d+)?/.exec(String(s ?? ''))
  if (!m) return ''
  const n = Number(m[0])
  return Number.isFinite(n) ? String(n) : ''
}

/** Composite = fraction of the 4 fields that exactly match gold after light
 *  normalization. Objective, deterministic — no LLM. */
export function extractionJudge(
  dataset: ExtractScenario[],
): JudgeConfig<Artifact, ExtractScenario> {
  const byId = new Map(dataset.map((s) => [s.id, s]))
  return {
    name: 'field-exact-match',
    dimensions: [
      { key: 'merchant', description: 'merchant name exact match' },
      { key: 'amount', description: 'amount numeric match' },
      { key: 'date', description: 'date ISO YYYY-MM-DD match' },
      { key: 'category', description: 'category taxonomy match' },
    ],
    score({ artifact, scenario }): JudgeScore {
      const gold = (byId.get(scenario.id) ?? scenario).gold
      const p = artifact.parsed ?? {}
      const dims = {
        merchant: norm(p.merchant) === norm(gold.merchant) ? 1 : 0,
        amount: normAmount(p.amount) === normAmount(gold.amount) ? 1 : 0,
        date: norm(p.date) === norm(gold.date) ? 1 : 0,
        category: norm(p.category) === norm(gold.category) ? 1 : 0,
      }
      const composite = (dims.merchant + dims.amount + dims.date + dims.category) / 4
      return {
        dimensions: dims,
        composite,
        notes: artifact.parsed ? 'parsed' : `unparseable: ${artifact.text.slice(0, 80)}`,
      }
    },
  }
}

/** Tolerant JSON extraction: strip a ```json fence if present, else grab the
 *  first balanced object. The field-level checker still penalizes wrong keys /
 *  casing / formats, so this loosening does not inflate the score — it only
 *  stops a uniform parse failure from collapsing the gradient a proposer reflects
 *  on. */
export function parseJsonLoose(raw: string): Record<string, unknown> | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(raw)
  const candidate = fenced ? fenced[1]! : raw
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  const slice = start >= 0 && end > start ? candidate.slice(start, end + 1) : candidate
  try {
    const json = JSON.parse(slice)
    return json && typeof json === 'object' ? (json as Record<string, unknown>) : null
  } catch {
    return null
  }
}

export interface ExtractionWorkerOptions {
  llm: LlmClientOptions
  model: string
  /** Per-call RunRecords sink — feeds `assertRealBackend` at the end. */
  records: RunRecord[]
  /** Token rates for an honest $cost on the chosen provider. */
  priceInPerMTokens: number
  priceOutPerMTokens: number
  timeoutMs?: number
  experimentId?: string
}

/** Build the real worker: runs the extraction with a given prompt surface,
 *  reports BOTH cost and token usage to the cell meter, and appends a
 *  `RunRecord` so the run's backend integrity is verdictable. Returns a
 *  `dispatchWithSurface` usable by every preset (runImprovementLoop,
 *  runSkillOpt, compareProposers). */
export function makeExtractionWorker(opts: ExtractionWorkerOptions) {
  const timeoutMs = opts.timeoutMs ?? 30_000
  const experimentId = opts.experimentId ?? 'extraction-task'
  return async function dispatchWithSurface(
    surface: string,
    scenario: ExtractScenario,
    ctx: DispatchContext,
  ): Promise<Artifact> {
    const res = await callLlm(
      {
        model: opts.model,
        messages: [
          { role: 'system' as const, content: surface },
          { role: 'user' as const, content: scenario.text },
        ],
        jsonMode: true,
        temperature: 0,
        maxTokens: 400,
        timeoutMs,
      },
      opts.llm,
    )
    const costUsd =
      res.costUsd ??
      (res.usage.promptTokens / 1_000_000) * opts.priceInPerMTokens +
        (res.usage.completionTokens / 1_000_000) * opts.priceOutPerMTokens
    // Report BOTH so the cell carries real cost AND real tokens — the
    // backend-integrity guard keys on tokens, the budget gate on cost.
    ctx.cost.observe(costUsd, 'worker')
    ctx.cost.observeTokens({ input: res.usage.promptTokens, output: res.usage.completionTokens })
    opts.records.push({
      runId: `${scenario.id}-${createHash('sha1').update(surface).digest('hex').slice(0, 8)}-${opts.records.length}`,
      experimentId,
      candidateId: createHash('sha1').update(surface).digest('hex').slice(0, 12),
      seed: 42,
      model: res.model || opts.model,
      promptHash: createHash('sha256').update(surface).digest('hex'),
      configHash: 'extraction-json',
      commitSha: process.env.GIT_SHA ?? 'local',
      wallMs: res.durationMs,
      costUsd,
      tokenUsage: { input: res.usage.promptTokens, output: res.usage.completionTokens },
      outcome: { raw: {} },
      splitTag: (scenario.tags?.[0] as RunRecord['splitTag']) ?? 'search',
      scenarioId: scenario.id,
    })
    return { text: res.content, parsed: parseJsonLoose(res.content) }
  }
}
