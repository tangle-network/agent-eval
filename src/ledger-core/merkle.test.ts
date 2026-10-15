import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { ValidationError } from '../errors'
import {
  type LedgerHash,
  MERKLE_EMPTY_ROOT,
  merkleConsistencyProof,
  merkleInclusionProof,
  merkleLeafHash,
  merkleRoot,
  merkleSalt,
  verifyMerkleConsistency,
  verifyMerkleInclusion,
} from './index'

// The leaves Certificate Transparency implementations test RFC 6962/9162 trees
// with, and the root of each prefix of them.
const CT_LEAVES = [
  '',
  '00',
  '10',
  '2021',
  '3031',
  '40414243',
  '5051525354555657',
  '606162636465666768696a6b6c6d6e6f',
]
const CT_ROOTS = [
  'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  '6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d',
  'fac54203e7cc696cf0dfcb42c92a1d9dbaf70ad9e621f4bd8d98662f00e3c125',
  'aeb6bcfe274b70a14fb067a5e5578264db0fa9b51af5e0ba159158f329e06e77',
  'd37ee418976dd95753c1c73862b9398fa2a2cf9b4ff0fdfe8b30cd95209614b7',
  '4e3bbb1f7b478dcfe71fb631631519a3bca12c9aefca1612bfce4c13a86264d4',
  '76e67dadbcdf1e10e1b74ddc608abd2f98dfb16fbce75277b5232a127f2087ef',
  'ddb89be403809e325750d3d263cd78929c2942b7942a34b77e122c9594a74c8c',
  '5dc9da79a70659a9ad559cb701ded9a2ab9d823aad2f4960cfe370eff4604328',
]

function bytes(hex: string): Uint8Array {
  return Uint8Array.from(Buffer.from(hex, 'hex'))
}

function flip(hash: LedgerHash): LedgerHash {
  const last = hash.at(-1) === '0' ? '1' : '0'
  return `${hash.slice(0, -1)}${last}` as LedgerHash
}

/** Distinct leaves: each content carries its own index, so no two positions share a hash. */
const distinctLeaves = fc
  .array(fc.uint8Array({ maxLength: 24 }), { minLength: 1, maxLength: 70 })
  .map((contents) =>
    contents.map((content, index) => merkleLeafHash(Uint8Array.of(index, ...content))),
  )

describe('Merkle tree (RFC 9162)', () => {
  it('matches the Certificate Transparency reference roots', () => {
    const leaves = CT_LEAVES.map((hex) => merkleLeafHash(bytes(hex)))
    expect(MERKLE_EMPTY_ROOT).toBe(`sha256:${CT_ROOTS[0]}`)
    for (let size = 0; size <= leaves.length; size++) {
      expect(merkleRoot(leaves.slice(0, size))).toBe(`sha256:${CT_ROOTS[size]}`)
    }
  })

  it('proves every leaf, and refuses a wrong leaf, index, path, or root', () => {
    fc.assert(
      fc.property(distinctLeaves, fc.nat(), (leaves, pick) => {
        const root = merkleRoot(leaves)
        const index = pick % leaves.length
        const proof = merkleInclusionProof(leaves, index)
        const leaf = leaves[index] as LedgerHash
        expect(verifyMerkleInclusion(leaf, proof, root)).toEqual({ verified: true })
        expect(proof.path.length).toBeLessThanOrEqual(Math.ceil(Math.log2(leaves.length)))
        expect(verifyMerkleInclusion(flip(leaf), proof, root).verified).toBe(false)
        expect(verifyMerkleInclusion(leaf, proof, flip(root)).verified).toBe(false)
        if (leaves.length > 1) {
          const moved = { ...proof, leafIndex: (index + 1) % leaves.length }
          expect(verifyMerkleInclusion(leaf, moved, root).verified).toBe(false)
          const path = [...proof.path]
          const at = pick % path.length
          path[at] = flip(path[at] as LedgerHash)
          expect(verifyMerkleInclusion(leaf, { ...proof, path }, root).verified).toBe(false)
        }
      }),
    )
  })

  it('proves a larger tree extends a smaller one, and refuses a rewritten prefix', () => {
    fc.assert(
      fc.property(distinctLeaves, fc.nat(), fc.nat(), (leaves, pickOld, pickEdit) => {
        const oldSize = pickOld % (leaves.length + 1)
        const oldRoot = merkleRoot(leaves.slice(0, oldSize))
        const proof = merkleConsistencyProof(leaves, oldSize)
        expect(verifyMerkleConsistency(proof, oldRoot, merkleRoot(leaves))).toEqual({
          verified: true,
        })
        if (oldSize > 0) {
          const rewritten = [...leaves]
          const at = pickEdit % oldSize
          rewritten[at] = flip(rewritten[at] as LedgerHash)
          const forged = merkleConsistencyProof(rewritten, oldSize)
          expect(verifyMerkleConsistency(forged, oldRoot, merkleRoot(rewritten)).verified).toBe(
            false,
          )
        }
      }),
    )
  })

  it('verifies a revealed event while a redacted one ships only as its salted hash', () => {
    const events = ['{"tool":"steer_agent","to":"child-2"}', 'OPENAI_API_KEY=sk-not-real']
    const salts = events.map(() => merkleSalt())
    const leaves = events.map((event, index) => merkleLeafHash(event, salts[index]))
    const root = merkleRoot(leaves)

    // The verifier gets event 0 with its salt, and only the hash of event 1.
    const revealed = merkleLeafHash(events[0] as string, salts[0])
    expect(verifyMerkleInclusion(revealed, merkleInclusionProof(leaves, 0), root)).toEqual({
      verified: true,
    })
    expect(merkleRoot([revealed, leaves[1] as LedgerHash])).toBe(root)
    // Without the salt, guessing the redacted content does not reproduce its hash.
    expect(merkleLeafHash(events[1] as string)).not.toBe(leaves[1])
  })

  it('returns refusals for malformed proofs and throws only on malformed builder input', () => {
    const leaves = ['a', 'b', 'c'].map((content) => merkleLeafHash(content))
    const root = merkleRoot(leaves)
    const proof = merkleInclusionProof(leaves, 2)
    expect(verifyMerkleInclusion(leaves[2] as LedgerHash, { ...proof, treeSize: 2 }, root)).toEqual(
      { verified: false, reason: 'leaf index 2 is outside a tree of 2 leaves' },
    )
    expect(verifyMerkleInclusion('sha256:zz' as LedgerHash, proof, root).verified).toBe(false)
    expect(verifyMerkleConsistency({ oldSize: 3, newSize: 2, path: [] }, root, root).verified).toBe(
      false,
    )
    expect(() => merkleInclusionProof(leaves, 3)).toThrow(ValidationError)
    expect(() => merkleLeafHash('a', 'not-a-salt')).toThrow(ValidationError)
    expect(() => merkleRoot(['sha256:00' as LedgerHash])).toThrow(ValidationError)
  })
})
