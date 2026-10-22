import { isRecord } from '../llm-client/json'

type ExpandedJournalRow =
  | { succeeded: true; value: readonly Record<string, unknown>[] }
  | { succeeded: false; error: string }

/** Expand a committed group only after every member is readable; never recover its prefix. */
export function expandJournalEventGroup(row: Record<string, unknown>): ExpandedJournalRow {
  if (row.kind !== 'events') return { succeeded: true, value: [row] }
  if (typeof row.root !== 'string' || row.root.length === 0) {
    return { succeeded: false, error: 'root must be a non-empty string' }
  }
  if (!Array.isArray(row.events)) {
    return { succeeded: false, error: 'events must be an array' }
  }
  for (const [index, event] of row.events.entries()) {
    if (!isRecord(event)) {
      return { succeeded: false, error: `events[${index}] must be an object` }
    }
    if (typeof event.kind !== 'string' || event.kind.length === 0) {
      return { succeeded: false, error: `events[${index}].kind must be a non-empty string` }
    }
  }
  return {
    succeeded: true,
    value: row.events.map((event) => ({ kind: 'event', root: row.root, event })),
  }
}
