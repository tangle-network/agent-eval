import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  type FinalEvidenceOutcome,
  type FinalEvidenceReservation,
  openFinalEvidenceLedger,
} from '../../src/experiment/final-evidence'
import { hashCanonical } from '../../src/ledger-core/canonical'

let dir: string
let path: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'final-evidence-'))
  path = join(dir, 'ledger.jsonl')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function value<T>(result: FinalEvidenceOutcome<T>): T {
  if (!result.succeeded) throw new Error(result.error.message)
  return result.value
}
function reservation(requestId = 'run'): FinalEvidenceReservation {
  return {
    requestId,
    claimDigest: hashCanonical('claim'),
    inputDigest: hashCanonical(requestId),
    populationId: 'incidents',
    unitIds: ['incident-1', 'incident-2'],
  }
}
const measurement = {
  evaluatorDigest: hashCanonical('evaluator'),
  candidateDigests: [hashCanonical('baseline'), hashCanonical('candidate')],
}

describe('durable final evidence lifecycle', () => {
  it('reopens reservations and exact retries without creating a second exposure', async () => {
    const first = openFinalEvidenceLedger({ path })
    expect(value(await first.read())).toEqual([])
    const reserved = value(await first.reserve(reservation()))
    expect(reserved.replayed).toBe(false)
    const second = openFinalEvidenceLedger({ path })
    expect(
      value(await second.reserve({ ...reservation(), unitIds: ['incident-2', 'incident-1'] }))
        .replayed,
    ).toBe(true)
    const exposed = value(await second.expose('run', measurement))
    expect(exposed.replayed).toBe(false)
    expect(exposed.record.exposure?.measurement.candidateDigests).toHaveLength(2)
    expect(value(await first.expose('run', measurement)).replayed).toBe(true)
    expect(readFileSync(path, 'utf8').trim().split('\n')).toHaveLength(2)
    expect(value(await first.read())[0]).toEqual(exposed.record)
  })

  it('refuses altered bindings, overlapping source units, and relabeled identical datasets', async () => {
    const ledger = openFinalEvidenceLedger({ path })
    value(await ledger.reserve(reservation()))
    for (const input of [
      { ...reservation(), claimDigest: hashCanonical('another claim') },
      { ...reservation('other'), populationId: 'renamed' },
      { ...reservation('other'), inputDigest: reservation().inputDigest, unitIds: ['renamed-1'] },
    ]) {
      expect(await ledger.reserve(input)).toMatchObject({
        succeeded: false,
        error: { kind: 'conflict' },
      })
    }
    value(await ledger.expose('run', measurement))
    expect(
      await ledger.expose('run', { ...measurement, candidateDigests: [hashCanonical('revised')] }),
    ).toMatchObject({ succeeded: false, error: { kind: 'conflict' } })
    expect(value(await ledger.read())).toHaveLength(1)
  })

  it('serializes competing owners and reports only one first exposure', async () => {
    const attempts = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        openFinalEvidenceLedger({ path }).reserve(reservation(`run-${i}`)),
      ),
    )
    const winners = attempts.filter((result) => result.succeeded)
    expect(winners).toHaveLength(1)
    const winner = value(winners[0]!)
    const exposed = await Promise.all(
      Array.from({ length: 4 }, () =>
        openFinalEvidenceLedger({ path }).expose(winner.record.reservation.requestId, measurement),
      ),
    )
    expect(exposed.map(value).filter((result) => !result.replayed)).toHaveLength(1)
  })

  it.each(['rewrite', 'truncate', 'missing-pin'] as const)(
    'refuses %s instead of opening fresh evidence',
    async (damage) => {
      const ledger = openFinalEvidenceLedger({ path })
      value(await ledger.reserve(reservation()))
      value(await ledger.expose('run', measurement))
      const contents = readFileSync(path, 'utf8')
      if (damage === 'rewrite') writeFileSync(path, contents.replace('incidents', 'tampered'))
      if (damage === 'truncate') writeFileSync(path, `${contents.split('\n')[0]}\n`)
      if (damage === 'missing-pin') unlinkSync(`${path}.head`)
      expect(await openFinalEvidenceLedger({ path }).read()).toMatchObject({
        succeeded: false,
        error: { kind: 'unavailable' },
      })
      expect((await ledger.reserve(reservation('new'))).succeeded).toBe(false)
    },
  )

  it('retains invalid input and unavailable storage as different failures', async () => {
    const ledger = openFinalEvidenceLedger({ path })
    expect(await ledger.reserve({ ...reservation(), unitIds: ['same', 'same'] })).toMatchObject({
      succeeded: false,
      error: { kind: 'invalid' },
    })
    expect(await ledger.expose('missing', measurement)).toMatchObject({
      succeeded: false,
      error: { kind: 'invalid' },
    })
    writeFileSync(join(dir, 'file'), 'not a directory')
    const unavailable = openFinalEvidenceLedger({ path: join(dir, 'file', 'ledger') })
    expect(await unavailable.reserve(reservation())).toMatchObject({
      succeeded: false,
      error: { kind: 'unavailable' },
    })
  })

  it('reports an invalid stored schema as unavailable evidence with its source location', async () => {
    const ledger = openFinalEvidenceLedger({ path })
    value(await ledger.reserve(reservation()))
    writeFileSync(
      path,
      readFileSync(path, 'utf8').replace('"unitIds":["incident-1","incident-2"]', '"unitIds":1'),
    )
    expect(await ledger.read()).toMatchObject({
      succeeded: false,
      error: { kind: 'unavailable', message: expect.stringContaining(`${path}:1`) },
    })
  })
})
