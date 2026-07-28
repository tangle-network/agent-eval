/**
 * @packageDocumentation
 *
 * Generic append-only journal machinery: RFC 8785 canonical-JSON SHA-256 hash
 * chain, idempotent append, chain verification, trusted-head pinning,
 * replay-to-projection, cross-process locking, and fsync discipline. Domain
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
  type LedgerReplayResult,
} from './journal'
export {
  appendLedgerLine,
  type FileLockResult,
  type LedgerFileContext,
  removeLedgerFile,
  tryWithLedgerFileLock,
  withLedgerFileLock,
  writeLedgerFileAtomically,
} from './journal-file'
export {
  clearTrustedHeadFile,
  type LedgerAnchoredEntry,
  type LedgerTrustedHead,
  type LedgerTrustedHeadRemoval,
  type LedgerTrustedHeadSubject,
  readTrustedHeadFile,
  trustedHeadPathFor,
  verifyEntriesAgainstTrustedHead,
} from './trusted-head'
