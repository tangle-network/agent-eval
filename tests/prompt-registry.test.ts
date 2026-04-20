import { describe, it, expect } from 'vitest'
import { PromptRegistry, hashContent } from '../src/prompt-registry'

describe('PromptRegistry', () => {
  it('registers + retrieves by id+version', async () => {
    const reg = new PromptRegistry()
    const h = await reg.register('legal.system', 'v1', 'You are a legal assistant.')
    expect(h.id).toBe('legal.system')
    expect(h.version).toBe('v1')
    expect(h.hash).toMatch(/^[0-9a-f]{12}$/)
    expect(reg.get('legal.system', 'v1').content).toBe('You are a legal assistant.')
  })

  it('is idempotent on identical re-registration — regression: duplicate register on restart must not throw', async () => {
    const reg = new PromptRegistry()
    const a = await reg.register('x', '1', 'content')
    const b = await reg.register('x', '1', 'content')
    expect(a).toEqual(b)
  })

  it('throws on conflicting re-registration — regression: silent overwrite breaks A/B audit trail', async () => {
    const reg = new PromptRegistry()
    await reg.register('x', '1', 'content-a')
    await expect(reg.register('x', '1', 'content-b')).rejects.toThrow(/different hash/)
  })

  it('hashes are deterministic across calls — regression: hash drift breaks historical compares', async () => {
    const a = await hashContent('stable content')
    const b = await hashContent('stable content')
    expect(a).toBe(b)
  })

  it('different content → different hash — regression: collision defeats the entire purpose', async () => {
    const a = await hashContent('one')
    const b = await hashContent('one ')
    expect(a).not.toBe(b)
  })

  it('get() on unknown key throws — regression: implicit default prompt would hide A/B errors', async () => {
    const reg = new PromptRegistry()
    expect(() => reg.get('unknown', 'v1')).toThrow(/not registered/)
  })

  it('listVersions returns newest-first by lex-descending version', async () => {
    const reg = new PromptRegistry()
    await reg.register('x', 'v1', 'a')
    await reg.register('x', 'v2', 'b')
    await reg.register('x', 'v10', 'c')
    const versions = reg.listVersions('x').map((h) => h.version)
    // Lexical descending: v2 > v10 > v1 (lexical, not numeric — documented)
    expect(versions[0]).toBe('v2')
  })

  it('rejects invalid ids', async () => {
    const reg = new PromptRegistry()
    await expect(reg.register('', 'v1', 'x')).rejects.toThrow()
    await expect(reg.register('has spaces', 'v1', 'x')).rejects.toThrow()
  })

  it('verifyHash returns true/false/null correctly', async () => {
    const reg = new PromptRegistry()
    const h = await reg.register('x', 'v1', 'content')
    expect(reg.verifyHash('x', 'v1', h.hash)).toBe(true)
    expect(reg.verifyHash('x', 'v1', 'deadbeefdead')).toBe(false)
    expect(reg.verifyHash('nope', 'v1', h.hash)).toBe(null)
  })
})
