/**
 * The intent record: what a person asked for, the procedure versions that
 * served it, what it cost and how it ended, cut from recorded sessions. See
 * `buildProcedureRegistry` with the `intents` option.
 */

export type {
  IntentClosedBy,
  IntentCost,
  IntentDoneBasis,
  IntentEnd,
  IntentEndEvidence,
  IntentKind,
  IntentKindSummary,
  IntentLabeler,
  IntentRecord,
  IntentReport,
  IntentTurn,
  IntentTurnLabel,
} from './contract'
export { INTENT_KINDS } from './contract'
