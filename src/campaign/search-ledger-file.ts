/** Campaign binding of the generic journal file layer to search-ledger errors. */

import { appendLedgerLine } from '../ledger-core/journal-file'
import {
  type FileLockResult,
  type LedgerFileContext,
  tryWithLedgerFileLock,
} from '../ledger-core'
import { SearchLedgerIntegrityError } from './search-ledger-errors'

export const SEARCH_LEDGER_FILE_CONTEXT: LedgerFileContext = {
  subject: 'search ledger',
  integrityError: (message, options) => new SearchLedgerIntegrityError(message, options),
}

export function appendSearchLedgerLine(path: string, line: string): void {
  appendLedgerLine(path, line, SEARCH_LEDGER_FILE_CONTEXT)
}



export type { FileLockResult }

export function tryWithSearchLedgerFileLock<T>(
  ledgerPath: string,
  run: () => T,
): FileLockResult<T> {
  return tryWithLedgerFileLock(ledgerPath, SEARCH_LEDGER_FILE_CONTEXT, run)
}
