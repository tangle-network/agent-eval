/** The artifact each node holds: kept in memory once seen, else loaded from the ledger. */

export class SearchArtifactCache<TArtifact> {
  private readonly artifacts = new Map<string, TArtifact>()
  /** Children a proposal returned, by artifact digest, until they are registered. */
  private readonly proposed = new Map<string, TArtifact>()

  constructor(private readonly load: (nodeId: string) => TArtifact) {}

  get(nodeId: string): TArtifact {
    const held = this.artifacts.get(nodeId)
    if (held !== undefined) return held
    const artifact = this.load(nodeId)
    this.artifacts.set(nodeId, artifact)
    return artifact
  }

  seed(nodeId: string, artifact: TArtifact): void {
    this.artifacts.set(nodeId, artifact)
  }

  /** Hold a proposed child until the ledger registers its node. */
  propose(digest: string, artifact: TArtifact): void {
    this.proposed.set(digest, artifact)
  }

  /** The node registered: it takes the artifact proposed under its digest, if one is held. */
  register(nodeId: string, digest: string): void {
    const held = this.proposed.get(digest)
    if (held === undefined) return
    this.proposed.delete(digest)
    if (!this.artifacts.has(nodeId)) this.artifacts.set(nodeId, held)
  }
}
