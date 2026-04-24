import { describe, it, expect } from 'vitest'
import { extractErrorCount, ERROR_COUNT_PATTERNS } from './error-count-extractor'

describe('extractErrorCount — toolchains', () => {
  it('typescript-tsc: counts each tsc diagnostic line', () => {
    const text = [
      'src/foo.ts(12,3): error TS1234: Foo is undefined.',
      'src/foo.ts(15,7): error TS2322: Type bar not assignable.',
      'src/bar.ts(1,1): error TS6133: Bar declared but not used.',
    ].join('\n')
    const r = extractErrorCount(text)
    expect(r.matched).toBe('typescript-tsc')
    expect(r.count).toBe(3)
    expect(r.samples).toHaveLength(3)
  })

  it('pytest-failed: counts FAILED prefixed lines', () => {
    const text = [
      '___________________ test_foo __________________',
      'FAILED tests/test_foo.py::test_foo',
      'FAILED tests/test_bar.py::test_bar - AssertionError',
    ].join('\n')
    const r = extractErrorCount(text)
    expect(r.matched).toBe('pytest-failed')
    expect(r.count).toBe(2)
  })

  it('rustc: counts error[E0xxx] + bare error: lines', () => {
    const text = [
      'error[E0308]: mismatched types',
      '  --> src/main.rs:5:9',
      'error: aborting due to 1 previous error',
    ].join('\n')
    const r = extractErrorCount(text)
    expect(r.matched).toBe('rustc')
    expect(r.count).toBe(2)
  })

  it('golang: counts ./file.go:line:col: diagnostics', () => {
    const text = [
      './main.go:5:9: undefined: foo',
      './pkg/util.go:12:3: cannot use x as int',
      'note: unrelated output',
    ].join('\n')
    const r = extractErrorCount(text)
    expect(r.matched).toBe('golang')
    expect(r.count).toBe(2)
  })

  it('eslint per-line: counts default-formatter error lines', () => {
    const text = [
      '/workdir/src/App.tsx',
      '  12:34  error  foo is defined but never used',
      '  15:10  error  Missing semicolon',
    ].join('\n')
    const r = extractErrorCount(text)
    expect(r.matched).toBe('eslint')
    expect(r.count).toBe(2)
  })

  it('eslint-summary: reads error count from summary line when per-line absent', () => {
    const text = '✖ 17 problems (12 errors, 5 warnings)'
    const r = extractErrorCount(text)
    expect(r.matched).toBe('eslint-summary')
    expect(r.count).toBe(12)
  })

  it('unknown toolchain: returns {count: null, matched: null}', () => {
    const text = 'some arbitrary warning\nnothing matches here'
    const r = extractErrorCount(text)
    expect(r.count).toBeNull()
    expect(r.matched).toBeNull()
  })

  it('empty input: returns null (not zero)', () => {
    const r = extractErrorCount('')
    expect(r.count).toBeNull()
  })
})

describe('extractErrorCount — options', () => {
  it('only=["pytest-failed"] skips tsc even though tsc would match', () => {
    const text = 'src/foo.ts(1,1): error TS1234: bad\nFAILED tests/test.py::t'
    const r = extractErrorCount(text, { only: ['pytest-failed'] })
    expect(r.matched).toBe('pytest-failed')
    expect(r.count).toBe(1)
  })

  it('extra patterns run BEFORE the built-ins', () => {
    const custom = {
      name: 'custom-foo',
      regex: /^CUSTOM_ERROR:\s+\S+/gm,
    }
    const text = 'CUSTOM_ERROR: something\nsrc/foo.ts(1,1): error TS1: bad'
    const r = extractErrorCount(text, { extra: [custom] })
    expect(r.matched).toBe('custom-foo')
    expect(r.count).toBe(1)
  })

  it('transform: aggregates counts rather than counting matches', () => {
    const custom = {
      name: 'sum-transform',
      regex: /count=(\d+)/g,
      transform: (m: RegExpMatchArray) => Number(m[1] ?? 0),
    }
    const text = 'count=3\ncount=7\ncount=0'
    const r = extractErrorCount(text, { only: ['sum-transform'], extra: [custom] })
    expect(r.count).toBe(10)
  })
})

describe('extractErrorCount — regex safety', () => {
  // Ensure each built-in pattern handles a pathological 200KB input without hanging.
  for (const p of ERROR_COUNT_PATTERNS) {
    it(`pattern ${p.name} handles a large benign input under 1s`, () => {
      const junk = 'lorem ipsum dolor sit amet '.repeat(7500) // ~200KB
      const start = Date.now()
      const r = extractErrorCount(junk, { only: [p.name] })
      const dur = Date.now() - start
      expect(dur).toBeLessThan(1000)
      expect(r.count).toBeNull()
    })
  }
})
