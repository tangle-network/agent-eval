/**
 * Domain taxonomy — one versioned tree that both the layer ladder and the
 * domain hierarchy live in.
 *
 * Domain nodes nest to any depth ("building systems" → "cryptographic" →
 * "zk proving" → "binary fields"). Problems attach to one primary domain path
 * plus free tags, plays attach to a problem, and runs attach to a play. Every
 * node hangs under the implicit `lab` root, so one parent map answers both
 * "which play holds this run" and "which domain holds this problem", and
 * `promote` walks a single ladder: run → play → problem → domain path → lab.
 *
 * Plain data in, plain data out: every function returns a new value or a
 * typed failure, and nothing here reads a file or the network.
 */

export const DOMAIN_TAXONOMY_SCHEMA = 'agent-eval.domain-taxonomy.v1'

/** Id of the implicit root every top-level domain hangs under. */
export const LAB_NODE_ID = 'lab'

/** Layers a taxonomy node can sit at, lowest first. */
export const TAXONOMY_NODE_LAYERS = ['run', 'play', 'problem', 'domain'] as const

export type TaxonomyNodeLayer = (typeof TAXONOMY_NODE_LAYERS)[number]

export interface TaxonomyNode {
  id: string
  label: string
  layer: TaxonomyNodeLayer
  /** Null only for a top-level domain, whose parent is the implicit lab root. */
  parent: string | null
  /** Secondary classifications; they never change the node's place in the tree. */
  tags?: string[]
}

export interface DomainTaxonomy {
  schema: typeof DOMAIN_TAXONOMY_SCHEMA
  /** Caller-chosen version; promoted findings record the version they were lifted under. */
  version: string
  nodes: TaxonomyNode[]
}

export type TaxonomyOutcome<T> =
  | { succeeded: true; value: T }
  | { succeeded: false; error: { message: string } }

/** The layer a node of each kind must hang under. */
const PARENT_LAYER: Record<TaxonomyNodeLayer, TaxonomyNodeLayer | null> = {
  run: 'play',
  play: 'problem',
  problem: 'domain',
  domain: 'domain',
}

function fail<T>(message: string): TaxonomyOutcome<T> {
  return { succeeded: false, error: { message } }
}

/**
 * Validate a taxonomy: unique ids, known parents, each node under a parent of
 * the right layer, no cycles. `lab` is reserved for the implicit root.
 */
export function defineDomainTaxonomy(input: {
  version: string
  nodes: ReadonlyArray<TaxonomyNode>
}): TaxonomyOutcome<DomainTaxonomy> {
  if (typeof input.version !== 'string' || !input.version.trim()) {
    return fail('taxonomy version must be a non-empty string')
  }
  const nodes = input.nodes.map((node) => ({
    id: node.id,
    label: node.label,
    layer: node.layer,
    parent: node.parent,
    ...(node.tags === undefined ? {} : { tags: [...node.tags] }),
  }))
  const byId = new Map<string, TaxonomyNode>()
  for (const node of nodes) {
    if (typeof node.id !== 'string' || !node.id.trim()) return fail('node ids must be non-empty')
    if (node.id === LAB_NODE_ID) return fail(`'${LAB_NODE_ID}' is the implicit root id`)
    if (byId.has(node.id)) return fail(`node '${node.id}' appears twice`)
    if (!(TAXONOMY_NODE_LAYERS as readonly string[]).includes(node.layer)) {
      return fail(`node '${node.id}' has unknown layer '${String(node.layer)}'`)
    }
    if (typeof node.label !== 'string' || !node.label.trim()) {
      return fail(`node '${node.id}' needs a label`)
    }
    byId.set(node.id, node)
  }
  for (const node of nodes) {
    if (node.parent === null) {
      if (node.layer !== 'domain') return fail(`${node.layer} '${node.id}' needs a parent`)
      continue
    }
    const parent = byId.get(node.parent)
    if (!parent) return fail(`node '${node.id}' names unknown parent '${node.parent}'`)
    if (parent.layer !== PARENT_LAYER[node.layer]) {
      return fail(
        `${node.layer} '${node.id}' must hang under a ${PARENT_LAYER[node.layer]}, not ${parent.layer} '${parent.id}'`,
      )
    }
  }
  for (const node of nodes) {
    const seen = new Set<string>()
    let current: TaxonomyNode | undefined = node
    while (current) {
      if (seen.has(current.id)) return fail(`node '${node.id}' sits on a parent cycle`)
      seen.add(current.id)
      current = current.parent === null ? undefined : byId.get(current.parent)
    }
  }
  return {
    succeeded: true,
    value: { schema: DOMAIN_TAXONOMY_SCHEMA, version: input.version, nodes },
  }
}

export interface TaxonomyAttachment {
  id: string
  label: string
  layer: Exclude<TaxonomyNodeLayer, 'domain'>
  /**
   * For a problem: its primary domain path, broadest first. It must be a
   * chain of domain nodes from the top level down. Ignored for plays and runs.
   */
  path?: readonly string[]
  /** For a play or run: the problem or play it belongs to. */
  parent?: string
  tags?: readonly string[]
}

/** Attach a problem to one primary domain path, a play to a problem, or a run to a play. */
export function attachToTaxonomy(
  taxonomy: DomainTaxonomy,
  attachment: TaxonomyAttachment,
): TaxonomyOutcome<DomainTaxonomy> {
  let parent: string
  if (attachment.layer === 'problem') {
    if (!attachment.path || attachment.path.length === 0) {
      return fail(`problem '${attachment.id}' needs a primary domain path`)
    }
    const resolved = resolveDomainPath(taxonomy, attachment.path)
    if (!resolved.succeeded) return resolved
    parent = attachment.path[attachment.path.length - 1]!
  } else {
    if (!attachment.parent) return fail(`${attachment.layer} '${attachment.id}' needs a parent`)
    parent = attachment.parent
  }
  return defineDomainTaxonomy({
    version: taxonomy.version,
    nodes: [
      ...taxonomy.nodes,
      {
        id: attachment.id,
        label: attachment.label,
        layer: attachment.layer,
        parent,
        ...(attachment.tags === undefined ? {} : { tags: [...attachment.tags] }),
      },
    ],
  })
}

/** Check that a path is a top-down chain of domain nodes. */
export function resolveDomainPath(
  taxonomy: DomainTaxonomy,
  path: readonly string[],
): TaxonomyOutcome<readonly TaxonomyNode[]> {
  const byId = nodeIndex(taxonomy)
  const chain: TaxonomyNode[] = []
  let expectedParent: string | null = null
  for (const id of path) {
    const node = byId.get(id)
    if (node?.layer !== 'domain') return fail(`'${id}' is not a domain node`)
    if (node.parent !== expectedParent) {
      return fail(`domain path breaks at '${id}': its parent is '${node.parent ?? LAB_NODE_ID}'`)
    }
    chain.push(node)
    expectedParent = id
  }
  return { succeeded: true, value: chain }
}

/** Layer of a node id, with `lab` for the implicit root; undefined when unknown. */
export function taxonomyLayerOf(
  taxonomy: DomainTaxonomy,
  id: string,
): TaxonomyNodeLayer | 'lab' | undefined {
  if (id === LAB_NODE_ID) return 'lab'
  return nodeIndex(taxonomy).get(id)?.layer
}

/** Parent id, with `lab` above every top-level domain and null above `lab`. */
export function taxonomyParentOf(taxonomy: DomainTaxonomy, id: string): string | null | undefined {
  if (id === LAB_NODE_ID) return null
  const node = nodeIndex(taxonomy).get(id)
  if (!node) return undefined
  return node.parent ?? LAB_NODE_ID
}

/** The node and its ancestors, nearest first, ending at `lab`. Empty for an unknown id. */
export function taxonomyAncestry(taxonomy: DomainTaxonomy, id: string): string[] {
  const byId = nodeIndex(taxonomy)
  const chain: string[] = []
  let current: string | null = id
  while (current !== null) {
    if (current === LAB_NODE_ID) {
      chain.push(current)
      break
    }
    const node = byId.get(current)
    if (!node) return []
    chain.push(current)
    current = node.parent ?? LAB_NODE_ID
  }
  return chain
}

/** Domain path of a node, broadest first: the domain ids above it, and itself when a domain. */
export function domainPathOf(taxonomy: DomainTaxonomy, id: string): string[] {
  const byId = nodeIndex(taxonomy)
  return taxonomyAncestry(taxonomy, id)
    .filter((ancestor) => byId.get(ancestor)?.layer === 'domain')
    .reverse()
}

/**
 * Deepest node that is an ancestor of (or equal to) every id, or undefined
 * when an id is unknown. `lab` is the answer when they share nothing else.
 */
export function lowestCommonAncestor(
  taxonomy: DomainTaxonomy,
  ids: readonly string[],
): string | undefined {
  if (ids.length === 0) return undefined
  const chains = ids.map((id) => taxonomyAncestry(taxonomy, id))
  if (chains.some((chain) => chain.length === 0)) return undefined
  const others = chains.slice(1).map((chain) => new Set(chain))
  return chains[0]!.find((id) => others.every((chain) => chain.has(id)))
}

function nodeIndex(taxonomy: DomainTaxonomy): Map<string, TaxonomyNode> {
  return new Map(taxonomy.nodes.map((node) => [node.id, node]))
}
