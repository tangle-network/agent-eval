/** An artifact an agent produced, as completion and produced-state checks read it. */
export interface Artifact {
  /** Logical kind — validators type-guard on this */
  kind: 'file' | 'json' | 'text' | 'binary' | string
  /** Filesystem-style path, optional */
  path?: string
  /** String content for text/json/file kinds */
  content?: string
  /** Binary content (if kind === 'binary') */
  bytes?: Uint8Array
  /** Caller-supplied metadata (mimeType, sha256, size, etc.) */
  metadata?: Record<string, unknown>
}
