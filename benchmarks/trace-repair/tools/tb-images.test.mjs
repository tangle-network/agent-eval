import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  digestHex,
  isDigest,
  parseImageRef,
  parseQuotaHeader,
  parseTaskImage,
  planPulls,
  readQuotaHeaders,
  verifyPins,
} from './tb-images.mjs'

describe('parseImageRef', () => {
  it('applies the docker.io default for a namespaced reference', () => {
    expect(parseImageRef('alexgshaw/compile-compcert:20251031')).toEqual({
      registry: 'docker.io',
      repository: 'alexgshaw/compile-compcert',
      tag: '20251031',
    })
  })

  it('applies the library/ default for an official image', () => {
    expect(parseImageRef('python:3.13-slim-bookworm')).toEqual({
      registry: 'docker.io',
      repository: 'library/python',
      tag: '3.13-slim-bookworm',
    })
  })

  it('keeps an explicit registry host', () => {
    expect(parseImageRef('ghcr.io/tangle-network/tb2:20251031')).toEqual({
      registry: 'ghcr.io',
      repository: 'tangle-network/tb2',
      tag: '20251031',
    })
  })

  it('rejects a digest-form reference so the pin is assigned here', () => {
    expect(() => parseImageRef(`alexgshaw/x@sha256:${'a'.repeat(64)}`)).toThrow(/tag-form/)
  })

  it('rejects a reference with no tag', () => {
    expect(() => parseImageRef('alexgshaw/compile-compcert')).toThrow(/explicit tag/)
  })
})

describe('parseTaskImage', () => {
  const toml = ['[environment]', 'docker_image = "alexgshaw/compile-compcert:20251031"', 'build_timeout_sec = 600.0'].join('\n')

  it('reads the declared image', () => {
    expect(parseTaskImage(toml, 'compile-compcert')).toBe('alexgshaw/compile-compcert:20251031')
  })

  it('fails loud when the task declares no image', () => {
    expect(() => parseTaskImage('[environment]\n', 'x')).toThrow(/declares no docker_image/)
  })

  it('fails loud when the task declares two images', () => {
    expect(() => parseTaskImage(`${toml}\ndocker_image = "other/x:1"`, 'x')).toThrow(/declares 2 docker_image/)
  })
})

describe('quota headers', () => {
  it('parses the count and window', () => {
    expect(parseQuotaHeader('100;w=3600')).toEqual({ count: 100, windowSeconds: 3600 })
  })

  it('returns null for an absent header', () => {
    expect(parseQuotaHeader(null)).toBeNull()
  })

  it('reads a full header set', () => {
    const headers = new Headers({
      'ratelimit-limit': '100;w=3600',
      'ratelimit-remaining': '87;w=3600',
      'docker-ratelimit-source': '216.117.227.139',
    })
    expect(readQuotaHeaders(headers)).toEqual({
      limit: 100,
      remaining: 87,
      windowSeconds: 3600,
      source: '216.117.227.139',
    })
  })

  it('returns null when the response carries no budget', () => {
    expect(readQuotaHeaders(new Headers({ 'content-type': 'application/json' }))).toBeNull()
  })
})

describe('planPulls', () => {
  const quota = { limit: 100, remaining: 30, windowSeconds: 3600 }

  it('allows every pull that fits under the reserve', () => {
    expect(planPulls(15, quota, 10)).toMatchObject({ allowed: 15, deferred: 0 })
  })

  it('defers the pulls that would eat the reserve', () => {
    expect(planPulls(40, quota, 10)).toMatchObject({ allowed: 20, deferred: 20 })
  })

  it('refuses to pull when the quota cannot be read', () => {
    expect(planPulls(5, null, 10)).toMatchObject({ allowed: 0, deferred: 5 })
  })

  it('never plans a negative budget when the quota is already spent', () => {
    expect(planPulls(5, { limit: 100, remaining: 2, windowSeconds: 3600 }, 10)).toMatchObject({ allowed: 0, deferred: 5 })
  })
})

describe('verifyPins', () => {
  const store = '/nonexistent-store'
  let fetchSpy

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error('the campaign gate must not reach the network')
    })
  })

  afterEach(() => {
    fetchSpy.mockRestore()
  })

  it('reports an unlocked task without contacting a registry', () => {
    expect(verifyPins({ images: {} }, ['dna-insert'], store)).toEqual([{ task: 'dna-insert', ok: false, detail: 'not locked' }])
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('refuses a pin that was locked but never warmed', () => {
    const lock = { images: { 'dna-insert': { repository: 'alexgshaw/dna-insert', tag: '20251031', digest: `sha256:${'c'.repeat(64)}`, imageId: null } } }
    expect(verifyPins(lock, ['dna-insert'], store)).toEqual([
      { task: 'dna-insert', ok: false, detail: 'locked but never warmed (no imageId)' },
    ])
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe('digests', () => {
  it('accepts a canonical sha256 digest', () => {
    expect(isDigest(`sha256:${'0'.repeat(64)}`)).toBe(true)
  })

  it('rejects a truncated or uppercase digest', () => {
    expect(isDigest('sha256:abc')).toBe(false)
    expect(isDigest(`sha256:${'A'.repeat(64)}`)).toBe(false)
  })

  it('extracts the hex body for content-addressed paths', () => {
    expect(digestHex(`sha256:${'b'.repeat(64)}`)).toBe('b'.repeat(64))
  })
})
