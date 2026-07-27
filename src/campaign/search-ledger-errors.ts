import { ValidationError } from '../errors'

/** Base error for invalid search-ledger input or operations. */
export class SearchLedgerError extends ValidationError {}

/** Error raised when durable search-ledger data fails an integrity check. */
export class SearchLedgerIntegrityError extends SearchLedgerError {}

/** Error raised when an event identifier is reused with different content. */
export class SearchLedgerConflictError extends SearchLedgerError {}
