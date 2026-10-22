import type { ReplayBatchReport } from './batch'

function pct(value: number | null): string {
  return value === null ? '—' : `${(value * 100).toFixed(1)}%`
}

export function renderBatchReport(report: ReplayBatchReport): string {
  const lines: string[] = []
  const { headline, totals } = report
  lines.push('# Replay-verify batch report')
  lines.push('')
  lines.push(`Generated ${report.generatedAt}.`)
  lines.push('')
  lines.push('## Headline')
  lines.push('')
  const fidelity = headline.prefixFidelity
  lines.push(
    `- **Replayability rate: ${pct(headline.replayabilityRate.value)}** ` +
      `(${headline.replayabilityRate.numerator}/${headline.replayabilityRate.denominator} replayable cases ` +
      `where the prefix replayed within ${fidelity.tolerancePct}% divergence AND arm A reproduced an observed failure at the gold step k).`,
  )
  lines.push(
    `- Signature-strict rate: ${pct(headline.signatureStrictRate.value)} ` +
      `(${headline.signatureStrictRate.numerator}/${headline.signatureStrictRate.denominator}; additionally requires the recorded error substring in arm A output).`,
  )
  lines.push(
    `- **Prefix divergence: ${fidelity.divergencePct === null ? '—' : `${fidelity.divergencePct}%`}** ` +
      `(${fidelity.divergentSteps}/${fidelity.executedSteps} executed prefix steps did not confirm the recording: ` +
      `${fidelity.returncodeMismatches} returncode mismatches, ${fidelity.unknownExpectations} with no recorded returncode to check). ` +
      `${fidelity.casesWithinTolerance}/${fidelity.casesExecuted} executed cases are within the ${fidelity.tolerancePct}% tolerance.`,
  )
  if (headline.fixFlipRate) {
    lines.push(
      `- **Fix-flip rate: ${pct(headline.fixFlipRate.value)}** ` +
        `(${headline.fixFlipRate.numerator}/${headline.fixFlipRate.denominator} arm-B-executed cases where the generated fix made the failure vanish).`,
    )
  }
  if (headline.fixFlipRateNonzeroRc) {
    lines.push(
      `- Fix-flip rate on recorded-rc≠0 cases: ${pct(headline.fixFlipRateNonzeroRc.value)} ` +
        `(${headline.fixFlipRateNonzeroRc.numerator}/${headline.fixFlipRateNonzeroRc.denominator}; real recorded failures — a gold step recorded with rc 0 flips vacuously).`,
    )
  }
  if (headline.fixFlipAttempt1) {
    lines.push(
      `- Fix-flip@1: ${pct(headline.fixFlipAttempt1.value)} ` +
        `(${headline.fixFlipAttempt1.numerator}/${headline.fixFlipAttempt1.denominator} cases whose attempt 1 executed — the one-shot-comparable number).`,
    )
  }
  if (headline.flipsByAttempt && Object.keys(headline.flipsByAttempt).length > 0) {
    const parts = Object.entries(headline.flipsByAttempt)
      .sort((a, b) => Number(a[0]) - Number(b[0]))
      .map(([attempt, count]) => `attempt ${attempt}: ${count}`)
    lines.push(`- Flips by attempt: ${parts.join(', ')}.`)
  }
  lines.push('')
  lines.push('## Enumeration')
  lines.push('')
  lines.push(
    `${totals.labelEntries} label entries across ${report.corpora.length} corpora → ` +
      `${totals.replayable} replayable (SWE-style docker image + ≥1 gold incorrect step), ${totals.executed} executed.`,
  )
  lines.push('')
  lines.push('| exclusion reason | count |')
  lines.push('| --- | --- |')
  for (const [reason, count] of Object.entries(totals.excludedByReason).sort(
    (a, b) => b[1] - a[1],
  )) {
    lines.push(`| ${reason} | ${count} |`)
  }
  const submitEntries = Object.entries(totals.submitGoldsByCorpus)
  if (submitEntries.length > 0) {
    lines.push('')
    lines.push(
      'Submit-command golds are never counterfactual targets ' +
        '(a gold on the submit step marks a bad submit decision, not a failed command):',
    )
    lines.push('')
    lines.push(
      '| corpus | cases excluded (all golds = submit) | golds skipped within replayable cases |',
    )
    lines.push('| --- | --- | --- |')
    for (const [corpus, stats] of submitEntries.sort((a, b) => a[0].localeCompare(b[0]))) {
      lines.push(`| ${corpus} | ${stats.submitOnlyCases} | ${stats.goldsSkippedWithinReplayable} |`)
    }
  }
  if (report.pullFailures.length > 0) {
    lines.push('')
    lines.push('## Image pull/build failures')
    lines.push('')
    lines.push('| corpus | trajectory | image | error |')
    lines.push('| --- | --- | --- | --- |')
    for (const failure of report.pullFailures) {
      lines.push(
        `| ${failure.corpus} | ${failure.trajId} | \`${failure.image}\` | ${failure.error.replaceAll('|', '\\|')} |`,
      )
    }
  }
  lines.push('')
  lines.push('## Per-case results')
  lines.push('')
  lines.push(
    '| corpus | trajectory | k | rc@k | prefix | confirmed | rc mismatch | unknown rc | div | div% | armA exit | rc match | sig match | replayed | fix | armB exit | armB div% | vanished | wall s |',
  )
  lines.push(`| ${Array(19).fill('---').join(' | ')} |`)
  for (const row of report.cases) {
    const fix = row.fix
    const fixCell = !fix
      ? '—'
      : fix.sampledOut
        ? 'sampled-out'
        : fix.llmError
          ? 'llm-failed'
          : fix.armBError
            ? 'armB-error'
            : fix.attempts
              ? fix.flippedAtAttempt !== null
                ? `flip@${fix.flippedAtAttempt}`
                : `exhausted(${fix.attempts.length})`
              : 'generated'
    lines.push(
      [
        row.corpus,
        row.trajId.length > 48 ? `${row.trajId.slice(0, 45)}…` : row.trajId,
        row.k,
        row.recordedReturncodeAtK ?? 'null',
        row.prefixExecuted ?? '—',
        row.prefixConfirmed ?? '—',
        row.prefixReturncodeMismatches ?? '—',
        row.prefixUnknownExpectations ?? '—',
        row.prefixDivergences ?? '—',
        row.prefixDivergencePct ?? '—',
        row.status === 'ok' ? row.armAExit : row.status,
        row.armAReturncodeMatch ? 'yes' : 'no',
        row.armASignatureMatch ? 'yes' : 'no',
        row.replayed ? '**yes**' : 'no',
        fixCell,
        fix?.armBExit ?? '—',
        fix?.armBPrefixDivergencePct ?? '—',
        fix?.failureVanished === null || fix === null
          ? '—'
          : fix.failureVanished
            ? '**yes**'
            : 'no',
        (row.wallMs / 1000).toFixed(1),
      ].join(' | '),
    )
  }
  if (report.llm) {
    lines.push('')
    lines.push('## LLM fix generation')
    lines.push('')
    lines.push(
      `Model ${report.llm.model}: ${report.llm.calls} calls (${report.llm.failures} failed), ` +
        `${report.llm.promptTokens} prompt + ${report.llm.completionTokens} completion tokens.`,
    )
  }
  lines.push('')
  return lines.join('\n')
}
