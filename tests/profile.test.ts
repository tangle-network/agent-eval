import { describe, expect, it } from 'vitest'
import {
  type AgentProfileSection,
  applyDomainPatch,
  BASELINE_ROLES,
  baselineProfile,
  baselineProfileFromRole,
  engineerRole,
  generalistRole,
  prodProfile,
  profileToSurface,
  renderProfile,
  researcherRole,
  sectionHash,
} from '../src/profile/index'

const baseline = baselineProfile({ role: 'You are a tax-return preparation agent.' })

const taxRules: AgentProfileSection = {
  id: 'filing-status',
  title: 'Filing status selection',
  body: 'Choose MFJ when both spouses agree and it minimizes total tax.',
  evolvable: true,
}

const fixedPreamble: AgentProfileSection = {
  id: 'compliance',
  title: 'Compliance preamble',
  body: 'Never fabricate a figure absent from the source documents.',
  evolvable: false,
}

const prod = prodProfile(baseline, [taxRules, fixedPreamble])

describe('renderProfile', () => {
  it('emits all five zones in fixed order', () => {
    const text = renderProfile(prod)
    const role = text.indexOf('You are a tax-return preparation agent.')
    const env = text.indexOf('## Environment')
    const tools = text.indexOf('## Tool conventions')
    const skills = text.indexOf('## Skills')
    const domain = text.indexOf('## Domain guidance')

    for (const [name, idx] of Object.entries({ role, env, tools, skills, domain })) {
      expect(idx, `${name} zone present`).toBeGreaterThan(-1)
    }
    expect(role).toBeLessThan(env)
    expect(env).toBeLessThan(tools)
    expect(tools).toBeLessThan(skills)
    expect(skills).toBeLessThan(domain)
  })

  it('renders each domain section as ### <title> + body', () => {
    const text = renderProfile(prod)
    expect(text).toContain('### Filing status selection')
    expect(text).toContain('Choose MFJ when both spouses agree')
    expect(text).toContain('### Compliance preamble')
  })

  it('renders each skill with name, description, and triggers', () => {
    const text = renderProfile(baseline)
    expect(text).toContain('### read-documents')
    expect(text).toContain('Read every source document')
    expect(text).toMatch(/Triggers: .*source document/)
  })

  it('profileToSurface equals renderProfile — the loop scores the rendered text', () => {
    expect(profileToSurface(prod)).toBe(renderProfile(prod))
  })
})

describe('Environment zone', () => {
  it('is present and non-empty, describing the sandbox layout', () => {
    const text = renderProfile(baseline)
    const env = text.slice(text.indexOf('## Environment'), text.indexOf('## Tool conventions'))
    const bodyAfterHeading = env.replace('## Environment', '').trim()
    expect(bodyAfterHeading.length).toBeGreaterThan(0)
    expect(env).toContain('Workspace root')
    expect(env).toContain('Documents directory')
    expect(env).toContain('Output directory')
    expect(env).toContain('Skills directory')
  })
})

describe('applyDomainPatch', () => {
  it('changes the hash of the patched evolvable section', () => {
    const before = sectionHash(taxRules)
    const patched = applyDomainPatch(
      prod,
      'filing-status',
      'Choose MFS when one spouse has large deductions.',
    )
    const after = sectionHash(patched.domain.find((s) => s.id === 'filing-status')!)
    expect(after).not.toBe(before)
  })

  it('leaves every non-targeted section byte-identical (hash unchanged)', () => {
    const patched = applyDomainPatch(prod, 'filing-status', 'A different body.')
    expect(sectionHash(patched.domain.find((s) => s.id === 'compliance')!)).toBe(
      sectionHash(fixedPreamble),
    )
  })

  it('refuses to patch a non-evolvable section — fails loud', () => {
    expect(() => applyDomainPatch(prod, 'compliance', 'tampered')).toThrow(/not evolvable/)
  })

  it('throws on an unknown section id rather than silently no-op', () => {
    expect(() => applyDomainPatch(prod, 'does-not-exist', 'x')).toThrow(/no domain section/)
  })

  it('only the patched section moves; the rendered prompt differs only in that body', () => {
    const patched = applyDomainPatch(prod, 'filing-status', 'Patched filing-status guidance.')
    const before = renderProfile(prod)
    const after = renderProfile(patched)
    expect(after).not.toBe(before)
    expect(after).toContain('Patched filing-status guidance.')
    // every other zone is carried through unchanged
    expect(after.slice(0, after.indexOf('### Filing status selection'))).toBe(
      before.slice(0, before.indexOf('### Filing status selection')),
    )
  })
})

describe('sectionHash', () => {
  it('is content-identity: same title+body share a hash, id is excluded', () => {
    const a: AgentProfileSection = { id: 'x', title: 'T', body: 'B', evolvable: true }
    const b: AgentProfileSection = { id: 'y', title: 'T', body: 'B', evolvable: false }
    expect(sectionHash(a)).toBe(sectionHash(b))
  })

  it('emits the sha256:-prefixed form the provenance record carries', () => {
    expect(sectionHash(taxRules)).toMatch(/^sha256:[0-9a-f]{64}$/)
  })
})

describe('baseline vs prod', () => {
  it('differ ONLY in domain (and layered skills) — scaffolding is identical', () => {
    expect(prod.role).toBe(baseline.role)
    expect(prod.environment).toBe(baseline.environment)
    expect(prod.toolConventions).toBe(baseline.toolConventions)
    expect(prod.skills).toEqual(baseline.skills)
    expect(baseline.domain).toEqual([])
    expect(prod.domain.map((s) => s.id)).toEqual(['filing-status', 'compliance'])
  })

  it('baseline ships stock skills and no domain guidance', () => {
    const text = renderProfile(baseline)
    expect(text).toContain('_No domain guidance yet._')
    expect(baseline.skills.length).toBeGreaterThan(0)
  })

  it('a baseline with caller-layered skills carries them into prod unchanged', () => {
    const withSkill = baselineProfile({
      role: 'r',
      skills: [{ name: 'redline', description: 'mark up contracts', triggers: ['draft review'] }],
    })
    const shipped = prodProfile(withSkill, [])
    expect(shipped.skills).toEqual(withSkill.skills)
  })
})

describe('profile baselines — strong generic roles (engineer/researcher/generalist)', () => {
  it('exposes three distinct, verification-first, domain-agnostic roles', () => {
    // distinct
    expect(new Set([engineerRole, researcherRole, generalistRole]).size).toBe(3)
    // verification-first: each role commits to verifying before "done"
    for (const r of [engineerRole, researcherRole, generalistRole]) {
      expect(r.toLowerCase()).toMatch(/verif|ground|check/)
    }
    // engineer = fix the root cause, never weaken the check (the coderProfile doctrine)
    expect(engineerRole.toLowerCase()).toMatch(
      /root cause|never weaken|hide the error|fake success/,
    )
    // researcher = never fabricate a source/citation
    expect(researcherRole.toLowerCase()).toMatch(/fabricat|cite|source/)
    // domain-agnostic: no product-domain words leak into the generic baselines
    for (const r of [engineerRole, researcherRole, generalistRole]) {
      expect(r.toLowerCase()).not.toMatch(/\b(m&a|tax return|1040|jurisdiction|retainer)\b/)
    }
    expect(Object.keys(BASELINE_ROLES).sort()).toEqual(['engineer', 'generalist', 'researcher'])
  })

  it('baselineProfileFromRole builds a domain-empty profile carrying the chosen role', () => {
    const p = baselineProfileFromRole('engineer')
    expect(p.role).toBe(engineerRole)
    expect(p.domain).toEqual([]) // domain stays empty — product layers it via prodProfile
    expect(renderProfile(p)).toContain('## Environment') // env scaffolding present
    // the role text is the top zone
    expect(renderProfile(p).startsWith(engineerRole.trim())).toBe(true)
  })

  it('a product composes baseline role + its OWN domain (domain not in the substrate)', () => {
    const base = baselineProfileFromRole('generalist')
    const prod = prodProfile(base, [
      {
        id: 'legal-citation',
        title: 'Citation Protocol',
        body: 'Cite the controlling authority.',
        evolvable: true,
      },
    ])
    // baseline role carried through unchanged; domain added on top
    expect(prod.role).toBe(generalistRole)
    expect(prod.domain.map((s) => s.id)).toEqual(['legal-citation'])
    // and the loop can still patch that product-supplied domain section
    const patched = applyDomainPatch(
      prod,
      'legal-citation',
      'Cite controlling authority WITH pincite.',
    )
    expect(patched.domain[0]!.body).toMatch(/pincite/)
  })
})
