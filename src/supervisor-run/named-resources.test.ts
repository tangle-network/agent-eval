import { join } from 'node:path'
import { expect, it } from 'vitest'
import { analyzeSupervisorRunSources, rollupSupervisorRuns } from './analyze'
import { fixtureSources } from './fixtures'
import { renderSupervisorRollupMarkdown, renderSupervisorRunMarkdown } from './render'
import { readRuntimeSupervisorRun } from './runtime-reader'
import { parseSupervisorTree } from './source-facts'
import { isUnavailable } from './types'

it('preserves actual reader receipts and inclusive totals without adding them', async () => {
  const source = await readRuntimeSupervisorRun(
    join(process.cwd(), 'tests/fixtures/supervisor-run/runtime-named-resources'),
  )
  const tree = parseSupervisorTree(source)
  expect(tree.closes[0]?.spend.resources).toEqual([
    { name: 'compute', unit: 'millisecond', amount: 5, known: true },
  ])
  const report = analyzeSupervisorRunSources(source)
  const records = report.economics.resourceRecords
  if (!records || isUnavailable(records)) throw new Error('missing resource records')
  expect(records).toHaveLength(4)
  expect(records[0]).toMatchObject({
    nodeId: 'resource-root',
    kind: 'metered',
    source: 'journal.rows[2].event.spend.resources',
    resources: [
      { name: 'compute', unit: 'millisecond', amount: 0, known: true },
      { name: 'transfer', unit: 'byte', amount: 7, known: false },
    ],
  })
  expect(records[3]).toMatchObject({
    nodeId: 'resource-root',
    kind: 'result',
    source: 'result.spentTotal.resources',
  })
  expect(JSON.parse(JSON.stringify(report)).economics.resourceRecords).toEqual(records)
  const markdown = renderSupervisorRunMarkdown(report)
  expect(markdown).toContain('| compute | millisecond | 0 | true |')
  expect(markdown).toContain('| transfer | byte | 7 | false |')
  expect(markdown).toContain('not additive totals')
  const rollup = rollupSupervisorRuns([report, { ...report, arm: 'other' }])
  expect(rollup.perCell.map((cell) => cell.resourceRecords)).toEqual([records, records])
  expect(renderSupervisorRollupMarkdown(rollup)).toContain('result.spentTotal.resources')
})

it('distinguishes absent maps, empty maps, malformed maps, and invalid fields', () => {
  const resources = [undefined, {}, null, { 'unsafe|name': { unit: 4, amount: -1 } }]
  const source = fixtureSources({
    journal: resources
      .map((value) => JSON.stringify({ kind: 'metered', id: 'root', spend: { resources: value } }))
      .join('\n'),
    result: null,
  })
  const report = analyzeSupervisorRunSources(source)
  const records = report.economics.resourceRecords
  if (!records || isUnavailable(records)) throw new Error('missing records')
  expect(records[0]?.resources).toEqual({ unavailable: 'resource map not recorded' })
  expect(records[1]?.resources).toEqual([])
  expect(records[2]?.resources).toEqual({ unavailable: 'resource map is malformed' })
  expect(records[3]?.resources).toEqual([
    {
      name: 'unsafe|name',
      unit: { unavailable: 'resource unit is missing or invalid' },
      amount: { unavailable: 'resource amount is missing or invalid' },
      known: { unavailable: 'resource completeness is missing or invalid' },
    },
  ])
  const markdown = renderSupervisorRunMarkdown(report)
  expect(markdown).toContain('unsafe\\|name')
  expect(markdown).toContain('recorded empty map')
})

it('retains terminal-only resources when the journal is missing', () => {
  const report = analyzeSupervisorRunSources(
    fixtureSources({
      journal: null,
      result: JSON.stringify({
        spentTotal: { resources: { energy: { unit: 'joule', amount: 9, known: false } } },
      }),
    }),
  )
  expect(report.economics.resourceRecords).toEqual([
    {
      nodeId: null,
      kind: 'result',
      source: 'result.spentTotal.resources',
      resources: [{ name: 'energy', unit: 'joule', amount: 9, known: false }],
    },
  ])
})
