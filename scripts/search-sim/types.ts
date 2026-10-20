import { type SearchOpenedEvent } from '../../src/campaign/search-ledger-types'
import { type SkillCalibration } from '../../src/search/lenses/skill-manifold'

export interface SimArtifact {
  name: string
  quality: number
  /** Added to train scores only. */
  trainShift: number
  /** Added to selection and test scores. */
  heldShift: number
  /** Every cell fails as the agent's defect (`--defect-rate`). */
  defective?: boolean
  /** Latent skills under `--skills K`: a cell's expected score is 0.5 plus
   * these loaded on its task's demand. Absent otherwise. */
  skill?: number[]
  /** The lineage's basin under `--ceiling`: 0 is the root's, and each draft
   * starts its own. Absent otherwise. */
  basin?: number
  /** Profile text under the geometry options: each child edits a line of
   * its parent's and a draft writes its own, so the landscape lens measures
   * line edits between surfaces. Absent otherwise. */
  lines?: string[]
}

export interface SimOptions {
  /** The search's id. Default `search-sim`. */
  searchId?: string
  /** The cell attempt of an outer search whose execution runs this search. */
  containment?: SearchOpenedEvent['containment']
  /** The expansion policy. Default `incumbent`; `draft-on-plateau` wraps
   * `incumbent` in `draftOnPlateau`. */
  policy?: SimPolicy
  seed: number
  train: number
  selection: number
  test: number
  reps: number
  population: number
  expansions: number
  capacity: number
  maxUsd: number | null
  claimUsd: number
  cellUsd: number
  costCap: 'hard' | 'estimate'
  faultRate: number
  delayMs: number
  patience: number | undefined
  /** `incumbent`'s lead margin, in the score's units. */
  minImprovement: number | undefined
  /** ISO time after which the search stops expanding and cancels waiting cells. */
  deadline: string | null
  minEffect: number | undefined
  nullSteps: boolean
  plantGain: number | null
  plantDivergence: boolean
  /** Null: the judge is not pinned. */
  judgeRevision: number | null
  /** Pass/fail cells scoring 0 or 1. */
  binary: boolean
  /** The objective is minimized; a cell reports 1 minus its score. */
  minimize: boolean
  /** A cell's actual cost relative to the lane prior. */
  costScale: number
  allocation: 'uniform' | 'asha' | 'asha-adaptive'
  beamWidth: number
  /** The most cells the search may allocate; null: no cell cap. */
  maxCells: number | null
  /** The gain planted at `deepDepth` of one lineage; null: no deep plant. */
  deepGain: number | null
  deepDepth: number
  /** Path nodes gain `deepGain / deepDepth` each instead of 0. */
  deepRamp: boolean
  /** Share of proposed children whose cells fail as defects. */
  defectRate: number
  /** The planted pool's gap; null: the hill climb's seeded steps. */
  poolGap: number | null
  /** The planted child's registration index; null: seeded from the seed. */
  poolPlant: number | null
  /** Latent skill axes (0: the additive objective). Axis 0 is general, every
   * task loads it; each task also loads one specialist axis. */
  skills: number
  /** Under `--skills`, how far pool candidates spread on each specialist
   * axis: a seeded value in [-spread, 0). Default 0.12. */
  skillSpread: number
  /** Seeds the task bank (demands and task terms) under `--skills`, so
   * searches with different seeds share one bank. */
  bankSeed: number
  /** Under the additive objective, the quality a root-lineage child cannot
   * pass; a draft's lineage can climb 0.25 higher. Null: no ceiling. */
  ceiling: number | null
  /** Unit loadings `asha-adaptive` extends rungs with. */
  calibration: SkillCalibration | null
}

export const SIM_POLICIES = ['incumbent', 'crowded-frontier', 'draft-on-plateau', 'aide', 'beam'] as const

export type SimPolicy = (typeof SIM_POLICIES)[number]

export function isSimPolicy(value: unknown): value is SimPolicy {
  return SIM_POLICIES.includes(value as SimPolicy)
}
