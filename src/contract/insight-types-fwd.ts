/**
 * Forward type re-export so `insight-report.ts` doesn't pull the entire
 * judge-calibration module's runtime surface into the LAND-tier contract
 * type graph.
 */

export type { ContinuousAgreement } from '../judge-calibration'
