/**
 * Analyze a multi-rater approve/reject corpus.
 *
 * Run with: pnpm tsx examples/customer-feedback-loop/index.ts
 *
 * Synthesises a 30-claim research corpus reviewed by 3 raters with realistic
 * agreement noise. Pipes through fromFeedbackTable() + analyzeRuns(), then
 * prints the report. Focus on the inter-rater agreement section
 * and the top disagreement triage list.
 */

import {
  analyzeRuns,
  fromFeedbackTable,
  type FeedbackTableRow,
} from '../../src/contract'

const N_CLAIMS = 30
const RATERS = ['alice', 'bob', 'carol']

// Synthesise a corpus where raters mostly agree but split on ~15% of claims.
function synthesise(): FeedbackTableRow[] {
  const rows: FeedbackTableRow[] = []
  for (let i = 0; i < N_CLAIMS; i++) {
    const runId = `claim-${i + 1}`
    // Ground-truth quality: 70% are clearly good, 15% borderline (disagreement),
    // 15% clearly bad.
    const tier = i % 7 === 0 ? 'borderline' : i % 6 === 0 ? 'bad' : 'good'
    for (const rater of RATERS) {
      let approve: boolean
      if (tier === 'good') {
        approve = pseudoRand(runId + rater) > 0.1 // 90% approve
      } else if (tier === 'bad') {
        approve = pseudoRand(runId + rater) > 0.85 // 15% approve
      } else {
        // Borderline ratings differ by reviewer strictness.
        const bias = rater === 'alice' ? 0.7 : rater === 'carol' ? 0.3 : 0.5
        approve = pseudoRand(runId + rater) > bias
      }
      rows.push({ runId, rater, rating: approve })
    }
  }
  return rows
}

function pseudoRand(s: string): number {
  let h = 2166136261 >>> 0
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619) >>> 0
  }
  return (h >>> 0) / 0xffffffff
}

async function main() {
  const rows = synthesise()
  const { runs, raterScores } = fromFeedbackTable({ ratings: rows })
  const report = await analyzeRuns({ runs, raterScores })

  console.log('Customer feedback report')
  console.log()
  console.log(`Runs analyzed:     ${report.n}`)
  console.log(
    `Composite mean:    ${report.composite.mean.toFixed(3)} ` +
      `(p50: ${report.composite.p50.toFixed(3)}, p95: ${report.composite.p95.toFixed(3)})`,
  )
  const approveRate = (report.composite.mean * 100).toFixed(0)
  console.log(`Approve rate:      ~${approveRate}%`)
  console.log()

  if (report.interRater) {
    const ir = report.interRater
    console.log('Inter-rater agreement')
    console.log(`Raters:               ${ir.raters} (${RATERS.join(', ')})`)
    console.log(`Jointly rated runs:   ${ir.jointlyRated}`)
    console.log('Pairwise weighted kappa:')
    for (const [pair, k] of Object.entries(ir.perPair)) {
      console.log(`  ${pair.padEnd(14)} ${k.toFixed(2)}`)
    }
    console.log(`Weighted kappa:       ${ir.kappa.toFixed(2)}`)
    console.log(`ICC(2,1):             ${ir.icc.toFixed(2)}`)
    console.log(`Pearson correlation:  ${ir.pearson.toFixed(2)}`)
    console.log()

    console.log('Top 5 disagreement cases')
    for (const c of ir.disagreementCases.slice(0, 5)) {
      const ratingStr = c.ratings
        .map((r) => `${r.rater}=${r.score.toFixed(0)}`)
        .join(', ')
      console.log(`  ${c.runId.padEnd(10)} range=${c.range.toFixed(2)}  ratings: ${ratingStr}`)
    }
    console.log()
  }

  console.log('Recommendations')
  for (const r of report.recommendations) {
    console.log(`[${r.priority}] ${r.kind}: ${r.title}`)
    console.log(`  ${r.detail}`)
  }
  console.log()
  console.log('End')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
