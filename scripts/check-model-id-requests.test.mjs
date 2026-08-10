import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { checkModelIdRequests } from './check-model-id-requests.mjs'

const tempRoots = []

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { force: true, recursive: true })
})

const WAIVER_REASON = 'sample data for a doc snippet; nothing here contacts a provider'

/** Build a throwaway repo: `src` files plus the allowlist the gate reads. */
function fixture(files, allow = []) {
  const root = mkdtempSync(join(tmpdir(), 'model-id-gate-'))
  tempRoots.push(root)
  mkdirSync(join(root, 'src'), { recursive: true })
  for (const [name, content] of Object.entries(files)) {
    const path = join(root, 'src', name)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, content)
  }
  const allowlistPath = join(root, 'allowlist.json')
  writeFileSync(allowlistPath, JSON.stringify({ allow }))
  return { root, allowlistPath }
}

function run(files, allow) {
  const { root, allowlistPath } = fixture(files, allow)
  return checkModelIdRequests({ root, allowlistPath })
}

describe('model ids that reach a measurement path', () => {
  test('an unproven id in a request position is reported with its file, line and scope', () => {
    const { offences } = run({
      'runner.ts': [
        'export async function runScenario(chat: ChatClient) {',
        "  const model = 'gpt-4.1-mini'",
        '  return chat.chat({ model, messages: [] })',
        '}',
      ].join('\n'),
    })

    expect(offences).toHaveLength(1)
    expect(offences[0]).toMatchObject({
      file: 'src/runner.ts',
      line: 2,
      literal: 'gpt-4.1-mini',
      position: 'model',
      scope: 'runScenario()',
    })
  })

  test('a served-model assertion anywhere in the enclosing function clears the id', () => {
    const { offences } = run({
      'runner.ts': [
        'export async function runScenario(chat: ChatClient) {',
        "  const model = 'gpt-4.1-mini'",
        '  const response = await chat.chat({ model, messages: [] })',
        '  assertServedModel(model, response.servedModel)',
        '  return response',
        '}',
      ].join('\n'),
    })

    expect(offences).toEqual([])
  })

  test('an assertion in a nested closure counts, because that is where the call lands', () => {
    const { offences } = run({
      'factory.ts': [
        'export function makeChecker(chat: ChatClient) {',
        "  const model = 'claude-sonnet-4-6'",
        '  return async () => {',
        '    const response = await chat.chat({ model, messages: [] })',
        '    assertServedModel(model, response.servedModel)',
        '  }',
        '}',
      ].join('\n'),
    })

    expect(offences).toEqual([])
  })

  test('an assertion in a DIFFERENT function does not clear the id', () => {
    const { offences } = run({
      'split.ts': [
        'export function elsewhere(response: ChatResponse) {',
        "  assertServedModel('gpt-4o', response.servedModel)",
        '}',
        'export async function runScenario(chat: ChatClient) {',
        "  const model = 'gpt-4.1-mini'",
        '  return chat.chat({ model, messages: [] })',
        '}',
      ].join('\n'),
    })

    expect(offences).toHaveLength(1)
    expect(offences[0]).toMatchObject({ line: 5, scope: 'runScenario()' })
  })

  test('an import alias of the assertion still counts as proof', () => {
    const { offences } = run({
      'aliased.ts': [
        "import { assertServedModel as assertServedModelIdentity } from './served-model'",
        'export async function runScenario(chat: ChatClient) {',
        "  const model = 'gpt-4.1-mini'",
        '  const response = await chat.chat({ model, messages: [] })',
        '  assertServedModelIdentity(model, response.servedModel)',
        '}',
      ].join('\n'),
    })

    expect(offences).toEqual([])
  })
})

describe('request positions', () => {
  test.each([
    ['object property', "export const a = { model: 'gpt-4o' }", 'model'],
    ['seat array element', "export const a = { judges: ['deepseek-v4-pro'] }", 'judges'],
    ['nullish default', 'export const a = (o: O) => o.model ?? "gpt-4o"', 'model'],
    ['destructuring default', 'export function a({ model = "gpt-4o" }: O) { return model }', 'model'],
    ['parameter default', 'export function a(model = "gpt-4o") { return model }', 'model'],
    ['variable named for a seat', 'export const verifier = "deepseek-v4-pro"', 'verifier'],
  ])('%s is a request position', (_label, source, position) => {
    const { offences } = run({ 'case.ts': source })
    expect(offences).toHaveLength(1)
    expect(offences[0].position).toBe(position)
  })

  test.each([
    ['an unrelated key', "export const a = { harness: 'opencode-1.0' }"],
    ['a bare string', "export const label = 'gpt-4o'"],
    ['a price-table key', "export const prices = { 'gpt-4o': 1 }"],
  ])('%s is not a request position', (_label, source) => {
    expect(run({ 'case.ts': source }).offences).toEqual([])
  })

  test.each([
    ['an empty string', 'export const a = { model: "" }'],
    ['a sentinel with no version', 'export const a = { model: "unattributed" }'],
    ['a parenthesised placeholder', 'export const a = { model: "(default)" }'],
    ['an unknown-provider sentinel', 'export const a = { model: "unknown@unknown" }'],
  ])('%s names no model and is ignored', (_label, source) => {
    expect(run({ 'case.ts': source }).offences).toEqual([])
  })
})

describe('the measurement surface', () => {
  test.each(['runner.test.ts', 'runner.test-support.ts', 'runner.d.ts'])(
    '%s measures nothing and is skipped',
    (name) => {
      expect(run({ [name]: "export const a = { model: 'gpt-4.1-mini' }" }).offences).toEqual([])
    },
  )

  test('a nested source directory is still scanned', () => {
    const { offences } = run({ 'integrity/deep.ts': "export const a = { model: 'gpt-4.1-mini' }" })
    expect(offences).toHaveLength(1)
    expect(offences[0].file).toBe('src/integrity/deep.ts')
  })
})

describe('waivers', () => {
  test('a waiver clears the id it names', () => {
    const { offences } = run({ 'fixtures.ts': "export const a = { model: 'glm-5.2' }" }, [
      { file: 'src/fixtures.ts', literal: 'glm-5.2', reason: WAIVER_REASON },
    ])
    expect(offences).toEqual([])
  })

  test('a waiver is scoped to its file, so the same id elsewhere still fails', () => {
    const { offences } = run(
      {
        'fixtures.ts': "export const a = { model: 'glm-5.2' }",
        'runner.ts': "export const b = { model: 'glm-5.2' }",
      },
      [{ file: 'src/fixtures.ts', literal: 'glm-5.2', reason: WAIVER_REASON }],
    )
    expect(offences).toHaveLength(1)
    expect(offences[0].file).toBe('src/runner.ts')
  })

  test('a waiver that matches nothing is reported, so the list cannot rot', () => {
    const { offences, unusedWaivers } = run({ 'fixtures.ts': 'export const a = 1' }, [
      { file: 'src/fixtures.ts', literal: 'glm-5.2', reason: WAIVER_REASON },
    ])
    expect(offences).toEqual([])
    expect(unusedWaivers).toHaveLength(1)
    expect(unusedWaivers[0].literal).toBe('glm-5.2')
  })

  test.each([
    ['a missing reason', { file: 'src/a.ts', literal: 'glm-5.2' }],
    ['a blank file', { file: '  ', literal: 'glm-5.2', reason: WAIVER_REASON }],
    ['a reason too short to review', { file: 'src/a.ts', literal: 'glm-5.2', reason: 'because' }],
  ])('%s is rejected rather than silently accepted', (_label, entry) => {
    expect(() => run({ 'a.ts': "export const a = { model: 'glm-5.2' }" }, [entry])).toThrow()
  })
})

describe('the shipped repository', () => {
  test('passes its own gate', () => {
    const { offences, unusedWaivers } = checkModelIdRequests()
    expect(offences).toEqual([])
    expect(unusedWaivers).toEqual([])
  })
})
