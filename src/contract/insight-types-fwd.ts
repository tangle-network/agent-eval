/**
 * Forward type re-export so `insight-report.ts` doesn't pull the entire
 * judge-calibration module's runtime surface into the app-facing contract
 * type graph.
 */

export type { ContinuousAgreement } from '../judge-calibration'
