/** JSON-serializable value — everything a sealed node may carry. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue }

/** Evidence row shape. Fields are addressed by dot-separated paths. */
export type EvidenceRecord = Record<string, unknown>
