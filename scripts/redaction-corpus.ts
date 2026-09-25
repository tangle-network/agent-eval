/**
 * Run the redaction core over `scripts/redaction-corpus.json` and print one
 * line per miss. Exits 1 when any case misses, 0 when every case holds.
 *
 *   pnpm redaction:corpus
 */

import { readFileSync } from 'node:fs'
import {
  assessShareSafety,
  detectCredential,
  detectPersonalData,
  REDACTION_PROFILES,
  type RedactionProfile,
  redact,
  redactForShare,
  redactText,
  type ShareSafetyStatus,
} from '../src/trace/redact'

interface Expectation {
  status: ShareSafetyStatus
  mustFlag?: string[]
  mustNotFlag?: string[]
}

interface Corpus {
  keys: {
    mustSurvive: Array<{ key: string; value: unknown }>
    mustRedact: Array<{ key: string; value: unknown }>
  }
  values: {
    mustFlag: Array<{ detector: string; parts: string[] }>
    mustNotFlag: string[]
  }
  knownSecrets: { secret: string; texts: string[] }
  agentInspect: {
    license: string
    notice: string
    cases: Array<{ id: string; value: unknown; expectations: Record<RedactionProfile, Expectation> }>
  }
}

const corpus = JSON.parse(
  readFileSync(new URL('./redaction-corpus.json', import.meta.url), 'utf8'),
) as Corpus

const misses: string[] = []
let checks = 0
const expect = (ok: boolean, label: string): void => {
  checks += 1
  if (!ok) misses.push(label)
}

for (const { key, value } of corpus.keys.mustSurvive) {
  const out = redact({ [key]: value }).value as Record<string, unknown>
  expect(out[key] === value, `key must survive: ${key}`)
}
for (const { key, value } of corpus.keys.mustRedact) {
  const out = redact({ [key]: value }).value as Record<string, unknown>
  expect(out[key] !== value, `key must be redacted: ${key}`)
}

for (const { detector, parts } of corpus.values.mustFlag) {
  const text = parts.join('')
  const out = redactText(text)
  const found = detectCredential(text) ?? detectPersonalData(text)[0]
  expect(found === detector, `value must flag as ${detector}, got ${found ?? 'nothing'}: ${parts[0]}…`)
  expect(!out.includes(parts.at(-1) ?? text), `value must not survive redaction (${detector}): ${parts[0]}…`)
}
for (const text of corpus.values.mustNotFlag) {
  const out = redactText(text)
  expect(out === text, `value must not flag: ${JSON.stringify(text)} -> ${JSON.stringify(out)}`)
}

const { secret, texts } = corpus.knownSecrets
expect(redactText(`plain ${secret}`) === `plain ${secret}`, 'known secret is not a credential without knownSecrets')
for (const text of texts) {
  const out = redactText(text, { knownSecrets: [secret] })
  expect(out === '[REDACTED:known-secret]', `known secret must be removed: ${text}`)
  const verdict = assessShareSafety({ text }, { knownSecrets: [secret] })
  expect(verdict.status === 'UNSAFE', `known secret must make the verdict UNSAFE: ${text}`)
}

expect(corpus.agentInspect.license === 'MIT', 'agentInspect cases keep their MIT license')
expect(corpus.agentInspect.notice.includes('AgentInspect contributors'), 'agentInspect cases keep their notice')
for (const item of corpus.agentInspect.cases) {
  for (const profile of REDACTION_PROFILES) {
    const expected = item.expectations[profile]
    const verdict = assessShareSafety(item.value, { profile })
    const categories = new Set(verdict.findings.map((finding) => finding.category))
    expect(
      verdict.status === expected.status,
      `${item.id} [${profile}]: status ${verdict.status}, expected ${expected.status}`,
    )
    for (const category of expected.mustFlag ?? []) {
      expect(categories.has(category as never), `${item.id} [${profile}]: must flag ${category}`)
    }
    for (const category of expected.mustNotFlag ?? []) {
      expect(!categories.has(category as never), `${item.id} [${profile}]: must not flag ${category}`)
    }
    const shared = redactForShare(item.value, { profile })
    expect(
      shared.verdict.status !== 'UNSAFE',
      `${item.id} [${profile}]: still UNSAFE after redaction (${shared.verdict.findings.map((f) => f.detector).join(', ')})`,
    )
  }
}

for (const miss of misses) console.log(`MISS  ${miss}`)
console.log(`${checks - misses.length}/${checks} checks hold`)
process.exit(misses.length === 0 ? 0 : 1)
