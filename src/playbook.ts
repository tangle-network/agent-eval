export interface PlaybookEntry {
  instruction: string
  rationale: string
  category?: string
  evidence?: string
  weight?: number
  sourceRunId?: string
}

export interface Playbook {
  entries: PlaybookEntry[]
}

export function distillPlaybook(
  entries: PlaybookEntry[],
  options: { maxEntries?: number } = {},
): Playbook {
  const maxEntries = options.maxEntries ?? 12
  const byInstruction = new Map<string, PlaybookEntry>()

  for (const entry of entries) {
    const key = normalizeInstruction(entry.instruction)
    const existing = byInstruction.get(key)
    if (!existing || (entry.weight ?? 0) > (existing.weight ?? 0)) {
      byInstruction.set(key, { ...entry, instruction: canonicalInstruction(entry.instruction) })
    }
  }

  const distilled = [...byInstruction.values()]
    .sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0))
    .slice(0, maxEntries)

  return { entries: distilled }
}

export function renderPlaybookMarkdown(playbook: Playbook): string {
  const lines = ['# Playbook', '']
  for (const entry of playbook.entries) {
    lines.push(`- ${entry.instruction}`)
    lines.push(`  Rationale: ${entry.rationale}`)
    if (entry.category) lines.push(`  Category: ${entry.category}`)
    if (entry.evidence) lines.push(`  Evidence: ${entry.evidence}`)
    if (entry.sourceRunId) lines.push(`  Source run: ${entry.sourceRunId}`)
    lines.push('')
  }
  return `${lines.join('\n').trim()}\n`
}

function normalizeInstruction(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ')
}

function canonicalInstruction(value: string): string {
  const normalized = value.trim().replace(/\s+/g, ' ')
  return normalized.length === 0 ? normalized : normalized[0]!.toUpperCase() + normalized.slice(1)
}
