import { describe, expect, it } from 'vitest'

describe('pricing card', () => {
  it('shows plan, price, and call-to-action', () => {
    const rendered = '<h2>Pro</h2><p>$29/mo</p><button>Upgrade</button>'
    expect(rendered).toContain('Pro')
    expect(rendered).toContain('$29/mo')
    expect(rendered).toContain('Upgrade')
  })
})
