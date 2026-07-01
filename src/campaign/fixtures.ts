import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { contentHash } from '../verdict-cache'
import { type CampaignRunPlan, type PlanCampaignRunOptions, planCampaignRun } from './run-campaign'
import type { CampaignStorage } from './storage'
import type { JudgeConfig, Scenario } from './types'

export type EvalFixtureValidationMode = 'vitest' | 'none'

export interface EvalFixtureFile {
  path: string
  sha256: string
  bytes: number
}

export interface EvalFixture {
  name: string
  path: string
  promptPath: string
  evalPath?: string
  packageJsonPath?: string
  prompt: string
  files: EvalFixtureFile[]
  fingerprint: string
}

export interface EvalFixtureScenario extends Scenario {
  kind: 'eval-fixture'
  fixtureName: string
  fixturePath: string
  promptPath: string
  evalPath?: string
  packageJsonPath?: string
  prompt: string
  fingerprint: string
}

export interface EvalFixtureLoadOptions {
  /** `vitest` requires EVAL.ts/EVAL.tsx and package.json type=module. `none` only requires PROMPT.md. */
  validation?: EvalFixtureValidationMode
  /** Extra caller-owned knobs that affect fixture behavior, folded into the fingerprint. */
  fingerprintConfig?: unknown
}

export interface LoadEvalFixtureScenariosOptions extends EvalFixtureLoadOptions {
  names?: string[]
}

export interface PlanEvalFixtureRunOptions<TArtifact = unknown>
  extends Pick<
    PlanCampaignRunOptions<EvalFixtureScenario, TArtifact>,
    'dispatchRef' | 'judges' | 'seed' | 'reps' | 'resumable' | 'runDir'
  > {
  evalsDir: string
  validation?: EvalFixtureValidationMode
  fingerprintConfig?: unknown
  names?: string[]
  storage?: CampaignStorage
}

export type EvalFixtureRunPlan = CampaignRunPlan & {
  fixtures: Array<Pick<EvalFixtureScenario, 'fixtureName' | 'fixturePath' | 'fingerprint'>>
}

export function discoverEvalFixtures(evalsDir: string): string[] {
  const root = resolve(evalsDir)
  if (!existsSync(root)) throw new Error(`discoverEvalFixtures: evalsDir not found: ${root}`)

  const fixtures: string[] = []
  const walk = (dir: string, base = '') => {
    for (const entry of readdirSync(dir).sort()) {
      if (entry.startsWith('.') || entry === 'node_modules') continue
      const fullPath = join(dir, entry)
      if (!statSync(fullPath).isDirectory()) continue

      const name = base ? `${base}/${entry}` : entry
      if (existsWithExactCase(fullPath, 'PROMPT.md')) {
        fixtures.push(name)
      } else {
        walk(fullPath, name)
      }
    }
  }

  walk(root)
  return fixtures
}

export function loadEvalFixture(
  evalsDir: string,
  name: string,
  options: EvalFixtureLoadOptions = {},
): EvalFixture {
  const validation = options.validation ?? 'vitest'
  const root = resolve(evalsDir)
  const fixturePath = resolve(root, name)
  assertInside(root, fixturePath, name)

  if (!existsSync(fixturePath) || !statSync(fixturePath).isDirectory()) {
    throw new Error(`loadEvalFixture: fixture not found: ${name}`)
  }
  if (!existsWithExactCase(fixturePath, 'PROMPT.md')) {
    throw new Error(`loadEvalFixture: ${name} is missing exact-case PROMPT.md`)
  }

  const promptPath = join(fixturePath, 'PROMPT.md')
  const evalPath = resolveEvalPath(fixturePath)
  const packageJsonPath = existsWithExactCase(fixturePath, 'package.json')
    ? join(fixturePath, 'package.json')
    : undefined

  if (validation !== 'none') {
    if (!evalPath)
      throw new Error(`loadEvalFixture: ${name} is missing exact-case EVAL.ts or EVAL.tsx`)
    if (!packageJsonPath)
      throw new Error(`loadEvalFixture: ${name} is missing exact-case package.json`)
    assertModulePackage(packageJsonPath, name)
  }

  const files = collectFixtureFiles(fixturePath)
  return {
    name,
    path: fixturePath,
    promptPath,
    evalPath,
    packageJsonPath,
    prompt: readFileSync(promptPath, 'utf8'),
    files,
    fingerprint: contentHash({
      files,
      config: options.fingerprintConfig ?? null,
    }),
  }
}

export function loadEvalFixtureScenarios(
  evalsDir: string,
  options: LoadEvalFixtureScenariosOptions = {},
): EvalFixtureScenario[] {
  const names = options.names ?? discoverEvalFixtures(evalsDir)
  return names.map((name) => {
    const fixture = loadEvalFixture(evalsDir, name, options)
    return {
      id: fixture.name,
      kind: 'eval-fixture',
      tags: ['eval-fixture'],
      fixtureName: fixture.name,
      fixturePath: fixture.path,
      promptPath: fixture.promptPath,
      evalPath: fixture.evalPath,
      packageJsonPath: fixture.packageJsonPath,
      prompt: fixture.prompt,
      fingerprint: fixture.fingerprint,
    }
  })
}

export function planEvalFixtureRun<TArtifact = unknown>(
  options: PlanEvalFixtureRunOptions<TArtifact>,
): EvalFixtureRunPlan {
  const scenarios = loadEvalFixtureScenarios(options.evalsDir, {
    names: options.names,
    validation: options.validation,
    fingerprintConfig: options.fingerprintConfig,
  })
  const plan = planCampaignRun<EvalFixtureScenario, TArtifact>({
    scenarios,
    dispatchRef: options.dispatchRef ?? 'eval-fixture-dispatch',
    judges: options.judges as JudgeConfig<TArtifact, EvalFixtureScenario>[] | undefined,
    seed: options.seed,
    reps: options.reps,
    resumable: options.resumable,
    runDir: options.runDir,
    storage: options.storage,
  })

  return {
    ...plan,
    fixtures: scenarios.map((scenario) => ({
      fixtureName: scenario.fixtureName,
      fixturePath: scenario.fixturePath,
      fingerprint: scenario.fingerprint,
    })),
  }
}

function existsWithExactCase(dirPath: string, fileName: string): boolean {
  try {
    return readdirSync(dirPath).includes(fileName)
  } catch {
    return false
  }
}

function resolveEvalPath(fixturePath: string): string | undefined {
  if (existsWithExactCase(fixturePath, 'EVAL.ts')) return join(fixturePath, 'EVAL.ts')
  if (existsWithExactCase(fixturePath, 'EVAL.tsx')) return join(fixturePath, 'EVAL.tsx')
  return undefined
}

function assertModulePackage(packageJsonPath: string, name: string): void {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(packageJsonPath, 'utf8'))
  } catch (err) {
    throw new Error(
      `loadEvalFixture: ${name} package.json is invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    (parsed as { type?: unknown }).type !== 'module'
  ) {
    throw new Error(`loadEvalFixture: ${name} package.json must set "type": "module"`)
  }
}

function collectFixtureFiles(fixturePath: string, base = ''): EvalFixtureFile[] {
  const files: EvalFixtureFile[] = []
  for (const entry of readdirSync(join(fixturePath, base)).sort()) {
    if (entry === 'node_modules' || entry === '.git') continue
    const relativePath = base ? `${base}/${entry}` : entry
    const fullPath = join(fixturePath, relativePath)
    const stat = statSync(fullPath)
    if (stat.isDirectory()) {
      files.push(...collectFixtureFiles(fixturePath, relativePath))
      continue
    }
    const bytes = readFileSync(fullPath)
    files.push({
      path: relativePath,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      bytes: bytes.byteLength,
    })
  }
  return files
}

function assertInside(root: string, target: string, label: string): void {
  const rel = relative(root, target)
  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) return
  throw new Error(`loadEvalFixture: fixture path escapes evalsDir: ${label}`)
}
