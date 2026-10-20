/**
 * The skill-manifold lens: the node × unit score matrix as candidates in a
 * low-dimensional skill space and units as directions in it.
 *
 * Each observed per-unit mean is modelled as `b_u + P_i · Q_u`: a unit's
 * difficulty `b_u`, the node's coordinates `P_i` and the unit's loading `Q_u`,
 * fitted by alternating ridge least squares over the observed cells only
 * (missing cells are masked, never filled). Scores are standardized first,
 * so coordinates and loadings are unitless. Where every cell scores 0 or 1,
 * the data supports an item-response model instead: a unit's passes on a
 * node are binomial with logit `b_u + P_i · Q_u` (a multidimensional
 * two-parameter logistic model: `Q_u` is the unit's discrimination and `b_u`
 * its easiness), fitted by alternating Newton steps on the penalized
 * likelihood. The rank that generalizes is
 * chosen by cross-validation over held-out cells with the one-standard-error
 * rule (Hastie, Tibshirani and Friedman, Elements of Statistical Learning,
 * §7.10): the intrinsic dimension. Rank 0 means the nodes do not differ
 * beyond noise; rank 1 is one ability axis; more axes mean specialists.
 *
 * The signal is `nextUnit`: the unit whose next cell, run on every leader,
 * removes the largest expected share of the variance of the leaders'
 * contrasts on the whole split (the linear-Gaussian posterior of each
 * leader's coordinates, with unit loadings held fixed). An allocator that
 * extends a rung by this unit needs fewer cells per decision when leaders
 * differ along a skill axis only some units test. Inside one search, a unit
 * only the root has run has no loading, so the lens can also take the
 * loadings of an earlier fit (`calibration`) over the same units: calibrate
 * once, then test adaptively.
 */

import type { SearchUnitExtension } from '../../campaign/allocation'
import type { SearchStateView } from '../../campaign/search-state'
import { hashCanonical } from '../../ledger-core/canonical'
import {
  evenSample,
  type GeometryLensResult,
  type GeometrySignal,
  headSequence,
  plural,
  positiveInteger,
  round9,
} from './geometry'
import { INSUFFICIENT_FROM, rankingSplit } from './shared'
import {
  METHODS,
  type SkillCalibration,
  type SkillLink,
  type SkillManifoldData,
  type SkillManifoldNode,
  type SkillManifoldOptions,
  type SkillManifoldUnit,
} from './skill-manifold-contract'
import { observedCells, scoreMatrix, standardization } from './skill-manifold-matrix'
import {
  dot,
  type Fit,
  factor,
  logistic,
  loss,
  orientAxes,
  placeRows,
  principalAxes,
} from './skill-manifold-model'
import { nextUnits } from './skill-manifold-selection'
import { crossValidate } from './skill-manifold-validation'

export type {
  SkillCalibration,
  SkillLink,
  SkillManifoldData,
  SkillManifoldNextUnit,
  SkillManifoldNode,
  SkillManifoldOptions,
  SkillManifoldUnit,
} from './skill-manifold-contract'

// ── The lens ─────────────────────────────────────────────────────────

/**
 * The skill manifold of a search at rank `k` (`auto`: the cross-validated
 * intrinsic dimension, at least 1, and 1 when too few nodes cross-validate).
 * Pure: it reads the state, and `calibration` when given.
 */
export function skillManifold(
  state: SearchStateView,
  k: number | 'auto' = 'auto',
  options: SkillManifoldOptions = {},
): GeometryLensResult<SkillManifoldData> {
  const maxRank = positiveInteger('skillManifold', 'maxRank', options.maxRank ?? 4)
  const folds = positiveInteger('skillManifold', 'folds', options.folds ?? 5)
  if (folds < 2) throw new TypeError(`skillManifold: folds must be at least 2, got ${folds}`)
  const leaderCount = positiveInteger('skillManifold', 'leaders', options.leaders ?? 3)
  const ridge = options.ridge ?? 1
  if (!(ridge > 0) || !Number.isFinite(ridge)) {
    throw new TypeError(`skillManifold: ridge must be a positive number, got ${String(ridge)}`)
  }
  const sampleRows = positiveInteger('skillManifold', 'sampleRows', options.sampleRows ?? 1000)
  if (k !== 'auto') positiveInteger('skillManifold', 'k', k)
  const requested = options.model ?? 'auto'
  if (requested !== 'auto' && requested !== 'linear' && requested !== 'logistic') {
    throw new TypeError(
      `skillManifold: model must be auto, linear or logistic, got ${String(requested)}`,
    )
  }

  const header = state.header
  const split = options.split ?? rankingSplit(state)
  const direction = header?.objective.direction ?? 'maximize'
  const sign = direction === 'maximize' ? 1 : -1
  const calibration = options.calibration ?? null
  const source = calibration?.source ?? `${state.searchId}@${headSequence(state)}`
  let link: SkillLink = calibration?.link ?? (requested === 'logistic' ? 'logit' : 'identity')
  const empty = (reason: string, matrix?: SkillManifoldData['matrix']) =>
    result(state, link, {
      split,
      direction,
      mode: calibration ? 'calibrated' : 'fitted',
      source,
      matrix: matrix ?? {
        rows: 0,
        units: 0,
        observed: 0,
        density: null,
        excludedNodes: 0,
        excludedUnits: 0,
        fitRows: 0,
      },
      model: null,
      explained: null,
      intrinsicDimension: {
        value: null,
        method: METHODS[link].intrinsic,
        n: 0,
        folds,
        curve: [],
        insufficient: reason,
      },
      axes: axesNote(direction),
      noiseVariance: null,
      nodes: [],
      units: [],
      leaders: [],
      nextUnits: [],
      batch: null,
      insufficient: reason,
    })
  if (!header || state.rootNodeId === null) {
    return empty(header ? 'the search has no root node yet' : 'the search has not been opened')
  }

  const matrix = scoreMatrix(state, split, options.asOfSequence, calibration)
  const shape: SkillManifoldData['matrix'] = {
    rows: matrix.rows.length,
    units: matrix.unitIds.length,
    observed: matrix.observed,
    density:
      matrix.rows.length * matrix.unitIds.length > 0
        ? round9(matrix.observed / (matrix.rows.length * matrix.unitIds.length))
        : null,
    excludedNodes: matrix.excludedNodes,
    excludedUnits: matrix.excludedUnits,
    fitRows: 0,
  }
  if (!calibration) {
    if (requested === 'logistic' && !matrix.binary) {
      throw new TypeError(
        'skillManifold: model logistic needs every modelled cell to score 0 or 1; use auto or linear',
      )
    }
    link = requested === 'linear' || !matrix.binary ? 'identity' : 'logit'
  } else if (link === 'logit' && !matrix.binary) {
    return empty(
      `the calibration from ${calibration.source} is an item-response model, and this search has cells that score other than 0 or 1`,
      shape,
    )
  }

  let center: number
  let scale: number
  let fit: Fit
  let rank: number
  let noiseVariance: number | null
  let intrinsic: SkillManifoldData['intrinsicDimension']
  let explained: SkillManifoldData['explained'] = null
  let iterations = 0
  let converged = true

  if (calibration) {
    if (matrix.rows.length === 0 || matrix.unitIds.length === 0) {
      return empty('no node scored a calibrated unit', shape)
    }
    center = calibration.center
    scale = calibration.scale
    rank = calibration.rank
    const byUnit = new Map(calibration.units.map((unit) => [unit.unitId, unit]))
    fit = {
      rank,
      bias: matrix.unitIds.map((unitId) => byUnit.get(unitId)!.bias),
      loadings: matrix.unitIds.map((unitId) => [...byUnit.get(unitId)!.loading]),
      byRow: new Map(),
      coordinates: [],
      iterations: 0,
      converged: true,
    }
    placeRows(matrix, fit, center, scale, calibration.ridge, link)
    noiseVariance = calibration.noiseVariance
    intrinsic = {
      value: null,
      method: METHODS[link].intrinsic,
      n: 0,
      folds,
      curve: [],
      insufficient: `loadings come from ${calibration.source}; its fit decided the rank (${rank})`,
    }
  } else {
    if (matrix.rows.length < 3 || matrix.unitIds.length < INSUFFICIENT_FROM) {
      return empty(
        `${plural(matrix.rows.length, 'node')} and ${plural(matrix.unitIds.length, 'unit')} qualify (a unit counts when 2 or more nodes scored it, a node when it scored 2 or more such units); a manifold needs 3 nodes and ${INSUFFICIENT_FROM} units`,
        shape,
      )
    }
    const standard = standardization(matrix)
    if (standard === null) {
      return empty(
        'every node scores the same on every unit, so there is no variation to factor',
        shape,
      )
    }
    ;({ center, scale } = link === 'logit' ? { center: 0, scale: 1 } : standard)
    const fitRows = evenSample(
      matrix.rows.map((_, index) => index),
      sampleRows,
    )
    shape.fitRows = fitRows.length
    const cells = observedCells(matrix, fitRows, center, scale)
    const rankCap = Math.min(maxRank, matrix.unitIds.length - 1, fitRows.length - 1)
    intrinsic = crossValidate(matrix, cells, rankCap, folds, ridge, link)
    // Under 'auto' without a cross-validated dimension, fit one axis only: a
    // second axis on a handful of nodes fits their noise, and its in-sample
    // R² would read as structure.
    rank = k === 'auto' ? Math.max(1, intrinsic.value ?? 1) : Math.min(k, Math.max(1, rankCap))
    const fits: Fit[] = []
    for (let r = 0; r <= Math.max(rank, rankCap); r++) {
      fits.push(factor(matrix.unitIds.length, cells, r, ridge, link))
    }
    const base = loss(fits[0]!, cells, link)
    explained = {
      byRank: fits.slice(1).map((entry) => ({
        rank: entry.rank,
        r2: round9(base > 0 ? 1 - loss(entry, cells, link) / base : 0),
      })),
      axisShare: [],
      method: METHODS[link].explained,
    }
    fit = fits[rank]!
    iterations = fit.iterations
    converged = fit.converged
    const cv = intrinsic.curve.find((point) => point.rank === rank)
    noiseVariance = link === 'identity' && cv && Number.isFinite(cv.error) ? cv.error : null
    const shares = principalAxes(fit, fitRows)
    explained.axisShare = shares.map(round9)
    fit.coordinates = []
    placeRows(matrix, fit, center, scale, ridge, link)
  }
  orientAxes(fit, sign)

  const unitCount = matrix.unitIds.length
  const meanLoading = new Array<number>(rank).fill(0)
  for (const loading of fit.loadings) {
    for (let d = 0; d < rank; d++) meanLoading[d]! += loading[d]! / unitCount
  }
  const meanBias = fit.bias.reduce((sum, value) => sum + value, 0) / unitCount
  const predicted = (coordinates: readonly number[]): number => {
    if (link === 'identity') return center + scale * (meanBias + dot(coordinates, meanLoading))
    let total = 0
    for (let u = 0; u < unitCount; u++) {
      total += logistic(fit.bias[u]! + dot(coordinates, fit.loadings[u]!))
    }
    return total / unitCount
  }

  const leaderFloor = Math.min(INSUFFICIENT_FROM, unitCount)
  let leaderRows: number[]
  if (options.candidates) {
    const wanted = new Set(options.candidates)
    leaderRows = matrix.rows.flatMap((row, index) => (wanted.has(row.nodeId) ? [index] : []))
  } else {
    // A node decided invalid (a judge integrity or admission failure) never
    // leads: its score may be a reward hack, and cells spent separating it
    // from the real leaders would be wasted (§6.6).
    const eligible = matrix.rows
      .map((row, index) => ({ row, index }))
      .filter(({ row }) => row.observed.size >= leaderFloor && row.status !== 'invalid')
    leaderRows = eligible
      .sort(
        (left, right) =>
          sign *
            (predicted(fit.coordinates[right.index]!) - predicted(fit.coordinates[left.index]!)) ||
          left.row.ordinal - right.row.ordinal,
      )
      .slice(0, leaderCount)
      .map(({ index }) => index)
  }
  const leaderSet = new Set(leaderRows)

  const next =
    intrinsic.value === 0
      ? {
          ranked: [],
          batch: null,
          insufficient:
            'held-out cells fit no better with any skill axis than with unit means alone (intrinsic dimension 0): the nodes do not differ beyond noise, so no unit separates them',
        }
      : !calibration && intrinsic.value === null
        ? {
            ranked: [],
            batch: null,
            insufficient:
              'the skill axes are not cross-validated (see the intrinsic dimension), so no unit’s information is known',
          }
        : nextUnits(
            matrix,
            fit,
            leaderRows,
            noiseVariance,
            calibration?.ridge ?? ridge,
            options.batch ?? null,
            link,
          )
  const nodes: SkillManifoldNode[] = matrix.rows.map((row, index) => ({
    nodeId: row.nodeId,
    ordinal: row.ordinal,
    status: row.status,
    observed: row.observed.size,
    coordinates: fit.coordinates[index]!.map(round9),
    predictedMean: round9(predicted(fit.coordinates[index]!)),
    leader: leaderSet.has(index),
  }))
  const units: SkillManifoldUnit[] = matrix.unitIds.map((unitId, u) => ({
    unitId,
    observedBy: matrix.observedBy[u]!,
    bias: round9(link === 'identity' ? center + scale * fit.bias[u]! : logistic(fit.bias[u]!)),
    intercept: round9(fit.bias[u]!),
    loading: fit.loadings[u]!.map(round9),
    strength: round9(Math.hypot(...fit.loadings[u]!)),
  }))

  return result(state, link, {
    split,
    direction,
    mode: calibration ? 'calibrated' : 'fitted',
    source,
    matrix: shape,
    model: {
      method: METHODS[link].model,
      link,
      rank,
      ridge: calibration?.ridge ?? ridge,
      center: round9(center),
      scale: round9(scale),
      iterations,
      converged,
    },
    explained,
    intrinsicDimension: intrinsic,
    axes: axesNote(direction),
    noiseVariance: noiseVariance === null ? null : round9(noiseVariance),
    nodes,
    units,
    leaders: leaderRows.map((index) => ({
      nodeId: matrix.rows[index]!.nodeId,
      predictedMean: round9(predicted(fit.coordinates[index]!)),
      observed: matrix.rows[index]!.observed.size,
    })),
    nextUnits: next.ranked,
    batch: options.batch ? next.batch : null,
    insufficient: next.insufficient,
  })
}

/** The loadings of a fitted manifold, for a later search over the same units
 * to place its nodes on. Null unless cross-validation found at least one skill
 * axis (intrinsic dimension 1 or more), and, for the linear model, measured
 * the cell noise: loadings of an axis the held-out cells do not support would
 * steer allocation by noise. */
export function skillCalibration(
  lens: GeometryLensResult<SkillManifoldData>,
): SkillCalibration | null {
  const { data } = lens
  const { model } = data
  if (
    data.mode !== 'fitted' ||
    model === null ||
    model.center === null ||
    model.scale === null ||
    (model.link === 'identity' && data.noiseVariance === null) ||
    data.intrinsicDimension.value === null ||
    data.intrinsicDimension.value < 1
  ) {
    return null
  }
  return {
    source: data.source,
    link: model.link,
    center: model.center,
    scale: model.scale,
    rank: model.rank,
    ridge: model.ridge,
    noiseVariance: data.noiseVariance,
    units: data.units.map((unit) => ({
      unitId: unit.unitId,
      bias: unit.intercept,
      loading: [...unit.loading],
    })),
  }
}

function result(
  state: SearchStateView,
  link: SkillLink,
  data: SkillManifoldData,
): GeometryLensResult<SkillManifoldData> {
  const pending = data.nextUnits.filter((unit) => unit.measuredBy < data.leaders.length)
  const best = pending[0] ?? data.nextUnits[0] ?? null
  const signal: GeometrySignal = {
    name: 'nextUnit',
    value: best === null ? null : best.share,
    subject: best?.unitId ?? null,
    method: METHODS[link].nextUnit,
    n: data.leaders.reduce((sum, leader) => sum + leader.observed, 0),
    insufficient: best === null ? (data.insufficient ?? 'no unit to rank') : null,
  }
  return {
    lens: 'skillManifold',
    searchId: state.searchId,
    sequence: headSequence(state),
    data,
    signal,
  }
}

function axesNote(direction: 'maximize' | 'minimize'): string {
  return direction === 'maximize'
    ? 'axes are principal (largest share first) and oriented so the mean unit loads positively: a larger coordinate predicts a higher score'
    : 'axes are principal (largest share first) and oriented so the mean unit loads negatively: a larger coordinate predicts a lower (better) score'
}

/**
 * The `asha` extension that adds, at each rung, the units that best separate
 * the leaders: the greedy `nextUnit` batch from `calibration`'s loadings,
 * with this search's nodes placed on them from the cells the ledger held when
 * the rung opened. The leaders are the lens's (the top 3 by predicted mean on
 * every calibrated unit). Where the lens cannot rank (fewer than 2 leaders,
 * or no measured noise), `asha` fills the rung from its seeded order.
 */
export function nextUnitExtension(
  calibration: SkillCalibration,
  options: { leaders?: number } = {},
): SearchUnitExtension {
  const digest = hashCanonical(calibration).slice('sha256:'.length, 'sha256:'.length + 12)
  return {
    name: `next-unit(${digest})`,
    choose({ state, asOfSequence, split, remaining, count }) {
      const lens = skillManifold(state, calibration.rank, {
        split,
        calibration,
        asOfSequence,
        ...(options.leaders === undefined ? {} : { leaders: options.leaders }),
        batch: { count, among: remaining },
      })
      return lens.data.batch ?? []
    },
  }
}

// ── Text ─────────────────────────────────────────────────────────────

/** The manifold as text for a terminal or a proposer's context. */
export function formatSkillManifold(lens: GeometryLensResult<SkillManifoldData>): string {
  const { data, signal } = lens
  const lines: string[] = []
  const { matrix } = data
  lines.push(
    `Skill manifold (${data.split} split, ${data.mode === 'calibrated' ? `loadings from ${data.source}` : 'loadings fitted here'})`,
  )
  lines.push(
    `  matrix: ${plural(matrix.rows, 'node')} × ${plural(matrix.units, 'unit')}, ${matrix.observed} observed cells (density ${matrix.density === null ? 'unknown' : `${Math.round(matrix.density * 1000) / 10}%`}); left out ${plural(matrix.excludedNodes, 'node')} and ${plural(matrix.excludedUnits, 'unit')}${matrix.fitRows > 0 && matrix.fitRows < matrix.rows ? `; factors fitted on ${matrix.fitRows} evenly spaced rows` : ''}`,
  )
  const { intrinsicDimension: intrinsic } = data
  if (intrinsic.value === null) {
    lines.push(`  intrinsic dimension: insufficient (${intrinsic.insufficient})`)
  } else {
    const curve = intrinsic.curve
      .map(
        (point) => `k=${point.rank} ${point.error.toFixed(3)}±${fixedOrDash(point.standardError)}`,
      )
      .join(', ')
    lines.push(
      `  intrinsic dimension: ${intrinsic.value} (${intrinsic.folds}-fold held-out ${data.model?.link === 'logit' ? 'binomial log loss' : 'squared error on the standardized scale'}, one-SE rule, ${intrinsic.n} held-out cells per rank: ${curve})`,
    )
  }
  if (data.model === null) {
    if (data.insufficient !== intrinsic.insufficient) {
      lines.push(`  model: insufficient (${data.insufficient})`)
    }
    return lines.join('\n')
  }
  const { model } = data
  const explained = data.explained
  const r2 = explained?.byRank.find((entry) => entry.rank === model.rank)?.r2
  const logit = model.link === 'logit'
  lines.push(
    `  model: ${logit ? 'item-response (two-parameter logistic, every cell 0 or 1)' : 'linear on standardized means'}, rank ${model.rank}, ridge ${model.ridge}, ${model.iterations} ${logit ? 'Newton' : 'ALS'} sweeps${model.converged ? '' : ' (not converged)'}${r2 === undefined ? '' : `, in-sample ${logit ? 'pseudo-R²' : 'R²'} ${r2.toFixed(3)} over unit ${logit ? 'easiness' : 'means'}`}${explained && explained.axisShare.length > 0 ? `; axis shares ${explained.axisShare.map((share) => `${Math.round(share * 1000) / 10}%`).join(', ')}` : ''}; ${logit ? 'cell noise binomial' : `cell noise ${data.noiseVariance === null ? 'unknown' : data.noiseVariance.toFixed(3)} (standardized)`}`,
  )
  const strongest = [...data.units]
    .sort((left, right) => right.strength - left.strength)
    .slice(0, 5)
  lines.push(
    `  units that separate nodes most: ${strongest.map((unit) => `${unit.unitId} (${unit.strength.toFixed(2)}, axis ${dominantAxis(unit.loading) + 1})`).join(', ')}`,
  )
  if (data.leaders.length > 0) {
    lines.push(
      `  leaders by predicted split mean: ${data.leaders.map((leader) => `${leader.nodeId} ${leader.predictedMean.toFixed(3)} on ${leader.observed} units`).join('; ')}`,
    )
  }
  if (signal.value === null) {
    lines.push(`  next unit: insufficient (${signal.insufficient})`)
  } else {
    const top = data.nextUnits
      .slice(0, 5)
      .map(
        (unit) =>
          `${unit.unitId} ${(unit.share * 100).toFixed(1)}% (${unit.measuredBy}/${data.leaders.length} measured)`,
      )
      .join(', ')
    lines.push(
      `  next unit: ${signal.subject}, removing an expected ${(signal.value * 100).toFixed(1)}% of the leaders' contrast variance per cell; ranked: ${top}`,
    )
  }
  return lines.join('\n')
}

function dominantAxis(loading: readonly number[]): number {
  let best = 0
  for (let index = 1; index < loading.length; index++) {
    if (Math.abs(loading[index]!) > Math.abs(loading[best]!)) best = index
  }
  return best
}

function fixedOrDash(value: number): string {
  return Number.isFinite(value) ? value.toFixed(3) : '–'
}
