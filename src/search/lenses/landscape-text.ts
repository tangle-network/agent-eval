/** Render the checked landscape data and its supported grid as compact text. */
import { type GeometryLensResult, plural } from './geometry'
import type { LandscapeData, LandscapeGrid } from './landscape-contract'

const SHADES = ' .:-=+*#%@'

/** The landscape as text for a terminal or a proposer's context: the same
 * numbers the view draws, with a coarse shaded map. */
export function formatLandscape(lens: GeometryLensResult<LandscapeData>): string {
  const { data } = lens
  const lines: string[] = []
  const { embedding } = data
  lines.push(
    `Landscape (${data.split} split, larger is better; ${embedding.name}: ${embedding.method})`,
  )
  lines.push(
    `  placed ${embedding.placed} of ${embedding.placed + embedding.unplaced} nodes by landmark MDS on ${plural(embedding.landmarks, 'landmark')}${embedding.landmarkDistance ? ` (landmarks lie a median ${fixed(embedding.landmarkDistance.median)} and at most ${fixed(embedding.landmarkDistance.max)} apart)` : ''}; two axes hold ${percent(embedding.explained)} of the positive eigenvalue mass (negative mass ${percent(embedding.negativeMass)})`,
  )
  const reasons = new Map<string, number>()
  for (const node of data.nodes) {
    if (node.unplaced) reasons.set(node.unplaced, (reasons.get(node.unplaced) ?? 0) + 1)
  }
  for (const [reason, count] of reasons) lines.push(`  unplaced ${count}: ${reason}`)
  const methods = new Map<string, number>()
  for (const node of data.nodes) methods.set(node.method, (methods.get(node.method) ?? 0) + 1)
  lines.push(
    `  scores (improvement over the root on shared units): ${[
      'bootstrap',
      'descriptive',
      'insufficient',
      'none',
    ]
      .map((method) => `${methods.get(method) ?? 0} ${method}`)
      .join(', ')}`,
  )
  if (data.grid === null) {
    lines.push(`  surface: insufficient: ${data.gridInsufficient}`)
  } else {
    const { grid } = data
    lines.push(
      `  surface: ${grid.columns}×${grid.rows} grid kriged from ${plural(grid.model.fitNodes, 'node')} (mean ${signed(grid.model.mean)}, prior sd ${fixed(Math.sqrt(grid.model.priorVariance))}, length scale ${fixed(grid.model.lengthScale)}); ${grid.supportedCells} of ${grid.columns * grid.rows} cells supported (posterior variance at most half the prior)`,
    )
  }
  const { basins } = data
  if (basins.count === null) {
    lines.push(`  basins: insufficient: ${basins.insufficient}`)
  } else {
    lines.push(
      `  basins: ${basins.count} on the ${basins.neighbours}-nearest-neighbour graph of ${plural(basins.graphNodes, 'node')} in ${basins.graphAxes} MDS axes holding ${percent(basins.graphExplained)} of the distance structure (a lower peak counts when it stands ${fixed(basins.z!)} standard errors of the difference above its saddle, Bonferroni over ${basins.localMaxima} local ${basins.localMaxima === 1 ? 'maximum' : 'maxima'} at 5%)`,
    )
    basins.peaks.forEach((basin, index) => {
      const standing =
        basin.persistence === null
          ? index === 0
            ? 'the highest'
            : 'a separate region of the graph'
          : `persistence ${fixed(basin.persistence)} ≥ ${fixed(basin.threshold!)} over saddle ${basin.saddle}`
      lines.push(
        `    ${index + 1}. ${basin.peak.nodeId} ${signed(basin.peak.score)} on ${basin.peak.pairs} units at (${fixed(basin.peak.x)}, ${fixed(basin.peak.y)}), ${standing}; ${plural(basin.nodes, 'node')}`,
      )
    })
  }
  const { plateau } = data
  if (plateau.value === null) {
    lines.push(`  plateau: insufficient: ${plateau.insufficient}`)
  } else {
    const verdict = plateau.value < 1 ? 'on a plateau' : 'still climbing'
    lines.push(
      `  plateau: ${fixed(plateau.value)}: the best improvement over the root rose ${signed(plateau.rise!)} across the last ${plateau.window} of ${plateau.accepted} accepted nodes, one standard error ${fixed(plateau.noise!)} (best ${plateau.best!.nodeId} on ${plateau.best!.pairs} units, ${plateau.degreesOfFreedom} pooled df): ${verdict}`,
    )
  }
  if (data.grid !== null) {
    const { grid } = data
    const present = grid.values.flat().filter((value): value is number => value !== null)
    const low = Math.min(...present)
    const high = Math.max(...present)
    const marks = new Map<number, string>()
    basins.peaks.forEach((basin, index) => {
      const cell = cellOf(grid, basin.peak.x, basin.peak.y)
      if (cell !== null) marks.set(cell, String((index + 1) % 10))
    })
    lines.push(
      `  map (top row is the highest y; shade ${JSON.stringify(SHADES)} runs from ${signed(low)} to ${signed(high)}; digits mark each basin's peak node):`,
    )
    for (let r = grid.rows - 1; r >= 0; r--) {
      let row = ''
      for (let c = 0; c < grid.columns; c++) {
        const mark = marks.get(r * grid.columns + c)
        const value = grid.values[r]![c]
        if (mark) row += mark
        else if (value === null || value === undefined) row += ' '
        else {
          const level = high > low ? (value - low) / (high - low) : 0.5
          row += SHADES[Math.min(SHADES.length - 1, Math.floor(level * SHADES.length))]!
        }
      }
      lines.push(`    |${row}|`)
    }
  }
  return lines.join('\n')
}

function percent(value: number | null): string {
  return value === null ? 'unknown' : `${Math.round(value * 1000) / 10}%`
}

export function fixed(value: number): string {
  return value.toFixed(3)
}

function signed(value: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(3)}`
}

function cellOf(grid: LandscapeGrid, x: number, y: number): number | null {
  const c = Math.min(
    grid.columns - 1,
    Math.max(0, Math.floor(((x - grid.x[0]) / (grid.x[1] - grid.x[0])) * grid.columns)),
  )
  const r = Math.min(
    grid.rows - 1,
    Math.max(0, Math.floor(((y - grid.y[0]) / (grid.y[1] - grid.y[0])) * grid.rows)),
  )
  return grid.values[r]![c] === null ? null : r * grid.columns + c
}
