/**
 * `hostedTenantFromEnv` is the env→HostedTenant map every product passes to
 * `selfImprove({ hostedTenant })`. It must fail SOFT (undefined, not throw) when
 * unconfigured, so a product wires it unconditionally and it stays off until the
 * env is set.
 */

import { describe, expect, it } from 'vitest'

import { hostedClientFromEnv, hostedTenantFromEnv } from './client'

describe('hostedTenantFromEnv', () => {
  const fullEnv = {
    TANGLE_INGEST_URL: 'https://orchestrator.example/v1/',
    TANGLE_API_KEY: 'k-123',
    TANGLE_TENANT_ID: 'acme',
  }

  it('builds a tenant from env and strips the trailing slash', () => {
    const t = hostedTenantFromEnv({ env: fullEnv })
    expect(t).toEqual({
      endpoint: 'https://orchestrator.example/v1',
      apiKey: 'k-123',
      tenantId: 'acme',
    })
  })

  it('returns undefined (not an error) when any required field is missing', () => {
    expect(hostedTenantFromEnv({ env: {} })).toBeUndefined()
    expect(
      hostedTenantFromEnv({ env: { TANGLE_INGEST_URL: 'x', TANGLE_API_KEY: 'y' } }),
    ).toBeUndefined()
  })

  it('overrides win over env (e.g. a fixed per-product tenantId)', () => {
    const t = hostedTenantFromEnv({ env: fullEnv, tenantId: 'my-agent' })
    expect(t?.tenantId).toBe('my-agent')
  })

  it('hostedClientFromEnv composes it — undefined env ⇒ no client', () => {
    expect(hostedClientFromEnv({ env: {} })).toBeUndefined()
    expect(hostedClientFromEnv({ env: fullEnv })).toBeDefined()
  })
})
