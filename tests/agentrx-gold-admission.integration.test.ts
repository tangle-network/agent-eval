/** Recorded public AgentRx bytes through the filesystem and public analyst API; no inference. */
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  type AgentRxRow,
  calibrateFailureModes,
  type FailureModeLabel,
  type FailureModesCalibration,
  loadFailureModeGold,
} from '../src/analyst/index'

const fixtures = join(process.cwd(), 'tests/fixtures/agentrx-actor-boundary')
const labelsPath = join(fixtures, 'labels.json')
const read = (name: string) => JSON.parse(readFileSync(join(fixtures, name), 'utf8'))
const rows: AgentRxRow[] = read('labels.json')

describe('recorded AgentRx gold admission', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentrx-gold-admission-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('keeps assistant root labels and excludes the User choice after an actual clarification', async () => {
    const loaded = await loadFailureModeGold({ agentRxLabelsPath: labelsPath })
    if (!loaded.succeeded) throw new Error(loaded.error.message)
    expect(loaded.value).toMatchObject({
      eligibility: 'eligible',
      agentRxRows: 3,
      agentRxMapping: { version: '2', target: 'agent-or-team-root-cause' },
      gold: [
        { id: 'agentrx:2', label: 'misread-tool-output' },
        { id: 'agentrx:12', label: 'disobey-task-specification' },
      ],
      unmapped: [
        {
          id: 'agentrx:71',
          category: 'underspecified-user-intent',
          reason: 'unsupported-root-actor',
          root: { failureId: '26', step: 24, actor: 'User' },
        },
      ],
    })
    const observations = read('observations.json')
    const [question, choice] = observations['71']
    expect(question.step).toBe(23)
    expect(question.message.role).toBe('assistant')
    expect(question.message.content).toContain(
      "Could you let me know which one you'd like to switch to?",
    )
    expect(choice).toMatchObject({ step: 24, message: { role: 'user' } })
    // This separate Assistant root has a visible incorrect count, rather than a User-choice label.
    const [tool, answer] = observations['2']
    const variants = Object.values(JSON.parse(tool.message.content).variants) as Array<{
      available: boolean
    }>
    expect(variants.filter((variant) => variant.available)).toHaveLength(10)
    expect(answer.message.content).toContain('11 available T-shirt options')
  })

  it('returns unknown eligibility and typed reasons when every recorded root is excluded', async () => {
    const user = rows.find((row) => row.trajectory_id === 71)!
    const assistant = rows.find((row) => row.trajectory_id === 2)!
    // Model an annotation transport that omitted actor metadata; do not invent a replacement actor or label.
    const withoutActor = {
      ...assistant,
      failures: assistant.failures.map(({ failed_agent: _omitted, ...failure }) => failure),
    }
    const path = join(dir, 'excluded.json')
    writeFileSync(path, JSON.stringify([user, withoutActor]))
    const loaded = await loadFailureModeGold({ agentRxLabelsPath: path })
    if (!loaded.succeeded) throw new Error(loaded.error.message)
    expect(loaded.value.eligibility).toBe('unknown')
    expect(loaded.value.gold).toEqual([])
    expect(loaded.value.unmapped).toMatchObject([
      { id: 'agentrx:71', reason: 'unsupported-root-actor', root: { actor: 'User' } },
      { id: 'agentrx:2', reason: 'unknown-root-actor', root: { actor: null } },
    ])
    expect(loaded.value.agentRxRows).toBe(loaded.value.unmapped.length)
  })

  it('refuses invalid root provenance rather than returning a typed but unusable exclusion', async () => {
    const user = rows.find((row) => row.trajectory_id === 71)!
    const path = join(dir, 'invalid-root.json')
    writeFileSync(
      path,
      JSON.stringify([
        {
          ...user,
          failures: user.failures.map((failure) => ({ ...failure, step_number: 0 })),
        },
      ]),
    )
    const loaded = await loadFailureModeGold({ agentRxLabelsPath: path })
    expect(loaded).toMatchObject({ succeeded: false, error: { kind: 'invalid' } })
  })

  it('reserves all AgentRx source ids while preserving disjoint and caller-only gold', async () => {
    const goldPath = join(dir, 'caller-gold.json')
    const callerGold: Array<{ id: string; label: FailureModeLabel }> = [
      { id: 'agentrx:71', label: 'fail-to-ask-for-clarification' },
    ]
    writeFileSync(goldPath, JSON.stringify(callerGold))
    expect(await loadFailureModeGold({ agentRxLabelsPath: labelsPath, goldPath })).toMatchObject({
      succeeded: false,
      error: { kind: 'invalid', message: "gold id 'agentrx:71' repeats across sources" },
    })
    // An admitted Assistant root owns its source id too.
    writeFileSync(goldPath, JSON.stringify([{ ...callerGold[0], id: 'agentrx:2' }]))
    expect(await loadFailureModeGold({ agentRxLabelsPath: labelsPath, goldPath })).toMatchObject({
      succeeded: false,
      error: { kind: 'invalid', message: "gold id 'agentrx:2' repeats across sources" },
    })
    writeFileSync(goldPath, JSON.stringify(callerGold))
    const callerOnly = await loadFailureModeGold({ goldPath })
    expect(callerOnly).toMatchObject({
      succeeded: true,
      value: { gold: callerGold, eligibility: 'eligible', agentRxRows: 0, agentRxMapping: null },
    })
    const disjoint = [{ ...callerGold[0], id: 'caller:clarification' }]
    writeFileSync(goldPath, JSON.stringify(disjoint))
    const combined = await loadFailureModeGold({ agentRxLabelsPath: labelsPath, goldPath })
    if (!combined.succeeded) throw new Error(combined.error.message)
    expect(combined.value.gold).toEqual([
      { id: 'agentrx:2', label: 'misread-tool-output' },
      { id: 'agentrx:12', label: 'disobey-task-specification' },
      ...disjoint,
    ])
    expect(combined.value.unmapped.map((item) => item.id)).toEqual(['agentrx:71'])
  })

  it('preserves the old recorded labels and failed calibration across new source admission', async () => {
    const path = join(fixtures, 'legacy-calibration.json')
    const before = readFileSync(path)
    const labelsBefore = readFileSync(labelsPath)
    const legacy: {
      items: Array<{ id: string; gold: FailureModeLabel; judged: FailureModeLabel }>
      calibration: FailureModesCalibration
    } = JSON.parse(before.toString('utf8'))
    const score = () =>
      calibrateFailureModes(
        legacy.items.map((item) => ({ id: item.id, label: item.gold })),
        legacy.items.map((item) => ({ id: item.id, label: item.judged })),
      )
    expect(score()).toEqual(legacy.calibration)
    const loaded = await loadFailureModeGold({ agentRxLabelsPath: labelsPath })
    expect(loaded.succeeded).toBe(true)
    expect(score()).toEqual(legacy.calibration)
    expect(score().gold_n).toBe(20)
    expect(score().agreement).toBe(3 / 20)
    expect(score().kappa).toBeCloseTo(1 / 11, 14)
    expect(createHash('sha256').update(readFileSync(path)).digest('hex')).toBe(
      createHash('sha256').update(before).digest('hex'),
    )
    expect(readFileSync(labelsPath)).toEqual(labelsBefore)
  })
})
