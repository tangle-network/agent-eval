import { createHash } from 'node:crypto'
import { type SearchCellResult, type SearchCellWork } from '../../src/campaign/search-kernel'
import { type SearchTask } from '../../src/campaign/search-ledger-types'
import { hashCanonical } from '../../src/ledger-core/canonical'
import { type SimArtifact, type SimOptions } from './types'
import { SIM_SOURCE, benchmark } from './policy'

export const ROOT: SimArtifact = { name: 'root', quality: 0.5, trainShift: 0, heldShift: 0 }

/** Uniform [0, 1) from the seed and a key: the simulator's only randomness. */
export function unit(seed: number, ...key: Array<string | number>): number {
  const digest = createHash('sha256')
    .update(JSON.stringify([seed, ...key]))
    .digest()
  return digest.readUInt32BE(0) / 2 ** 32
}

export function round(value: number): number {
  return Math.round(value * 1e9) / 1e9
}

export function tasks(prefix: string, count: number): SearchTask[] {
  return Array.from({ length: count }, (_, index) => ({
    taskId: `${prefix}${index}`,
    unitId: `${prefix}${index}`,
    source: { uri: `sim://task/${prefix}${index}`, revision: hashCanonical([prefix, index]) },
  }))
}

/** The deep plant's path: at each depth, the seeded index of the path child
 * among the first proposal's children of the path node above it. */
function deepPath(options: SimOptions): string[] {
  const names = ['root']
  for (let depth = 1; depth <= options.deepDepth; depth++) {
    const index = Math.floor(unit(options.seed, 'deep', depth) * options.population)
    names.push(`${names[depth - 1]}.${index}`)
  }
  return names
}

/** The name of the node the search should keep: the planted pool child, or
 * the deep plant; null when nothing is planted. */
export function plantedName(options: SimOptions): string | null {
  if (options.poolGap !== null) return `c${plantIndex(options)}`
  if (options.deepGain !== null) return deepPath(options).at(-1)!
  return null
}

/** The geometry options give artifacts profile text. */
function geometric(options: SimOptions): boolean {
  return options.skills > 0 || options.ceiling !== null || options.policy === 'draft-on-plateau'
}

/** The root artifact: the additive default, plus text, skills and a basin
 * under the geometry options. */
export function rootOf(options: SimOptions): SimArtifact {
  if (!geometric(options)) return ROOT
  return {
    ...ROOT,
    lines: Array.from({ length: 8 }, (_, index) => `root line ${index}`),
    ...(options.skills > 0 ? { skill: new Array<number>(options.skills).fill(0) } : {}),
    ...(options.ceiling !== null ? { basin: 0 } : {}),
  }
}

/** A task's demand on each skill axis under `--skills`: axis 0 in [0.6, 1),
 * one specialist axis in [0.8, 1.2), the others 0. Seeded by the bank. */
function demand(options: SimOptions, taskId: string): number[] {
  const vector = new Array<number>(options.skills).fill(0)
  vector[0] = 0.6 + 0.4 * unit(options.bankSeed, 'demand', taskId)
  if (options.skills > 1) {
    const family = 1 + Math.floor(unit(options.bankSeed, 'family', taskId) * (options.skills - 1))
    vector[family] = 0.8 + 0.4 * unit(options.bankSeed, 'load', taskId)
  }
  return vector
}

/** Under `--skills`, an artifact's true quality: 0.5 plus its skills loaded
 * on the mean demand of the selection split, the objective it is ranked on. */
function skillQuality(skill: readonly number[], options: SimOptions): number {
  const selection = tasks('s', options.selection)
  let total = 0
  for (const task of selection) {
    const d = demand(options, task.taskId)
    for (let k = 0; k < skill.length; k++) total += skill[k]! * d[k]!
  }
  return round(0.5 + total / selection.length)
}

/** One line of the parent's text replaced, and sometimes one appended. */
function editLines(parent: readonly string[], name: string, options: SimOptions): string[] {
  const lines = [...parent]
  lines[Math.floor(unit(options.seed, 'edit', name) * lines.length)] = `${name} edit`
  if (unit(options.seed, 'grow', name) < 0.5) lines.push(`${name} addition`)
  return lines
}

/** The planted child's registration index: the option, or a seeded place in the pool. */
function plantIndex(options: SimOptions): number {
  return (
    options.poolPlant ??
    Math.floor(unit(options.seed, 'plant') * options.population * options.expansions)
  )
}

/** A proposed child: the parent's quality plus a seeded step (none under
 * `--null`), with the planted children replacing the step. */
export function childOf(
  parent: SimArtifact,
  name: string,
  options: SimOptions,
  operator: string,
): { artifact: SimArtifact; label: string; rationale: string } {
  if (operator === 'debug' && parent.defective) {
    const artifact: SimArtifact = { ...parent, name, defective: false }
    return { artifact, label: `debug ${name}`, rationale: `fixes the defect of ${parent.name}` }
  }
  if (options.deepGain !== null) return deepChild(parent, name, options)
  let artifact: SimArtifact = {
    name,
    quality: round(
      parent.quality + (options.nullSteps ? 0 : -0.08 + 0.18 * unit(options.seed, 'step', name)),
    ),
    trainShift: parent.trainShift,
    heldShift: parent.heldShift,
    ...defect(name, options),
  }
  if (parent.skill !== undefined) {
    const skill = parent.skill.map((value, axis) =>
      round(value + (options.nullSteps ? 0 : -0.05 + 0.1 * unit(options.seed, 'skill', name, axis))),
    )
    artifact = { ...artifact, skill, quality: skillQuality(skill, options) }
  }
  if (parent.basin !== undefined && options.ceiling !== null) {
    const cap = options.ceiling + (parent.basin === 0 ? 0 : 0.25)
    artifact = { ...artifact, basin: parent.basin, quality: Math.min(cap, artifact.quality) }
  }
  if (parent.lines !== undefined) {
    artifact = { ...artifact, lines: editLines(parent.lines, name, options) }
  }
  let label = `step ${name}`
  if (options.plantGain !== null && name === 'root.0') {
    artifact = { ...artifact, quality: round(parent.quality + options.plantGain) }
    label = `planted gain ${options.plantGain}`
  }
  if (options.plantDivergence && name === 'root.1') {
    artifact = { ...artifact, trainShift: 0.3, heldShift: -0.2 }
    label = 'planted train-only gain'
  }
  return { artifact, label, rationale: `${label} from ${parent.name}` }
}

/** A child in the deep-plant landscape: on the planted path, neutral (or a
 * ramp step) until the plant; off it, a seeded loss in [0, 0.1). */
function deepChild(parent: SimArtifact, name: string, options: SimOptions) {
  const path = deepPath(options)
  const depth = path.indexOf(name)
  const gain = options.deepGain!
  if (depth > 0) {
    const quality =
      depth === options.deepDepth
        ? ROOT.quality + gain
        : options.deepRamp
          ? ROOT.quality + (gain * depth) / options.deepDepth
          : ROOT.quality
    const label = depth === options.deepDepth ? `planted +${gain} at depth ${depth}` : `path ${name}`
    return {
      artifact: { ...ROOT, name, quality: round(quality) } satisfies SimArtifact,
      label,
      rationale: `${label}, from ${parent.name}`,
    }
  }
  const artifact: SimArtifact = {
    ...ROOT,
    name,
    quality: round(parent.quality - 0.1 * unit(options.seed, 'deep-step', name)),
    ...defect(name, options),
  }
  return { artifact, label: `step ${name}`, rationale: `step ${name} from ${parent.name}` }
}

function defect(name: string, options: SimOptions): { defective?: true } {
  return options.defectRate > 0 && unit(options.seed, 'defect', name) < options.defectRate
    ? { defective: true }
    : {}
}

/** A planted-pool child: the root plus a seeded step in [-0.1, 0), or the
 * root plus the gap for the planted one. */
export function poolChild(index: number, options: SimOptions) {
  const name = `c${index}`
  const planted = index === plantIndex(options)
  if (options.skills > 1) {
    // Pool candidates differ mostly on the specialist axes; the planted one
    // is +gap on one specialist axis's share of the split, so only that
    // family's units separate it.
    const skill = Array.from({ length: options.skills }, (_, axis) =>
      axis === 0
        ? round(-0.02 * unit(options.seed, 'pool', name, axis))
        : round(options.skillSpread * (unit(options.seed, 'pool', name, axis) - 1)),
    )
    if (planted) {
      const family = 1 + Math.floor(unit(options.seed, 'plant-family') * (options.skills - 1))
      const selection = tasks('s', options.selection)
      const load =
        selection.reduce((sum, task) => sum + demand(options, task.taskId)[family]!, 0) /
        selection.length
      skill[family] = round(options.poolGap! / Math.max(load, 1e-9))
    }
    const artifact: SimArtifact = {
      ...rootOf(options),
      name,
      skill,
      quality: skillQuality(skill, options),
      lines: editLines(rootOf(options).lines!, name, options),
    }
    const label = planted ? `planted pool child +${options.poolGap}` : `pool child ${name}`
    return { artifact, label, rationale: `${label}, independent of its parent` }
  }
  const step = planted ? options.poolGap! : -0.1 * unit(options.seed, 'pool', name)
  const artifact: SimArtifact = { ...ROOT, name, quality: round(ROOT.quality + step) }
  const label = planted ? `planted pool child +${options.poolGap}` : `pool child ${name}`
  return { artifact, label, rationale: `${label}, independent of its parent` }
}

/** A draft: a fresh artifact written from the task, not from a parent, within
 * 0.05 of the root (equal to it under `--null`, so a null search stays null)
 * and defective at `--defect-rate`. Under `--ceiling` it starts its own
 * basin, which can climb 0.25 higher than the root's; under `--skills` its
 * skills are drawn afresh. */
export function draftChild(index: number, options: SimOptions) {
  const name = `d${index}`
  let artifact: SimArtifact = {
    ...rootOf(options),
    name,
    quality: round(
      ROOT.quality + (options.nullSteps ? 0 : -0.05 + 0.1 * unit(options.seed, 'draft', name)),
    ),
    lines: Array.from({ length: 8 }, (_, line) => `${name} line ${line}`),
    ...defect(name, options),
  }
  if (options.skills > 0) {
    const skill = Array.from({ length: options.skills }, (_, axis) =>
      round(options.nullSteps ? 0 : -0.1 + 0.2 * unit(options.seed, 'draft-skill', name, axis)),
    )
    artifact = { ...artifact, skill, quality: skillQuality(skill, options) }
  }
  if (options.ceiling !== null) artifact = { ...artifact, basin: index }
  return { artifact, label: `draft ${name}`, rationale: `draft ${name}, written afresh` }
}

export function simulateCell(work: SearchCellWork<SimArtifact>, options: SimOptions): SearchCellResult {
  const identity = {
    model: { provider: 'sim', alias: 'sim', unknown: 'the simulator runs no model' },
    agent: SIM_SOURCE,
    benchmark: benchmark(options),
  }
  const fraction = 0.4 + 0.8 * unit(options.seed, 'cost', work.cellId)
  const usd = round(
    options.costCap === 'hard'
      ? Math.min(options.cellUsd, options.cellUsd * fraction)
      : options.cellUsd * fraction * options.costScale,
  )
  const accounting = {
    tokens: { status: 'known' as const, inputTokens: 100, outputTokens: 50, cachedTokens: 0 },
    cost: { status: 'known' as const, usd, source: 'pricing-table' as const },
  }
  if (unit(options.seed, 'fault', work.runId) < options.faultRate) {
    return {
      outcome: {
        status: 'errored',
        metrics: {},
        error: { code: 'sim-fault', message: 'a simulated environment fault', retryable: true },
      },
      accounting,
      identity,
      placement: { lane: work.lane, boxId: null },
    }
  }
  const { artifact } = work
  if (artifact.defective) {
    const score = options.minimize ? 1 : 0
    return {
      outcome: {
        status: 'failed',
        score,
        metrics: { score },
        failure: { code: 'sim-defect', message: 'the simulated artifact crashed' },
      },
      accounting,
      identity,
      placement: { lane: work.lane, boxId: null },
    }
  }
  const shift = work.split === 'train' ? artifact.trainShift : artifact.heldShift
  const task =
    -0.1 +
    0.2 * unit(artifact.skill ? options.bankSeed : options.seed, 'task', work.taskId)
  const base = artifact.skill
    ? 0.5 +
      demand(options, work.taskId).reduce((sum, load, axis) => sum + load * artifact.skill![axis]!, 0)
    : artifact.quality
  const clamp = (value: number): number => Math.min(1, Math.max(0, value))
  const goodness = options.binary
    ? unit(options.seed, 'pass', work.cellId) < clamp(base + shift + task)
      ? 1
      : 0
    : clamp(base + shift + task - 0.15 + 0.3 * unit(options.seed, 'noise', work.cellId))
  const score = round(options.minimize ? 1 - goodness : goodness)
  return {
    outcome: { status: 'passed', score, metrics: { score } },
    accounting,
    identity,
    placement: { lane: work.lane, boxId: null },
  }
}
