// The two engine shapes the golden records describe.
//
// Declared apart from the harness so the recorder can load a reference engine
// without importing a fixture, and so a consumer can type its own engine
// against the contract before it wires the check.

import type { RunMultishotMatrixOptions, RunMultishotMatrixResult } from '../matrix'
import type { RunMultishotOptions } from '../multishot'
import type { MultishotPersona, MultishotResult } from '../types'

/** A conversation engine: one profile, one persona, one transcript. */
export type MultishotGoldenEngine = (
  opts: RunMultishotOptions<MultishotPersona>,
) => Promise<MultishotResult>

/** A matrix engine: profile x persona fan-out, judge slots, per-cell files. */
export type MultishotMatrixGoldenEngine = (
  opts: RunMultishotMatrixOptions<MultishotPersona>,
) => Promise<RunMultishotMatrixResult>
