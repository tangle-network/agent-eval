/**
 * @packageDocumentation
 *
 * Generic append-only journal machinery: RFC 8785 canonical-JSON SHA-256 hash
 * chain, idempotent append, chain verification, trusted-head pinning,
 * replay-to-projection, cross-process locking, and fsync discipline, plus
 * RFC 9162 Merkle inclusion and consistency proofs that check one entry or one
 * checkpoint without reading the rest of a log. Domain
 * vocabulary (entry schemas, error taxonomy, state machine) is supplied by each
 * consumer's codec — see `src/campaign/search-ledger.ts` for the campaign
 * binding.
 */

export {
  type AtomicFileLock,
  type AtomicFileLockAcquisition,
  AtomicFileLockError,
  type AtomicFileLockOptions,
  type AtomicFileLockOwner,
  type AtomicFileLockUnavailable,
  probeAtomicFileLock,
  tryAcquireAtomicFileLock,
} from './atomic-file-lock'
export {
  canonicalString,
  hashCanonical,
  jsonDocument,
  LEDGER_HASH_PATTERN,
  LedgerCanonicalizationError,
  type LedgerHash,
} from './canonical'
export {
  FileLedgerJournal,
  type FileLedgerJournalOptions,
  type LedgerAppendOptions,
  type LedgerAppendResult,
  type LedgerChainFields,
  type LedgerEntryOf,
  type LedgerEventBase,
  type LedgerJournalCodec,
  type LedgerLineContext,
  type LedgerProjector,
  type LedgerProjectorSnapshotCodec,
  type LedgerTextStore,
  MemoryLedgerJournal,
  replayLedgerText,
} from './journal'
export {
  appendLedgerLine,
  type FileLockResult,
  type LedgerFileContext,
  tryWithLedgerFileLock,
  withLedgerFileLock,
  writeLedgerFileAtomically,
} from './journal-file'
export {
  MERKLE_EMPTY_ROOT,
  type MerkleConsistencyProof,
  type MerkleInclusionProof,
  type MerkleVerification,
  merkleConsistencyProof,
  merkleInclusionProof,
  merkleLeafHash,
  merkleRoot,
  merkleSalt,
  verifyMerkleConsistency,
  verifyMerkleInclusion,
} from './merkle'
export {
  type LedgerProjectorSnapshot,
  projectorSnapshotPathFor,
  readProjectorSnapshotFile,
} from './projector-snapshot'
export {
  type LedgerAnchoredEntry,
  type LedgerTrustedHead,
  type LedgerTrustedHeadRemoval,
  type LedgerTrustedHeadSubject,
  readTrustedHeadFile,
  trustedHeadPathFor,
  verifyEntriesAgainstTrustedHead,
} from './trusted-head'
