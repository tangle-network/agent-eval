/**
 * @packageDocumentation
 *
 * Generic append-only journal machinery: canonical-JSON SHA-256 hash chain,
 * idempotent append, chain verification, replay-to-projection, cross-process
 * locking, and fsync discipline. Domain vocabulary (entry schemas, error
 * taxonomy, state machine) is supplied by each consumer's codec — see
 * `src/campaign/search-ledger.ts` for the campaign binding.
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
  FileLedgerJournal,
  hashCanonical,
  type LedgerAppendResult,
  type LedgerChainFields,
  type LedgerEntryOf,
  type LedgerEventBase,
  type LedgerHash,
  type LedgerJournalCodec,
  type LedgerLineContext,
  type LedgerProjector,
  type LedgerReplayResult,
} from './journal'
export {
  appendLedgerLine,
  type FileLockResult,
  type LedgerFileContext,
  tryWithLedgerFileLock,
  withLedgerFileLock,
} from './journal-file'
