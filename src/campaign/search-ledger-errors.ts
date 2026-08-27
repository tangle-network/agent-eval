import { ValidationError } from '../errors'

export class SearchLedgerError extends ValidationError {}

export class SearchLedgerIntegrityError extends SearchLedgerError {}

export class SearchLedgerConflictError extends SearchLedgerError {}
