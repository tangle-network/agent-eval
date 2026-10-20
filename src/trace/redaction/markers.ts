const MARKER_PREFIX = '[REDACTED:'

export function marker(detector: string): string {
  return `${MARKER_PREFIX}${detector}]`
}

/**
 * Placeholders other tools write for a removed value. A credential field that
 * holds one of these is already redacted and is not flagged again.
 */
const REDACTED_PLACEHOLDER =
  /^(?:\[(?:REDACTED|redacted)(?::[^\]]*)?\]|\[ID:[0-9a-f]{12}\]|\*{3,}|<redacted>|«redacted»|\[HASH:[0-9a-f]{8,}\])$/

export function isPlaceholder(value: string): boolean {
  return value === '' || REDACTED_PLACEHOLDER.test(value)
}
