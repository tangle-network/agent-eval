import { describe, expect, it } from 'vitest'
import {
  AGENT_PROFILE_KINDS,
  AgentProfileCellValidationError,
  buildAgentInterfaceProfileCell,
  buildAgentProfileCell,
  toAgentProfileJson,
  verifyAgentProfileCell,
} from '../src/agent-profile-cell'
import { canonicalString, jsonDocument } from '../src/ledger-core/canonical'

const profile = { name: 'test', version: '1', nested: { values: [1, 'x', null, true] } }

const malformed: Array<[string, unknown]> = [
  ['function', () => 1],
  ['symbol', Symbol('lost')],
  ['NaN', NaN],
  ['Infinity', Infinity],
  ['negative Infinity', -Infinity],
  ['bigint', 1n],
  ['Date', new Date(0)],
  ['Map', new Map()],
  ['Set', new Set()],
  ['undefined array item', [undefined]],
  ['sparse array', new Array(1)],
  ['unpaired surrogate', '\ud800'],
]

describe('profile JSON uses the ledger canonical owner', () => {
  it('preserves portable profiles and returns a detached JSON document', () => {
    const result = toAgentProfileJson(profile)
    expect(result).toEqual(profile)
    expect(result).not.toBe(profile)
    expect(canonicalString(result)).toBe(canonicalString(profile))
  })

  it('omits only undefined object properties, including nested optional fields', () => {
    expect(
      toAgentProfileJson({ ...profile, optional: undefined, nested: { optional: undefined } }),
    ).toEqual({ ...profile, nested: {} })
  })

  for (const [name, value] of malformed) {
    it(`rejects nested ${name} before it can become a different profile`, () => {
      const convert = () => toAgentProfileJson({ ...profile, nested: { value } })
      expect(convert).toThrow(AgentProfileCellValidationError)
      expect(convert).toThrow(/JSON-serializable/)
    })
  }

  it('rejects cycles with the profile boundary error', () => {
    const cyclic: Record<string, unknown> = { ...profile }
    cyclic.self = cyclic
    expect(() => toAgentProfileJson(cyclic)).toThrow(AgentProfileCellValidationError)
  })

  it('preserves __proto__ as data rather than dropping it or changing the prototype', () => {
    const input = JSON.parse('{"__proto__":null,"nested":{"__proto__":{"value":1}}}')
    const document = jsonDocument(input)
    expect(Object.getPrototypeOf(document)).toBe(Object.prototype)
    expect(Object.hasOwn(document as object, '__proto__')).toBe(true)
    expect(canonicalString(document)).toBe(canonicalString(input))
    expect(toAgentProfileJson(input)).toEqual(input)
    expect(canonicalString(document)).not.toBe(canonicalString({ nested: {} }))
  })

  it('keeps valid source hashes and cell identities unchanged', async () => {
    const input = {
      profileId: 'test@1',
      sourceProfile: { kind: AGENT_PROFILE_KINDS.AGENT_INTERFACE_PROFILE, profile },
      dimensions: { backend: 'test' },
    }
    const direct = await buildAgentProfileCell(input)
    const converted = await buildAgentProfileCell({
      ...input,
      sourceProfile: { ...input.sourceProfile, profile: toAgentProfileJson(profile) },
    })
    expect(converted).toEqual(direct)
    expect(await verifyAgentProfileCell(converted)).toBe(true)
  })

  it('includes a __proto__ dimension in identity rather than colliding with absence', async () => {
    const input = {
      profileId: 'test@1',
      sourceProfile: { kind: AGENT_PROFILE_KINDS.AGENT_INTERFACE_PROFILE, profile },
    }
    const plain = await buildAgentProfileCell(input)
    const tagged = await buildAgentProfileCell({
      ...input,
      dimensions: JSON.parse('{"__proto__":"tag"}'),
    })
    expect(Object.hasOwn(tagged.dimensions!, '__proto__')).toBe(true)
    expect(tagged.dimensions!['__proto__']).toBe('tag')
    expect(tagged.cellId).not.toBe(plain.cellId)
    expect(await verifyAgentProfileCell(tagged)).toBe(true)
  })

  it('does not call custom toJSON hooks to manufacture profile evidence', () => {
    let called = false
    const input = {
      ...profile,
      toJSON: () => {
        called = true
        return profile
      },
    }
    expect(() => toAgentProfileJson(input)).toThrow(AgentProfileCellValidationError)
    expect(called).toBe(false)
  })

  it('rejects malformed profiles through the canonical AgentProfile convenience', async () => {
    await expect(
      buildAgentInterfaceProfileCell({ ...profile, metadata: { value: NaN } }, {}),
    ).rejects.toThrow(AgentProfileCellValidationError)
  })

  it('preserves shared acyclic values without mistaking them for cycles', () => {
    const shared = { value: 1 }
    expect(toAgentProfileJson({ left: shared, right: shared })).toEqual({
      left: { value: 1 },
      right: { value: 1 },
    })
  })

  it('rejects a stored cell whose __proto__ dimension was not included in its digest', async () => {
    const plain = await buildAgentProfileCell({
      profileId: 'test@1',
      sourceProfile: { kind: AGENT_PROFILE_KINDS.AGENT_INTERFACE_PROFILE, profile },
    })
    const tampered = { ...plain, dimensions: JSON.parse('{"__proto__":"tag"}') }
    expect(await verifyAgentProfileCell(tampered)).toBe(false)
  })
})
