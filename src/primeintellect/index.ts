import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { type RunRecord, validateRunRecord } from '../run-record'

export type PrimeIntellectJson =
  | null
  | boolean
  | number
  | string
  | PrimeIntellectJson[]
  | { [key: string]: PrimeIntellectJson }

export interface PrimeIntellectMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
}

export interface PrimeIntellectScenario {
  id: string
  prompt: string | readonly PrimeIntellectMessage[]
  answer?: string
  requiredSubstrings?: readonly string[]
  split?: string
  info?: Record<string, PrimeIntellectJson>
}

export interface PrimeIntellectDatasetRow {
  id: string
  prompt: PrimeIntellectMessage[]
  answer?: string
  required_substrings?: string[]
  split?: string
  info: Record<string, PrimeIntellectJson>
}

export type PrimeIntellectScenarioMap =
  | ReadonlyMap<string, PrimeIntellectScenario>
  | Record<string, PrimeIntellectScenario>
  | readonly PrimeIntellectScenario[]

export interface PrimeIntellectRowsFromRunRecordsOptions {
  records: readonly RunRecord[]
  scenarios: PrimeIntellectScenarioMap
  requireScorable?: boolean
  includeFailed?: boolean
}

export interface PrimeIntellectEnvironmentPackageInput {
  name: string
  version?: string
  description?: string
  tags?: readonly string[]
  moduleName?: string
  rows: readonly PrimeIntellectDatasetRow[]
  runRecords?: readonly RunRecord[]
  systemPrompt?: string
  verifiersVersion?: string
  dependencies?: readonly string[]
  readme?: string
}

export interface PrimeIntellectPackageFile {
  path: string
  content: string
}

export interface PrimeIntellectPackageManifest {
  schemaVersion: 1
  name: string
  moduleName: string
  version: string
  rowCount: number
  runRecordCount: number
  artifactKinds: readonly ['environment', 'dataset', 'run_records']
}

export interface PrimeIntellectEnvironmentPackage {
  files: PrimeIntellectPackageFile[]
  manifest: PrimeIntellectPackageManifest
}

export class PrimeIntellectBridgeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PrimeIntellectBridgeError'
  }
}

export function primeIntellectRowsFromRunRecords(
  options: PrimeIntellectRowsFromRunRecordsOptions,
): PrimeIntellectDatasetRow[] {
  const scenarioById = normalizeScenarios(options.scenarios)
  const requireScorable = options.requireScorable ?? true
  const includeFailed = options.includeFailed ?? true
  const rows: PrimeIntellectDatasetRow[] = []

  for (const record of options.records) {
    const validRecord = validateRunRecord(record)
    if (!includeFailed && validRecord.failureMode) continue

    const scenarioId = validRecord.scenarioId
    if (!scenarioId) {
      throw new PrimeIntellectBridgeError(
        `RunRecord ${validRecord.runId} is missing scenarioId; PrimeIntellect rows need stable task ids`,
      )
    }

    const scenario = scenarioById.get(scenarioId)
    if (!scenario) {
      throw new PrimeIntellectBridgeError(
        `RunRecord ${validRecord.runId} references unknown scenarioId ${JSON.stringify(scenarioId)}`,
      )
    }

    const hasAnswer = typeof scenario.answer === 'string' && scenario.answer.trim().length > 0
    const hasRequiredSubstrings = (scenario.requiredSubstrings?.length ?? 0) > 0
    if (requireScorable && !hasAnswer && !hasRequiredSubstrings) {
      throw new PrimeIntellectBridgeError(
        `Scenario ${scenario.id} has no answer or requiredSubstrings; generated environments would always score 0`,
      )
    }

    const score = validRecord.outcome.holdoutScore ?? validRecord.outcome.searchScore ?? null
    const split = scenario.split ?? validRecord.splitTag
    const tangleInfo = {
      run_id: validRecord.runId,
      experiment_id: validRecord.experimentId,
      candidate_id: validRecord.candidateId,
      scenario_id: scenarioId,
      split,
      score,
      cost_usd: validRecord.costUsd,
      wall_ms: validRecord.wallMs,
      failure_mode: validRecord.failureMode ?? null,
      model: validRecord.model,
      commit_sha: validRecord.commitSha,
    } satisfies Record<string, PrimeIntellectJson>

    rows.push({
      id: `${scenarioId}:${validRecord.runId}`,
      prompt: normalizePrompt(scenario.prompt),
      ...(hasAnswer ? { answer: scenario.answer } : {}),
      ...(hasRequiredSubstrings
        ? { required_substrings: [...(scenario.requiredSubstrings ?? [])] }
        : {}),
      split,
      info: {
        ...(scenario.info ?? {}),
        tangle: tangleInfo,
      },
    })
  }

  return rows
}

export function buildPrimeIntellectEnvironmentPackage(
  input: PrimeIntellectEnvironmentPackageInput,
): PrimeIntellectEnvironmentPackage {
  if (input.rows.length === 0) {
    throw new PrimeIntellectBridgeError('cannot build a PrimeIntellect environment with zero rows')
  }

  for (const record of input.runRecords ?? []) {
    validateRunRecord(record)
  }

  const moduleName = input.moduleName ?? toPythonModuleName(input.name)
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(moduleName)) {
    throw new PrimeIntellectBridgeError(
      `moduleName ${JSON.stringify(moduleName)} is not a valid Python module name`,
    )
  }

  const version = input.version ?? '0.1.0'
  const description =
    input.description ?? 'PrimeIntellect Verifiers environment exported from Tangle runs.'
  const verifiersVersion = input.verifiersVersion ?? '>=0.2.0,<0.3.0'
  const dependencies = unique([
    'datasets',
    `verifiers${verifiersVersion}`,
    ...(input.dependencies ?? []),
  ])
  const tags = unique(['tangle', 'agent-eval', ...(input.tags ?? [])])
  const manifest: PrimeIntellectPackageManifest = {
    schemaVersion: 1,
    name: input.name,
    moduleName,
    version,
    rowCount: input.rows.length,
    runRecordCount: input.runRecords?.length ?? 0,
    artifactKinds: ['environment', 'dataset', 'run_records'],
  }

  const files: PrimeIntellectPackageFile[] = [
    {
      path: 'pyproject.toml',
      content: renderPyproject({
        name: input.name,
        version,
        description,
        dependencies,
        tags,
      }),
    },
    {
      path: 'README.md',
      content: input.readme ?? renderReadme({ name: input.name, description }),
    },
    {
      path: `${moduleName}.py`,
      content: renderEnvironmentModule({
        systemPrompt: input.systemPrompt,
      }),
    },
    {
      path: 'data/dataset.jsonl',
      content: toJsonl(input.rows),
    },
    {
      path: 'data/run_records.jsonl',
      content: toJsonl(input.runRecords ?? []),
    },
    {
      path: 'tangle-primeintellect-manifest.json',
      content: `${stableJson(manifest)}\n`,
    },
  ]

  return { files, manifest }
}

export async function writePrimeIntellectEnvironmentPackage(
  root: string,
  input: PrimeIntellectEnvironmentPackageInput,
): Promise<PrimeIntellectEnvironmentPackage> {
  const pkg = buildPrimeIntellectEnvironmentPackage(input)
  await Promise.all(
    pkg.files.map(async (file) => {
      const target = join(root, file.path)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, file.content, 'utf8')
    }),
  )
  return pkg
}

function normalizeScenarios(
  scenarios: PrimeIntellectScenarioMap,
): Map<string, PrimeIntellectScenario> {
  const map = new Map<string, PrimeIntellectScenario>()
  if (scenarios instanceof Map) {
    for (const [id, scenario] of scenarios.entries()) {
      map.set(id, { ...scenario, id: scenario.id ?? id })
    }
    return map
  }

  const values = Array.isArray(scenarios) ? scenarios : Object.values(scenarios)
  for (const scenario of values) {
    if (!scenario.id) {
      throw new PrimeIntellectBridgeError('every PrimeIntellect scenario needs an id')
    }
    if (map.has(scenario.id)) {
      throw new PrimeIntellectBridgeError(`duplicate PrimeIntellect scenario id ${scenario.id}`)
    }
    map.set(scenario.id, scenario)
  }
  return map
}

function normalizePrompt(
  prompt: string | readonly PrimeIntellectMessage[],
): PrimeIntellectMessage[] {
  if (typeof prompt === 'string') {
    return [{ role: 'user', content: prompt }]
  }
  return prompt.map((message) => ({ role: message.role, content: message.content }))
}

function toPythonModuleName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/^[0-9]/, '_$&')
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)]
}

function toJsonl(values: readonly unknown[]): string {
  if (values.length === 0) return ''
  return `${values.map((value) => stableJson(value)).join('\n')}\n`
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value))
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson)
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, nested]) => [key, sortJson(nested)]),
  )
}

function renderPyproject(input: {
  name: string
  version: string
  description: string
  dependencies: readonly string[]
  tags: readonly string[]
}): string {
  return `[project]
name = ${tomlString(input.name)}
version = ${tomlString(input.version)}
description = ${tomlString(input.description)}
readme = "README.md"
requires-python = ">=3.11"
license = "MIT"
keywords = ${tomlArray(input.tags)}
dependencies = ${tomlArray(input.dependencies)}

[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[tool.hatch.build]
include = ["*.py", "README.md", "data/*.jsonl", "tangle-primeintellect-manifest.json"]

[tool.uv]
prerelease = "allow"

[tool.verifiers.eval]
num_examples = 5
rollouts_per_example = 3
`
}

function renderReadme(input: { name: string; description: string }): string {
  return `# ${input.name}

${input.description}

Generated by \`@tangle-network/agent-eval/primeintellect\` from validated Tangle \`RunRecord\` rows.

## Files

- \`data/dataset.jsonl\`: prompts and scoring references for PrimeIntellect Verifiers.
- \`data/run_records.jsonl\`: original Tangle run rows for provenance and analysis.
- \`tangle-primeintellect-manifest.json\`: export metadata.

## Local check

\`\`\`sh
uv pip install --prerelease=allow -e .
uv run vf-eval ${input.name}
\`\`\`

## Upload

\`\`\`sh
prime login
prime env push
\`\`\`
`
}

function renderEnvironmentModule(input: { systemPrompt?: string }): string {
  const systemPrompt = input.systemPrompt === undefined ? 'None' : pyString(input.systemPrompt)
  return `import json
import re
from pathlib import Path

from datasets import Dataset
import verifiers as vf


DATA_PATH = Path(__file__).parent / "data" / "dataset.jsonl"
DEFAULT_SYSTEM_PROMPT = ${systemPrompt}


def _load_rows(dataset_path=None, dataset_split=None):
    path = Path(dataset_path) if dataset_path is not None else DATA_PATH
    rows = []
    with path.open("r", encoding="utf-8") as handle:
        for line in handle:
            row = json.loads(line)
            if dataset_split is None or row.get("split") == dataset_split:
                rows.append(row)
    if not rows:
        raise ValueError(f"No dataset rows found in {path} for split={dataset_split!r}")
    return rows


def _message_text(message):
    if isinstance(message, dict):
        content = message.get("content", "")
    else:
        content = getattr(message, "content", "")
    if isinstance(content, list):
        return " ".join(
            str(part.get("text", part)) if isinstance(part, dict) else str(part)
            for part in content
        )
    return str(content)


def _completion_text(completion):
    if isinstance(completion, str):
        return completion
    if isinstance(completion, list):
        return "\\n".join(_message_text(message) for message in completion)
    return _message_text(completion)


def _normalize(text):
    return re.sub(r"\\s+", " ", str(text).strip().lower())


async def tangle_reward(completion, answer=None, required_substrings=None, **kwargs):
    response = _normalize(_completion_text(completion))
    scores = []
    if answer:
        expected = _normalize(answer)
        scores.append(1.0 if expected == response or expected in response else 0.0)
    if required_substrings:
        required = [_normalize(item) for item in required_substrings]
        hits = sum(1 for item in required if item and item in response)
        scores.append(hits / len(required))
    return max(scores) if scores else 0.0


def build_dataset(dataset_path=None, dataset_split=None):
    return Dataset.from_list(_load_rows(dataset_path=dataset_path, dataset_split=dataset_split))


def load_environment(dataset_path=None, dataset_split=None, system_prompt=DEFAULT_SYSTEM_PROMPT):
    rubric = vf.Rubric(funcs=[tangle_reward])
    return vf.SingleTurnEnv(
        dataset=lambda: build_dataset(dataset_path=dataset_path, dataset_split=dataset_split),
        system_prompt=system_prompt,
        rubric=rubric,
    )
`
}

function tomlString(value: string): string {
  return JSON.stringify(value)
}

function tomlArray(values: readonly string[]): string {
  return `[${values.map(tomlString).join(', ')}]`
}

function pyString(value: string): string {
  return JSON.stringify(value)
}
