import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { toSftRows } from '../exporters'
import { fixtureRolloutLine } from '../fixtures'
import { writeRolloutLedger } from '../ledger'
import { FORMAT_FILES } from './card'
import { runRolloutReleaseCli } from './hf-dataset'

// Secret shapes are assembled at run time so the source file itself never
// carries a scanner-shaped token.
const j = (...parts: string[]) => parts.join('')
const SECRETS: Record<string, { text: string; rule: string }> = {
  'sk-tan': { text: j('sk-', 'tan-', '2f9Qx7LmZ0aB3cD4eF5g'), rule: 'api-key' },
  'sk-ant': { text: j('sk-', 'ant-api03-', 'AbCdEfGh1234567890wxyz'), rule: 'api-key' },
  'sk-ant-oat01': { text: j('sk-', 'ant-oat01-', 'ZyXwVu9876543210abcd'), rule: 'api-key' },
  ghp: { text: j('gh', 'p_', 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'), rule: 'api-key' },
  github_pat: { text: j('github', '_pat_', '11ABCDEFG0123456789_abcdefghij'), rule: 'api-key' },
  akia: { text: j('AK', 'IA', 'Q3EGRT7NB2XK5MPL'), rule: 'api-key' },
  env: { text: j('OPENAI_API', '_KEY=', 'plainvalue42'), rule: 'env-secret' },
  bearer: { text: j('Authorization: Bearer ', 'abcdefgh12345678'), rule: 'bearer-token' },
  'private-key': {
    text: j('-----BEGIN OPENSSH ', 'PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjE='),
    rule: 'private-key',
  },
  'high-entropy': { text: j('q8Zr3VbN7xKp2LmW', '9tYc4HsJ6dFg1AeQ'), rule: 'high-entropy' },
  email: { text: j('drew.fixture', '@', 'gmail.com'), rule: 'email' },
  phone: { text: '+1 (415) 555-0134', rule: 'phone' },
  address: { text: '1600 Amphitheatre Parkway', rule: 'postal-address' },
  denylist: { text: 'Zebulon Quartermaine', rule: 'denylist' },
}

const tempDirs: string[] = []
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

function lineSaying(id: string, text: string) {
  const base = fixtureRolloutLine()
  return fixtureRolloutLine({
    rollout_id: id,
    messages: [
      { role: 'user', content: `context before ${text} and after` },
      { role: 'assistant', content: 'done' },
    ],
    outcome: { ...base.outcome },
  })
}

describe('rollout-release privacy and license screen', () => {
  it('drops every line carrying a secret or private detail and every restricted producer', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'privacy-release-'))
    tempDirs.push(dir)
    const base = fixtureRolloutLine()
    const clean = lineSaying(
      'clean-1',
      'push git@github.com:tangle-network/agent-eval.git at 280ccb34b2a1c0d9e8f7a6b5c4d3e2f1a0b9c8d7 for ops@example.com',
    )
    const claude = fixtureRolloutLine({
      rollout_id: 'claude-1',
      policy: { ...base.policy, harness: 'claude', model: 'claude-opus-4' },
    })
    const evalOnly = fixtureRolloutLine({
      rollout_id: 'eval-only-1',
      policy: { ...base.policy, license_class: 'evaluation-only' },
    })
    const secretLines = Object.entries(SECRETS).map(([kind, { text }]) => lineSaying(kind, text))
    const ledger = join(dir, 'ledger.jsonl')
    await writeRolloutLedger(ledger, [clean, claude, evalOnly, ...secretLines])
    const denylist = join(dir, 'denylist.txt')
    await writeFile(denylist, '# private terms\nzebulon quartermaine\n')
    const out = join(dir, 'dataset')

    const stdout: string[] = []
    const write = process.stdout.write
    process.stdout.write = ((chunk: string) => stdout.push(chunk) > 0) as unknown as typeof write
    let code: number
    try {
      code = await runRolloutReleaseCli([ledger, '--out', out, '--denylist', denylist])
    } finally {
      process.stdout.write = write
    }
    expect(code).toBe(0)

    const report = JSON.parse(await readFile(join(out, 'scrub-report.json'), 'utf8'))
    expect(report.excluded).toEqual({ proposers: 0, nonTrain: 0, license: 2, privacy: 14 })
    const expected: Record<string, number> = {}
    for (const { rule } of Object.values(SECRETS)) expected[rule] = (expected[rule] ?? 0) + 1
    expect(Object.fromEntries(Object.entries(report.dropped).filter(([, n]) => n !== 0))).toEqual(
      expected,
    )

    const raw = (await readFile(join(out, 'raw/train.jsonl'), 'utf8')).trim().split('\n')
    expect(raw.map((row) => JSON.parse(row).rollout_id)).toEqual(['clean-1'])
    const sft = (await readFile(join(out, 'sft/train.jsonl'), 'utf8')).trim().split('\n')
    expect(sft).toHaveLength(1)

    // Zero emitted bytes, in any file the build wrote or printed, hold a secret.
    const shipped = [
      stdout.join(''),
      ...(await Promise.all(
        [...Object.values(FORMAT_FILES), 'scrub-report.json', 'README.md'].map((file) =>
          readFile(join(out, file), 'utf8'),
        ),
      )),
    ]
    for (const [kind, { text }] of Object.entries(SECRETS)) {
      const leaks = shipped.filter((body) => body.toLowerCase().includes(text.toLowerCase()))
      expect(leaks, kind).toHaveLength(0)
    }
  })

  it('refuses restricted and evaluation-only lines from training exports by default', () => {
    const base = fixtureRolloutLine()
    const codex = fixtureRolloutLine({
      policy: { ...base.policy, harness: 'codex', model: 'gpt-5.5' },
    })
    const human = fixtureRolloutLine({ policy: { ...base.policy, license_class: 'human' } })
    expect(toSftRows([base, codex, human])).toHaveLength(2)
    expect(toSftRows([codex], { allowLicenseClasses: ['restricted'] })).toHaveLength(1)
  })
})
