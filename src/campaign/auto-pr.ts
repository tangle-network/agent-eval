/**
 * `openAutoPr` — thin shell-out helper for the `runImprovementLoop` preset's
 * `autoOnPromote: 'pr'` mode. Substitutes for the per-product PR-opening
 * code consumers duplicated 4 times. The PR body includes the campaign's
 * manifest hash, gate verdict, and scorecard summary so reviewers can see
 * exactly what was promoted + why.
 *
 * NOT a deploy mechanism — this only OPENS a PR. The human reviews + merges.
 * The Shape B (`autoOnPromote: 'config'`) live-runtime-mutation path is
 * deferred to Pass B with the full shadow / canary / rollback stack.
 */

import { execSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CampaignResult, GateResult, Scenario } from './types'

export interface OpenAutoPrOptions<TArtifact, TScenario extends Scenario> {
  /** Campaign result to attach to the PR. */
  result: CampaignResult<TArtifact, TScenario>
  /** Gate verdict explaining the promotion. Substrate refuses to open a PR
   *  when `gate.decision !== 'ship'` — fails loud. */
  gate: GateResult
  /** Promoted surface diff — typically the new system prompt addendum or
   *  full profile diff. Substrate writes it as the PR body. */
  promotedDiff: string
  /** GH owner/repo target (e.g., `tangle-network/gtm-agent`). */
  ghOwner: string
  ghRepo: string
  /** Branch name for the PR. Default `auto/<manifestHash[:12]>`. */
  branch?: string
  /** PR title. Default includes manifest hash. */
  title?: string
  /** Whether to actually open the PR or just dry-run. Default reads
   *  `GH_AUTO_PR_TOKEN` env — present = open, absent = dry-run. */
  dryRun?: boolean
  /** Test seam — substitute `gh pr create` invocation. */
  ghExec?: (args: string[]) => { stdout: string; stderr: string; status: number }
}

export interface OpenAutoPrResult {
  opened: boolean
  prUrl?: string
  dryRun: boolean
  reason: string
}

/**
 * Open a GitHub PR for a gate-approved surface promotion, attaching the manifest hash, gate verdict, and diff as the PR body.
 */
export function openAutoPr<TArtifact, TScenario extends Scenario>(
  options: OpenAutoPrOptions<TArtifact, TScenario>,
): OpenAutoPrResult {
  if (options.gate.decision !== 'ship') {
    return {
      opened: false,
      dryRun: false,
      reason: `gate verdict was "${options.gate.decision}" — refusing to open PR`,
    }
  }

  const dryRun = options.dryRun ?? !process.env.GH_AUTO_PR_TOKEN
  const branch = options.branch ?? `auto/${options.result.manifestHash.slice(0, 12)}`
  const title =
    options.title ?? `auto: campaign ${options.result.manifestHash.slice(0, 8)} promoted by gate`

  const body = renderPrBody(options.result, options.gate, options.promotedDiff)
  const bodyPath = join(tmpdir(), `auto-pr-body-${Date.now()}.md`)
  writeFileSync(bodyPath, body)

  if (dryRun) {
    return {
      opened: false,
      dryRun: true,
      reason: `dry-run (GH_AUTO_PR_TOKEN not set). Would create PR on ${options.ghOwner}/${options.ghRepo} branch ${branch}. Body at ${bodyPath}.`,
    }
  }

  const ghExec = options.ghExec ?? defaultGhExec
  const result = ghExec([
    'pr',
    'create',
    '--repo',
    `${options.ghOwner}/${options.ghRepo}`,
    '--head',
    branch,
    '--title',
    title,
    '--body-file',
    bodyPath,
  ])
  if (result.status !== 0) {
    return {
      opened: false,
      dryRun: false,
      reason: `gh pr create failed (exit ${result.status}): ${result.stderr.slice(0, 400)}`,
    }
  }
  const prUrl = result.stdout.trim()
  return { opened: true, prUrl, dryRun: false, reason: 'PR opened' }
}

function renderPrBody<TArtifact, TScenario extends Scenario>(
  result: CampaignResult<TArtifact, TScenario>,
  gate: GateResult,
  diff: string,
): string {
  const lines: string[] = []
  lines.push(`## Automated promotion by \`runImprovementLoop\``)
  lines.push('')
  lines.push(`**Manifest**: \`${result.manifestHash}\``)
  lines.push(`**Seed**: ${result.seed}`)
  lines.push(`**Duration**: ${Math.round(result.durationMs / 1000)}s`)
  lines.push(
    `**Cells**: executed ${result.aggregates.cellsExecuted}, cached ${result.aggregates.cellsCached}, skipped ${result.aggregates.cellsSkipped}, failed ${result.aggregates.cellsFailed}`,
  )
  lines.push(`**Total spend**: $${result.aggregates.totalCostUsd.toFixed(2)}`)
  lines.push('')
  lines.push(`### Gate verdict: \`${gate.decision}\``)
  lines.push('')
  for (const reason of gate.reasons) lines.push(`- ${reason}`)
  if (gate.delta !== undefined) lines.push(`- delta: ${gate.delta.toFixed(3)}`)
  lines.push('')
  lines.push('### Contributing gates')
  lines.push('')
  lines.push('| gate | passed | detail |')
  lines.push('|---|---|---|')
  for (const c of gate.contributingGates) {
    const detail =
      typeof c.detail === 'object'
        ? JSON.stringify(c.detail).slice(0, 80)
        : String(c.detail).slice(0, 80)
    lines.push(`| ${c.name} | ${c.passed ? '✓' : '✗'} | ${detail} |`)
  }
  lines.push('')
  lines.push('### Promoted surface')
  lines.push('')
  lines.push('```diff')
  lines.push(diff.slice(0, 8000))
  lines.push('```')
  lines.push('')
  lines.push('### By-judge aggregates')
  lines.push('')
  lines.push('| judge | mean | ci95 | n |')
  lines.push('|---|---|---|---|')
  for (const [name, agg] of Object.entries(result.aggregates.byJudge)) {
    lines.push(
      `| ${name} | ${agg.mean.toFixed(3)} | [${agg.ci95[0].toFixed(3)}, ${agg.ci95[1].toFixed(3)}] | ${agg.n} |`,
    )
  }
  return lines.join('\n')
}

function defaultGhExec(args: string[]): { stdout: string; stderr: string; status: number } {
  try {
    const stdout = execSync(`gh ${args.map(quoteArg).join(' ')}`, {
      env: { ...process.env, GH_TOKEN: process.env.GH_AUTO_PR_TOKEN ?? process.env.GH_TOKEN ?? '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    }).toString('utf8')
    return { stdout, stderr: '', status: 0 }
  } catch (err) {
    const e = err as { status?: number; stderr?: Buffer; stdout?: Buffer }
    return {
      stdout: e.stdout?.toString('utf8') ?? '',
      stderr: e.stderr?.toString('utf8') ?? '',
      status: e.status ?? 1,
    }
  }
}

function quoteArg(arg: string): string {
  if (/^[a-zA-Z0-9_/\-:.@]+$/.test(arg)) return arg
  return `"${arg.replace(/"/g, '\\"')}"`
}
