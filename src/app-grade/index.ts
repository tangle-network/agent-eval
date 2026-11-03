/**
 * App Grade: grade a submitted app by operating its running production build.
 *
 * A grading run serves the build, starts the task's real product (a pinned image, or a
 * vendor's hosted test mode), drives buyer journeys in Chromium, runs deterministic checks on
 * evidence the app cannot write, and asks SystemOne only the questions that can still move
 * the tier. The tier ladder (F, U, C, B, A, S) follows from gates, not a weighted blend.
 *
 * Playwright is an optional peer: everything but `EvidenceBrowser.launch` runs without it.
 * The judge is any `ChatClient` the caller builds (`AppGradeJudge`).
 */
export * from './admission'
export * from './browser'
export * from './drive'
export * from './grade'
export * from './integrity'
export * from './judge'
export * from './prepare'
export * from './product'
export * from './review'
export * from './serve'
export * from './source'
export * from './spec'
export * from './spec-leaf'
export * from './systemone-transport'
export * from './task'
export * from './verdict'
