/**
 * Merkle proofs over an append-only list of leaves (RFC 9162 §2.1, the
 * Certificate Transparency tree).
 *
 * A hash chain proves a whole log against its head, but proving one entry means
 * replaying everything before it. This tree proves any one leaf against a root
 * with ⌈log₂ n⌉ hashes (inclusion), and proves that a larger tree only appended
 * to a smaller one (consistency). A verifier holding a root can therefore check
 * a single event, or that a later checkpoint extends an earlier one, without
 * reading the rest of the log.
 *
 * Leaves and interior nodes are domain-separated (0x00 and 0x01 prefixes), so a
 * leaf can never be presented as an interior node. Content that may later be
 * redacted takes a random 32-byte salt: a verifier then needs only the leaf's
 * hash, and short content cannot be guessed back from that hash. The salt must
 * be stored apart from anything that is shared after redaction.
 *
 * Builders refuse malformed input by throwing; verifiers never throw and return
 * a typed outcome, because a proof is external evidence and a bad one is a
 * finding, not a crash.
 */
import { sha256Bytes } from '@tangle-network/agent-interface'
import { ValidationError } from '../errors'
import { LEDGER_HASH_PATTERN, type LedgerHash } from './canonical'

/** Proof that one leaf is at `leafIndex` in a tree of `treeSize` leaves. */
export interface MerkleInclusionProof {
  readonly leafIndex: number
  readonly treeSize: number
  readonly path: readonly LedgerHash[]
}

/** Proof that the first `oldSize` leaves of a `newSize` tree are unchanged. */
export interface MerkleConsistencyProof {
  readonly oldSize: number
  readonly newSize: number
  readonly path: readonly LedgerHash[]
}

export type MerkleVerification =
  | { readonly verified: true }
  | { readonly verified: false; readonly reason: string }

const SALT_PATTERN = /^[a-f0-9]{64}$/
const LEAF_PREFIX = 0x00
const NODE_PREFIX = 0x01
const encoder = new TextEncoder()

/** Root of the empty tree: SHA-256 of no bytes. */
export const MERKLE_EMPTY_ROOT: LedgerHash = sha256Bytes(new Uint8Array(0)) as LedgerHash

/** A fresh random salt for {@link merkleLeafHash}: 32 bytes as 64 lowercase hex characters. */
export function merkleSalt(): string {
  return toHex(globalThis.crypto.getRandomValues(new Uint8Array(32)))
}

/**
 * Leaf hash of `content`: SHA-256(0x00 ‖ salt ‖ content). Without a salt this is
 * exactly the RFC 9162 leaf hash. Strings are hashed as UTF-8.
 */
export function merkleLeafHash(content: Uint8Array | string, salt?: string): LedgerHash {
  const bytes = typeof content === 'string' ? encoder.encode(content) : content
  if (salt === undefined) return digest(LEAF_PREFIX, bytes)
  if (!SALT_PATTERN.test(salt)) {
    throw new ValidationError('merkle salt must be 32 bytes as 64 lowercase hex characters')
  }
  return digest(LEAF_PREFIX, fromHex(salt), bytes)
}

/** Root over leaf hashes, in order. The empty list has {@link MERKLE_EMPTY_ROOT}. */
export function merkleRoot(leaves: readonly LedgerHash[]): LedgerHash {
  const nodes = decodeLeaves(leaves)
  return nodes.length === 0 ? MERKLE_EMPTY_ROOT : toLedgerHash(subtreeRoot(nodes, 0, nodes.length))
}

/** Inclusion proof for the leaf at `leafIndex` (RFC 9162 §2.1.3.1). */
export function merkleInclusionProof(
  leaves: readonly LedgerHash[],
  leafIndex: number,
): MerkleInclusionProof {
  const nodes = decodeLeaves(leaves)
  if (!Number.isSafeInteger(leafIndex) || leafIndex < 0 || leafIndex >= nodes.length) {
    throw new ValidationError(
      `merkle leaf index ${leafIndex} is outside a tree of ${nodes.length} leaves`,
    )
  }
  const path: Uint8Array[] = []
  inclusionPath(nodes, leafIndex, 0, nodes.length, path)
  return { leafIndex, treeSize: nodes.length, path: path.map(toLedgerHash) }
}

/**
 * Consistency proof that the first `oldSize` leaves are the tree of that size
 * (RFC 9162 §2.1.4.1). Sizes 0 and `leaves.length` need no path.
 */
export function merkleConsistencyProof(
  leaves: readonly LedgerHash[],
  oldSize: number,
): MerkleConsistencyProof {
  const nodes = decodeLeaves(leaves)
  if (!Number.isSafeInteger(oldSize) || oldSize < 0 || oldSize > nodes.length) {
    throw new ValidationError(
      `merkle old size ${oldSize} is outside a tree of ${nodes.length} leaves`,
    )
  }
  const path: Uint8Array[] = []
  if (oldSize > 0 && oldSize < nodes.length) subproof(nodes, oldSize, 0, nodes.length, true, path)
  return { oldSize, newSize: nodes.length, path: path.map(toLedgerHash) }
}

/** Check that `leaf` is in the tree with `root` at the proof's index (RFC 9162 §2.1.3.2). */
export function verifyMerkleInclusion(
  leaf: LedgerHash,
  proof: MerkleInclusionProof,
  root: LedgerHash,
): MerkleVerification {
  const { leafIndex, treeSize } = proof
  if (!isSize(treeSize) || !isSize(leafIndex) || leafIndex >= treeSize) {
    return refused(`leaf index ${leafIndex} is outside a tree of ${treeSize} leaves`)
  }
  const decoded = decodeAll([leaf, root, ...proof.path])
  if (decoded === undefined) return refused('proof carries a malformed hash')
  const [leafBytes, rootBytes, ...path] = decoded as [Uint8Array, Uint8Array, ...Uint8Array[]]
  let fn = leafIndex
  let sn = treeSize - 1
  let r = leafBytes
  for (const p of path) {
    if (sn === 0) return refused('proof path is longer than the tree is deep')
    if (fn % 2 === 1 || fn === sn) {
      r = node(p, r)
      if (fn % 2 === 0) {
        while (fn % 2 === 0 && fn !== 0) {
          fn = Math.floor(fn / 2)
          sn = Math.floor(sn / 2)
        }
      }
    } else {
      r = node(r, p)
    }
    fn = Math.floor(fn / 2)
    sn = Math.floor(sn / 2)
  }
  if (sn !== 0) return refused('proof path is shorter than the tree is deep')
  return equal(r, rootBytes) ? { verified: true } : refused('leaf does not hash to the root')
}

/** Check that the tree with `newRoot` extends the tree with `oldRoot` (RFC 9162 §2.1.4.2). */
export function verifyMerkleConsistency(
  proof: MerkleConsistencyProof,
  oldRoot: LedgerHash,
  newRoot: LedgerHash,
): MerkleVerification {
  const { oldSize, newSize } = proof
  if (!isSize(oldSize) || !isSize(newSize) || oldSize > newSize) {
    return refused(`old size ${oldSize} does not precede new size ${newSize}`)
  }
  const decoded = decodeAll([oldRoot, newRoot, ...proof.path])
  if (decoded === undefined) return refused('proof carries a malformed hash')
  const [oldBytes, newBytes, ...given] = decoded as [Uint8Array, Uint8Array, ...Uint8Array[]]
  if (oldSize === 0 || oldSize === newSize) {
    if (given.length !== 0) return refused('a trivial consistency proof must be empty')
    if (oldSize === 0) {
      return oldRoot === MERKLE_EMPTY_ROOT
        ? { verified: true }
        : refused('the empty tree has a different root')
    }
    return equal(oldBytes, newBytes)
      ? { verified: true }
      : refused('equal sizes with different roots')
  }
  const path = isPowerOfTwo(oldSize) ? [oldBytes, ...given] : given
  if (path.length === 0) return refused('consistency proof is empty')
  let fn = oldSize - 1
  let sn = newSize - 1
  while (fn % 2 === 1) {
    fn = Math.floor(fn / 2)
    sn = Math.floor(sn / 2)
  }
  let fr = path[0] as Uint8Array
  let sr = fr
  for (const c of path.slice(1)) {
    if (sn === 0) return refused('proof path is longer than the tree is deep')
    if (fn % 2 === 1 || fn === sn) {
      fr = node(c, fr)
      sr = node(c, sr)
      if (fn % 2 === 0) {
        while (fn % 2 === 0 && fn !== 0) {
          fn = Math.floor(fn / 2)
          sn = Math.floor(sn / 2)
        }
      }
    } else {
      sr = node(sr, c)
    }
    fn = Math.floor(fn / 2)
    sn = Math.floor(sn / 2)
  }
  if (sn !== 0) return refused('proof path is shorter than the tree is deep')
  if (!equal(fr, oldBytes)) return refused('proof does not rebuild the old root')
  if (!equal(sr, newBytes)) return refused('proof does not rebuild the new root')
  return { verified: true }
}

function subtreeRoot(nodes: readonly Uint8Array[], start: number, end: number): Uint8Array {
  if (end - start === 1) return nodes[start] as Uint8Array
  const k = largestPowerOfTwoBelow(end - start)
  return node(subtreeRoot(nodes, start, start + k), subtreeRoot(nodes, start + k, end))
}

function inclusionPath(
  nodes: readonly Uint8Array[],
  index: number,
  start: number,
  end: number,
  path: Uint8Array[],
): void {
  if (end - start === 1) return
  const k = largestPowerOfTwoBelow(end - start)
  if (index < start + k) {
    inclusionPath(nodes, index, start, start + k, path)
    path.push(subtreeRoot(nodes, start + k, end))
  } else {
    inclusionPath(nodes, index, start + k, end, path)
    path.push(subtreeRoot(nodes, start, start + k))
  }
}

function subproof(
  nodes: readonly Uint8Array[],
  oldSize: number,
  start: number,
  end: number,
  complete: boolean,
  path: Uint8Array[],
): void {
  if (end - start === oldSize) {
    if (!complete) path.push(subtreeRoot(nodes, start, end))
    return
  }
  const k = largestPowerOfTwoBelow(end - start)
  if (oldSize <= k) {
    subproof(nodes, oldSize, start, start + k, complete, path)
    path.push(subtreeRoot(nodes, start + k, end))
  } else {
    subproof(nodes, oldSize - k, start + k, end, false, path)
    path.push(subtreeRoot(nodes, start, start + k))
  }
}

function node(left: Uint8Array, right: Uint8Array): Uint8Array {
  return fromHex(digest(NODE_PREFIX, left, right).slice('sha256:'.length))
}

function digest(prefix: number, ...parts: Uint8Array[]): LedgerHash {
  const length = parts.reduce((total, part) => total + part.length, 1)
  const bytes = new Uint8Array(length)
  bytes[0] = prefix
  let offset = 1
  for (const part of parts) {
    bytes.set(part, offset)
    offset += part.length
  }
  return sha256Bytes(bytes) as LedgerHash
}

function decodeLeaves(leaves: readonly LedgerHash[]): Uint8Array[] {
  const decoded = decodeAll(leaves)
  if (decoded === undefined) {
    throw new ValidationError('merkle leaves must be sha256:<64 lowercase hex> hashes')
  }
  return decoded
}

function decodeAll(hashes: readonly string[]): Uint8Array[] | undefined {
  const out: Uint8Array[] = []
  for (const hash of hashes) {
    if (typeof hash !== 'string' || !LEDGER_HASH_PATTERN.test(hash)) return undefined
    out.push(fromHex(hash.slice('sha256:'.length)))
  }
  return out
}

function toLedgerHash(bytes: Uint8Array): LedgerHash {
  return `sha256:${toHex(bytes)}`
}

function largestPowerOfTwoBelow(n: number): number {
  let k = 1
  while (k * 2 < n) k *= 2
  return k
}

function isPowerOfTwo(n: number): boolean {
  if (n < 1) return false
  let m = n
  while (m % 2 === 0) m /= 2
  return m === 1
}

function isSize(n: number): boolean {
  return Number.isSafeInteger(n) && n >= 0
}

function equal(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

function refused(reason: string): MerkleVerification {
  return { verified: false, reason }
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function fromHex(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i++) bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return bytes
}
