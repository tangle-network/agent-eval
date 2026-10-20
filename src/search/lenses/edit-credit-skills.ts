/** Turn linked reusable insert genes into inline skill resources. */
import { type AgentProfileResourceRef, defineInlineResource } from '@tangle-network/agent-interface'
import type { SearchSplit } from '../../campaign/search-ledger-types'
import type { EditGene, EditSkillCandidate, GeneRecord } from './edit-credit-contract'
import { appendTo, compareOrder } from './edit-credit-lineage'

export function skills(
  genes: readonly EditGene[],
  records: ReadonlyMap<string, GeneRecord>,
  subject: string,
  split: SearchSplit,
): EditSkillCandidate[] {
  const byGroup = new Map<string, EditGene[]>()
  for (const gene of genes) {
    if (gene.verdict !== 'reusable' || gene.kind !== 'insert') continue
    const group = gene.linkage ?? gene.geneId
    appendTo(byGroup, group, gene)
  }
  const candidates: EditSkillCandidate[] = []
  for (const members of byGroup.values()) {
    members.sort((a, b) => compareOrder(records.get(a.geneId)!.order, records.get(b.geneId)!.order))
    const lead = members[0]!
    const name = `edit-${lead.geneId.slice('gene_'.length, 'gene_'.length + 12)}`
    const content = [
      '---',
      `name: ${name}`,
      `description: ${JSON.stringify(
        `Instructions a ${subject} search kept: the edit to ${lead.path} whose carriers scored better than the nodes without it on the ${split} split.`,
      )}`,
      '---',
      '',
      members.map((gene) => gene.text).join('\n\n'),
      '',
    ].join('\n')
    candidates.push({
      resource: defineInlineResource(name, content) as Extract<
        AgentProfileResourceRef,
        { kind: 'inline' }
      >,
      improveOptions: { surface: 'skills', skills: { resourceName: name } },
      genes: members.map((gene) => gene.geneId),
      path: lead.path,
      credit: lead.credit,
    })
  }
  return candidates
}
