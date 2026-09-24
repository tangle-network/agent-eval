import { snapshotAgentProviderSessionRef } from '@tangle-network/agent-interface'
import type { SupervisorRunProviderSessionRef, SupervisorRunSessionLineage } from './types'

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${path} must be a non-empty string`)
  }
  return value
}

function nullableString(value: unknown, path: string): string | null {
  if (value === null) return null
  return requiredString(value, path)
}

export function snapshotSupervisorRunProviderSession(
  value: unknown,
  path: string,
): SupervisorRunProviderSessionRef {
  try {
    return snapshotAgentProviderSessionRef(value)
  } catch (error) {
    throw new Error(
      `${path} is not a valid AgentProviderSessionRef: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    )
  }
}

/**
 * Snapshot, validate, and deeply freeze provider-session lineage at analysis
 * intake so later caller mutation cannot rewrite evidence relationships.
 */
export function snapshotSupervisorRunSessionLineage(
  value: unknown,
): readonly SupervisorRunSessionLineage[] {
  if (!Array.isArray(value)) {
    throw new Error('sessionLineage must be an array')
  }

  const rows: SupervisorRunSessionLineage[] = []
  for (const [index, item] of Array.from(value).entries()) {
    const source = record(item)
    if (source === null) throw new Error(`sessionLineage[${index}] must be an object`)
    const nodeIdValue = source.nodeId
    const parentNodeIdValue = source.parentNodeId
    const depthValue = source.depth
    const childNodeIdsValue = source.childNodeIds
    const providerSessionValue = source.providerSession

    const nodeId = requiredString(nodeIdValue, `sessionLineage[${index}].nodeId`)
    const parentNodeId = nullableString(parentNodeIdValue, `sessionLineage[${index}].parentNodeId`)
    if (!Number.isSafeInteger(depthValue) || (depthValue as number) < 0) {
      throw new Error(`sessionLineage[${index}].depth must be a non-negative safe integer`)
    }
    if (!Array.isArray(childNodeIdsValue)) {
      throw new Error(`sessionLineage[${index}].childNodeIds must be an array`)
    }
    const childNodeIds = Object.freeze(
      Array.from(childNodeIdsValue).map((childNodeId, childIndex) =>
        requiredString(childNodeId, `sessionLineage[${index}].childNodeIds[${childIndex}]`),
      ),
    )
    if (new Set(childNodeIds).size !== childNodeIds.length) {
      throw new Error(`sessionLineage[${index}].childNodeIds contains duplicates`)
    }
    const providerSession =
      providerSessionValue === undefined
        ? undefined
        : snapshotSupervisorRunProviderSession(
            providerSessionValue,
            `sessionLineage[${index}].providerSession`,
          )
    if (providerSession !== undefined && providerSession.externalId !== nodeId) {
      throw new Error(
        `sessionLineage[${index}].providerSession.externalId must equal its Runtime nodeId`,
      )
    }

    rows.push(
      Object.freeze({
        nodeId,
        parentNodeId,
        depth: depthValue as number,
        childNodeIds,
        ...(providerSession === undefined ? {} : { providerSession }),
      }),
    )
  }

  const byNode = new Map<string, SupervisorRunSessionLineage>()
  const nativeOwners = new Map<string, string>()
  const turnOwners = new Map<string, string>()
  for (const row of rows) {
    if (byNode.has(row.nodeId)) {
      throw new Error(`sessionLineage repeats Runtime node ${JSON.stringify(row.nodeId)}`)
    }
    byNode.set(row.nodeId, row)
    const session = row.providerSession
    if (session === undefined) continue
    const nativeKey = `${session.provider}\u0000${session.backend}\u0000${session.nativeSessionId}`
    const nativeOwner = nativeOwners.get(nativeKey)
    if (nativeOwner !== undefined) {
      throw new Error(
        `sessionLineage Runtime nodes ${JSON.stringify(nativeOwner)} and ${JSON.stringify(row.nodeId)} reuse one native session`,
      )
    }
    nativeOwners.set(nativeKey, row.nodeId)
    for (const receipt of session.controllerTurns) {
      const turnOwner = turnOwners.get(receipt.runId)
      if (turnOwner !== undefined) {
        throw new Error(
          `sessionLineage Runtime nodes ${JSON.stringify(turnOwner)} and ${JSON.stringify(row.nodeId)} reuse controller run ${JSON.stringify(receipt.runId)}`,
        )
      }
      turnOwners.set(receipt.runId, row.nodeId)
    }
  }

  const roots = rows.filter((row) => row.parentNodeId === null)
  if (rows.length > 0 && roots.length !== 1) {
    throw new Error(`sessionLineage must contain exactly one root; found ${roots.length}`)
  }
  for (const row of rows) {
    if (row.parentNodeId !== null && !byNode.has(row.parentNodeId)) {
      throw new Error(
        `sessionLineage node ${JSON.stringify(row.nodeId)} has absent parent ${JSON.stringify(row.parentNodeId)}`,
      )
    }
    for (const childNodeId of row.childNodeIds) {
      const child = byNode.get(childNodeId)
      if (child === undefined || child.parentNodeId !== row.nodeId) {
        throw new Error(
          `sessionLineage node ${JSON.stringify(row.nodeId)} has inconsistent child ${JSON.stringify(childNodeId)}`,
        )
      }
    }
    const expectedChildren = rows
      .filter((candidate) => candidate.parentNodeId === row.nodeId)
      .map((candidate) => candidate.nodeId)
    if (
      expectedChildren.length !== row.childNodeIds.length ||
      expectedChildren.some((childNodeId) => !row.childNodeIds.includes(childNodeId))
    ) {
      throw new Error(
        `sessionLineage node ${JSON.stringify(row.nodeId)} childNodeIds do not match parent links`,
      )
    }
  }

  const depthByNode = new Map<string, number>()
  const visiting = new Set<string>()
  const expectedDepth = (nodeId: string): number => {
    const known = depthByNode.get(nodeId)
    if (known !== undefined) return known
    if (visiting.has(nodeId)) {
      throw new Error(`sessionLineage ancestry contains a cycle at ${JSON.stringify(nodeId)}`)
    }
    const row = byNode.get(nodeId)
    if (row === undefined) {
      throw new Error(`sessionLineage node ${JSON.stringify(nodeId)} is absent`)
    }
    visiting.add(nodeId)
    const depth = row.parentNodeId === null ? 0 : expectedDepth(row.parentNodeId) + 1
    visiting.delete(nodeId)
    depthByNode.set(nodeId, depth)
    return depth
  }
  for (const row of rows) {
    const depth = expectedDepth(row.nodeId)
    if (row.depth !== depth) {
      throw new Error(
        `sessionLineage node ${JSON.stringify(row.nodeId)} has depth ${row.depth}; expected ${depth}`,
      )
    }
  }

  return Object.freeze(rows)
}
