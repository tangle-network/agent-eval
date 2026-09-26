/**
 * Search lenses (search-tree design §12): pure functions of `SearchState`.
 * Each returns JSON for a view and one named signal a `SearchPolicy` or an
 * allocator can read. No lens renders pixels, and none reads a record type
 * beyond `SearchState`/`SearchStateView`. `agent-eval search show` prints
 * each lens's text form; Intelligence, discovery lab, VerticalBench and
 * agent-runtime `improve()` read the same JSON with no extra code.
 *
 * The geometry group: `landscape` (signal `plateau`, which `draftOnPlateau`
 * reads) and `skillManifold` (signal `nextUnit`, which `asha({ extend:
 * nextUnitExtension(calibration) })` reads).
 */

export type { GeometryLensResult, GeometrySignal } from './geometry'
export { screenedNodes } from './geometry'
export type {
  LandscapeBasin,
  LandscapeData,
  LandscapeEmbedding,
  LandscapeGrid,
  LandscapeNode,
  LandscapeOptions,
} from './landscape'
export {
  formatLandscape,
  landscape,
  lineageEdits,
  lineEditDistance,
  nearestNeighbours,
  profileTextLines,
  surfaceDigestEdits,
  surfaceTextEdits,
  vectorEmbedding,
} from './landscape'
export type { SearchPlateau, SearchPlateauOptions, SearchPlateauView } from './plateau'
export { searchPlateau } from './plateau'
export type {
  SkillCalibration,
  SkillManifoldData,
  SkillManifoldNextUnit,
  SkillManifoldNode,
  SkillManifoldOptions,
  SkillManifoldUnit,
} from './skill-manifold'
export {
  formatSkillManifold,
  nextUnitExtension,
  skillCalibration,
  skillManifold,
} from './skill-manifold'
