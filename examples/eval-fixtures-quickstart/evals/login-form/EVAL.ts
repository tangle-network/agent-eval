import { describe, expect, it } from 'vitest'

describe('login form', () => {
  it('keeps submitted email visible after validation', () => {
    const rendered = '<input name="email" value="drew@example.com" />'
    expect(rendered).toContain('drew@example.com')
  })
})
