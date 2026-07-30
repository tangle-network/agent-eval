import { describe, expect, it } from 'vitest'
import { parseVerificationOutcome } from './benchmark-verification-outcome'

describe('parseVerificationOutcome', () => {
  it('reads Terminal-Bench results and preserves failing check names', () => {
    expect(
      parseVerificationOutcome([
        {
          relativePath: 'results.json',
          content: JSON.stringify({
            is_resolved: false,
            failure_mode: 'unset',
            parser_results: {
              test_network: 'passed',
              test_visual_feedback: 'failed',
            },
          }),
        },
      ]),
    ).toMatchObject({
      status: 'failed',
      passedCheckCount: 1,
      failedCheckCount: 1,
      passedChecks: ['test_network'],
      failedChecks: ['test_visual_feedback'],
      sources: [{ path: 'results.json', format: 'terminal-bench', status: 'failed' }],
    })
  })

  it('marks a Terminal-Bench evaluator parse error unavailable', () => {
    expect(
      parseVerificationOutcome([
        {
          relativePath: 'results.json',
          content: JSON.stringify({
            is_resolved: null,
            failure_mode: 'parse_error',
            parser_results: null,
          }),
        },
      ]),
    ).toMatchObject({
      status: 'unavailable',
      reason: 'result-parse-error',
      sources: [{ path: 'results.json', format: 'terminal-bench' }],
    })
  })

  it('marks a Terminal-Bench execution failure unavailable', () => {
    expect(
      parseVerificationOutcome([
        {
          relativePath: 'results.json',
          content: JSON.stringify({
            is_resolved: null,
            failure_mode: 'test_timeout',
            parser_results: null,
          }),
        },
      ]),
    ).toMatchObject({
      status: 'unavailable',
      reason: 'result-output-unavailable',
      sources: [{ path: 'results.json', format: 'terminal-bench' }],
    })
  })

  it('reads direct and nested SWE-bench results', () => {
    const direct = parseVerificationOutcome([
      {
        relativePath: 'task_result.json',
        content: JSON.stringify({
          resolved: true,
          passed_tests: ['test-a'],
          failed_tests: [],
        }),
      },
    ])
    const nested = parseVerificationOutcome([
      {
        relativePath: 'report.json',
        content: JSON.stringify({
          'owner/repo-1': {
            resolved: false,
            tests_status: {
              FAIL_TO_PASS: { success: [], failure: ['test-fix'] },
              PASS_TO_PASS: { success: ['test-stable'], failure: [] },
            },
          },
        }),
      },
    ])

    expect(direct).toMatchObject({
      status: 'passed',
      passedChecks: ['test-a'],
      failedChecks: [],
    })
    expect(nested).toMatchObject({
      status: 'failed',
      passedChecks: ['owner/repo-1:PASS_TO_PASS:test-stable'],
      failedChecks: ['owner/repo-1:FAIL_TO_PASS:test-fix'],
    })
  })

  it('marks the observed SWE-Multi no-results form unavailable', () => {
    expect(
      parseVerificationOutcome([
        {
          relativePath: 'report.json',
          content: JSON.stringify({
            valid: false,
            error_msg:
              'After applying the fix patch, no test results were captured when executing the test command. A brief summary is as follows: Test Result Summary:',
            fix_patch_result: {
              passed_count: 0,
              failed_count: 0,
              skipped_count: 0,
              passed_tests: [],
              failed_tests: [],
              skipped_tests: [],
            },
          }),
        },
      ]),
    ).toMatchObject({
      status: 'unavailable',
      reason: 'result-output-unavailable',
      passedCheckCount: 0,
      failedCheckCount: 0,
      sources: [{ path: 'report.json', format: 'swe-multi', status: 'unavailable' }],
    })
  })

  it('keeps a genuine SWE-Multi valid:false result failed', () => {
    expect(
      parseVerificationOutcome([
        {
          relativePath: 'report.json',
          content: JSON.stringify({
            valid: false,
            error_msg:
              'After applying the fix patch, no test cases transitioned from failed to passed.',
            fix_patch_result: {
              passed_count: 1,
              failed_count: 1,
              skipped_count: 0,
              passed_tests: ['baseline'],
              failed_tests: ['regression'],
              skipped_tests: [],
            },
          }),
        },
      ]),
    ).toMatchObject({
      status: 'failed',
      passedChecks: ['baseline'],
      failedChecks: ['regression'],
      sources: [{ format: 'swe-multi' }],
    })
  })

  it('requires the exact SWE-Multi no-results structure', () => {
    expect(
      parseVerificationOutcome([
        {
          relativePath: 'report.json',
          content: JSON.stringify({
            valid: false,
            error_msg: 'No test output captured.',
            fix_patch_result: {
              passed_count: 0,
              failed_count: 0,
              skipped_count: 0,
              passed_tests: [],
              failed_tests: [],
              skipped_tests: [],
            },
          }),
        },
      ]),
    ).toMatchObject({
      status: 'failed',
      passedCheckCount: 0,
      failedCheckCount: 0,
    })
  })

  it('rejects unknown and contradictory result formats', () => {
    expect(() =>
      parseVerificationOutcome([
        { relativePath: 'result.json', content: JSON.stringify({ score: 1 }) },
      ]),
    ).toThrow(/no supported outcome field/)

    expect(() =>
      parseVerificationOutcome([
        {
          relativePath: 'first.json',
          content: JSON.stringify({
            resolved: true,
            passed_tests: ['check'],
            failed_tests: [],
          }),
        },
        {
          relativePath: 'second.json',
          content: JSON.stringify({
            is_resolved: false,
            failure_mode: 'unset',
            parser_results: { check: 'failed' },
          }),
        },
      ]),
    ).toThrow(/disagree/)
  })

  it('rejects a check reported as both passed and failed', () => {
    expect(() =>
      parseVerificationOutcome([
        {
          relativePath: 'first.json',
          content: JSON.stringify({
            resolved: false,
            passed_tests: ['same-check'],
            failed_tests: [],
          }),
        },
        {
          relativePath: 'second.json',
          content: JSON.stringify({
            resolved: false,
            passed_tests: [],
            failed_tests: ['same-check'],
          }),
        },
      ]),
    ).toThrow(/both passed and failed: same-check/)

    expect(() =>
      parseVerificationOutcome([
        {
          relativePath: 'one.json',
          content: JSON.stringify({
            resolved: false,
            passed_tests: ['same-check'],
            failed_tests: ['same-check'],
          }),
        },
      ]),
    ).toThrow(/both passed and failed: same-check/)
  })

  it.each([
    [
      'Terminal-Bench parser_results',
      {
        is_resolved: true,
        failure_mode: 'unset',
      },
      /parser_results/,
    ],
    [
      'direct SWE-bench test arrays',
      {
        resolved: false,
        failed_tests: [],
      },
      /passed_tests/,
    ],
    [
      'nested SWE-bench test arrays',
      {
        'owner/repo-1': {
          resolved: false,
          tests_status: {
            FAIL_TO_PASS: { success: [], failure: 'test-fix' },
          },
        },
      },
      /failure/,
    ],
    [
      'SWE-Multi result counts',
      {
        valid: false,
        error_msg: 'tests failed',
        fix_patch_result: {
          passed_tests: [],
          failed_tests: ['test-fix'],
          skipped_tests: [],
        },
      },
      /passed_count/,
    ],
  ])('rejects missing or malformed %s', (_name, result, error) => {
    expect(() =>
      parseVerificationOutcome([{ relativePath: 'result.json', content: JSON.stringify(result) }]),
    ).toThrow(error)
  })

  it('rejects SWE-Multi counts that disagree with their arrays', () => {
    expect(() =>
      parseVerificationOutcome([
        {
          relativePath: 'report.json',
          content: JSON.stringify({
            valid: false,
            error_msg: 'tests failed',
            fix_patch_result: {
              passed_count: 2,
              failed_count: 1,
              skipped_count: 0,
              passed_tests: ['baseline'],
              failed_tests: ['regression'],
              skipped_tests: [],
            },
          }),
        },
      ]),
    ).toThrow(/passed_count=2 does not match passed_tests length 1/)
  })

  it.each([
    [
      'Terminal-Bench',
      {
        is_resolved: true,
        failure_mode: 'unset',
        parser_results: { regression: 'failed' },
      },
    ],
    [
      'direct SWE-bench',
      {
        resolved: true,
        passed_tests: ['baseline'],
        failed_tests: ['regression'],
      },
    ],
    [
      'nested SWE-bench',
      {
        'owner/repo-1': {
          resolved: true,
          tests_status: {
            FAIL_TO_PASS: { success: [], failure: ['regression'] },
          },
        },
      },
    ],
    [
      'SWE-Multi',
      {
        valid: true,
        error_msg: '',
        fix_patch_result: {
          passed_count: 1,
          failed_count: 1,
          skipped_count: 0,
          passed_tests: ['baseline'],
          failed_tests: ['regression'],
          skipped_tests: [],
        },
      },
    ],
  ])('rejects contradictory passed %s results', (_name, result) => {
    expect(() =>
      parseVerificationOutcome([{ relativePath: 'result.json', content: JSON.stringify(result) }]),
    ).toThrow(/cannot be true while failed checks are reported/)
  })

  it('rejects passed results with no successful checks', () => {
    expect(() =>
      parseVerificationOutcome([
        {
          relativePath: 'result.json',
          content: JSON.stringify({
            resolved: true,
            passed_tests: [],
            failed_tests: [],
          }),
        },
      ]),
    ).toThrow(/cannot be true without at least one passed check/)
  })

  it('rejects ambiguous result discriminators', () => {
    expect(() =>
      parseVerificationOutcome([
        {
          relativePath: 'result.json',
          content: JSON.stringify({
            is_resolved: true,
            resolved: true,
            failure_mode: 'unset',
            parser_results: { check: 'passed' },
            passed_tests: ['check'],
            failed_tests: [],
          }),
        },
      ]),
    ).toThrow(/ambiguous.*is_resolved, resolved/)
  })
})
