import { join } from 'node:path'

export const TB2 = '/home/drew/bench-cache/terminal-bench-2'

export const WORK = '/home/drew/bench-cache/gated-stop-ab'

export const ROWS_PATH = join(WORK, 'rows-decoded.json')

export const TASK_ORACLES_PATH = join(import.meta.dirname, '../..', 'benchmarks', 'trace-repair', 'task-oracles.json')

/**
 * z.ai coding plan, OpenAI-compatible. The seat this run is entitled to.
 *
 * The id is pinned to what the seat serves, not to what it accepts. The seat
 * accepts the retired glm-5.2 id and answers it with glm-5.3, so pinning the
 * retired id registers a model the run never uses. The `servedModel` gate reads
 * the id the seat reports on the reply and aborts on any disagreement.
 */
export const MODEL = 'glm-5.3'

export const BASE_URL = 'https://api.z.ai/api/coding/paas/v4/chat/completions'

export const PRICING = { inputUsdPerMillion: 0.6, outputUsdPerMillion: 2.2 }

/** At most three in flight on this seat, so a 429 storm cannot be mistaken for a slow model. */
export const SEAT_CONCURRENCY = 3

/** A dead transport must read as dead in seconds, not in a hung run. */
export const MODEL_DEADLINE_MS = 180_000

export const STEP_TIMEOUT_SECONDS = 30

export const REPLAY_TIMEOUT_MS = 120_000

export const GRADE_TIMEOUT_MS = 420_000

/**
 * The operating ceiling for the confirmatory run.
 *
 * A ceiling that stops an arm part way leaves rows with a control run and no
 * treatment run, and the registered estimand scores that pair as a zero
 * difference. That dilutes the contrast toward null, so the ceiling is set
 * above the draw's projected spend rather than at it.
 */
export const COST_CEILING_USD = 40

/** Per-row model steps the blind arm spends whatever the check says. */
export const STEP_ALLOTMENT = 8

/**
 * Rows a task must carry before it is a cluster.
 *
 * Two is the smallest that lets a cluster vary. It is a floor on the cluster,
 * not a cap on the draw: the confirmatory selection takes every admitted row,
 * because a structure that drops admitted rows loses the power they carry and
 * the drop would have to be registered as a rule of its own.
 */
export const ROWS_PER_CLUSTER = 2

/**
 * Strata a row may carry.
 *
 * A signal kill ends on a command the environment stopped, and substituting one
 * command does not address a timeout, so the substrate's admission excludes it
 * by default and this study reads the same rule.
 */
export const ADMITTED_STRATA: readonly string[] = ['clean-exit', 'command-error']
