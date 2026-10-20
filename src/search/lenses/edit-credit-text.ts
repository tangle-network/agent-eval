/** Compact human- and proposer-readable rendering of edit-credit evidence. */
import type { NodeEstimate } from '../../campaign/search-ledger-types'
import type { EditCreditResult } from './edit-credit-contract'
import { DESCRIPTIVE_FROM } from './edit-credit-contract'

/** The lens as compact text: what `agent-eval search show --edit-credit`
 * prints and a proposer can read. */
export function editCreditText(result: EditCreditResult, options: { limit?: number } = {}): string {
  const limit = options.limit ?? 10
  const { data, signal } = result
  const unknown = Object.entries(data.edges.unknown)
    .map(([reason, count]) => `${count} ${reason}`)
    .join(', ')
  const lines = [
    `edit credit — ${data.genes.length} genes from ${data.edges.read} of ${data.edges.lineage} lineage edges, ${data.steps.total - data.steps.invalidEnd} measurable steps (${data.split} split, ${data.direction})`,
    `  genes: reusable ${data.counts.reusable} · harmful ${data.counts.harmful} · unresolved ${data.counts.unresolved} · insufficient ${data.counts.insufficient}`,
    `  edits: reusable ${data.editCounts.reusable} · harmful ${data.editCounts.harmful} · unresolved ${data.editCounts.unresolved} · insufficient ${data.editCounts.insufficient}`,
    `  signal ${signal.name} = ${signal.value ?? 'null'} (${signal.basis})${signal.top.length > 0 ? `; top: ${signal.top.slice(0, 5).join(', ')}` : ''}`,
  ]
  if (unknown.length > 0) lines.push(`  edges without content: ${unknown}`)
  if (data.nodes.invalid > 0) {
    lines.push(
      `  ${data.nodes.invalid} invalid node(s): ${data.steps.invalidEnd} step(s) excluded from every contrast`,
    )
  }
  lines.push('', 'Genes (carrying vs lacking side of each clean lineage step):')
  if (data.genes.length === 0) lines.push('  none')
  for (const gene of data.genes.slice(0, limit)) {
    const reproposed = gene.introduced.length > 1 ? ` · introduced ${gene.introduced.length}×` : ''
    const dropped = gene.dropped > 0 ? ` · dropped ${gene.dropped}×` : ''
    const linked =
      gene.linkage && gene.linkage !== gene.geneId ? ` · linked to ${gene.linkage}` : ''
    const invalid = gene.invalidCarriers > 0 ? ` · ${gene.invalidCarriers} invalid carrier(s)` : ''
    lines.push(
      `  ${gene.geneId} ${gene.verdict} ${gene.kind} ${gene.path} "${excerpt(gene.lines)}"`,
      `    ${gene.steps.clean} clean of ${gene.steps.flips} step(s) (+${gene.steps.gained}/−${gene.steps.lost}) · ${formatEstimate(gene.credit)}${reproposed}${dropped}${linked}${invalid}`,
    )
  }
  if (data.genes.length > limit) lines.push(`  … ${data.genes.length - limit} more`)
  const { interactions } = data
  lines.push(
    '',
    `Interactions: ${interactions.pairsTested} pair(s) tested of ${interactions.pairsWithContexts} with both contexts, among ${interactions.genesConsidered} genes (Holm, α=${interactions.alpha}):`,
  )
  const shown = interactions.pairs.filter((pair) => pair.signP !== null).slice(0, limit)
  if (shown.length === 0) lines.push('  none testable')
  for (const pair of shown) {
    const interval = pair.interval
      ? ` [${pair.interval[0].toFixed(4)}, ${pair.interval[1].toFixed(4)}]`
      : ''
    lines.push(
      `  ${pair.genes[0]} × ${pair.genes[1]}: ${pair.interacting ? 'INTERACTING' : 'no flag'} ${signed(pair.interaction)}${interval} on ${pair.units} units, sign p=${pair.signP!.toPrecision(3)}, Holm p=${pair.adjustedP!.toPrecision(3)}`,
    )
  }
  lines.push('', `Skill candidates (agent-runtime improve surface 'skills'):`)
  if (data.skillCandidates.length === 0) lines.push('  none')
  for (const candidate of data.skillCandidates.slice(0, limit)) {
    lines.push(
      `  ${candidate.resource.name}: ${candidate.genes.length} gene(s) at ${candidate.path} · ${formatEstimate(candidate.credit)}`,
    )
  }
  return lines.join('\n')
}

function excerpt(lines: readonly string[]): string {
  const text = lines.join(' ⏎ ')
  return text.length <= 72 ? text : `${text.slice(0, 71)}…`
}

function signed(value: number | null): string {
  if (value === null) return 'null'
  return `${value >= 0 ? '+' : ''}${value.toFixed(4)}`
}

function formatEstimate(estimate: NodeEstimate): string {
  const units = `${estimate.pairs} unit${estimate.pairs === 1 ? '' : 's'}`
  if (estimate.method === 'none') return `unknown (${units})`
  if (estimate.indeterminate) return `no measurable difference (indeterminate, ${units})`
  const delta = `Δ=${signed(estimate.delta)}`
  if (estimate.method === 'insufficient') {
    return `${delta} (${estimate.pairs} of ${DESCRIPTIVE_FROM} units, insufficient)`
  }
  const interval = estimate.interval
    ? ` [${estimate.interval[0].toFixed(4)}, ${estimate.interval[1].toFixed(4)}]`
    : ''
  if (estimate.method === 'descriptive') {
    const p = estimate.exactSignP === null ? 'null' : estimate.exactSignP.toPrecision(3)
    return `${delta}${interval} descriptive, sign p=${p} (${units})`
  }
  return `${delta}${interval} bootstrap (${units})`
}
