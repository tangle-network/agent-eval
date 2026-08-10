import { describe, expect, it } from 'vitest'
import {
  checkInterventionBudget,
  classifyActionPayload,
  normalizeActionForComparison,
  SCAFFOLD_INTERVENTION_BUDGET,
  scanShellAction,
} from '../../src/trace-repair/action-budget'

function statements(script: string): string[] {
  return scanShellAction(script).statements
}

describe('one action is counted, not one line', () => {
  it('keeps a command list joined by operators as one statement', () => {
    expect(statements('cd /app && python -m pytest -x')).toHaveLength(1)
    expect(statements('make || echo failed')).toHaveLength(1)
    expect(statements('cat log | grep -i error | head -5')).toHaveLength(1)
  })

  it('splits a newline and a semicolon into separate statements', () => {
    expect(statements('rm a\nrm b')).toEqual(['rm a', 'rm b'])
    expect(statements('rm a; rm b')).toEqual(['rm a', 'rm b'])
  })

  it('keeps a trailing operator, a line continuation and a comment inside one statement', () => {
    expect(statements('cd /app &&\npython -m pytest')).toHaveLength(1)
    expect(statements('python \\\n  -m pytest')).toHaveLength(1)
    expect(statements('# fix the import\npython -m pytest')).toHaveLength(1)
  })

  it('keeps a compound block as one statement', () => {
    expect(statements('for f in *.py; do sed -i s/a/b/ $f; done')).toHaveLength(1)
    expect(statements('if [ -f x ]; then rm x; fi')).toHaveLength(1)
    expect(statements('while read l; do echo $l; done < in.txt')).toHaveLength(1)
    expect(statements('{ echo a; echo b; }')).toHaveLength(1)
  })

  it('does not split on a separator inside quotes or a substitution', () => {
    expect(statements('echo "a; b"')).toHaveLength(1)
    expect(statements("echo 'a\nb'")).toHaveLength(1)
    expect(statements('echo $(ls; pwd)')).toHaveLength(1)
    expect(statements('echo `ls; pwd`')).toHaveLength(1)
  })

  it('treats a heredoc body as payload, never as statements', () => {
    const action = "cat > /app/main.py <<'EOF'\nimport os\nprint(os.getcwd()); print(1)\nEOF"
    const scan = scanShellAction(action)
    expect(scan.statements).toHaveLength(1)
    expect(scan.heredocs).toBe(1)
  })

  it('counts an unterminated heredoc as one statement rather than splitting its body', () => {
    const scan = scanShellAction("cat > /app/f <<'EOF'\nline one\nline two")
    expect(scan.statements).toHaveLength(1)
    expect(scan.heredocs).toBe(1)
  })

  it('reads a tab-stripped and an unquoted heredoc delimiter', () => {
    expect(scanShellAction('cat > /app/f <<-EOF\n\tbody\n\tEOF\n').heredocs).toBe(1)
    expect(scanShellAction('cat > /app/f <<EOF\nbody\nEOF\n').statements).toHaveLength(1)
  })

  it('does not read a herestring as a heredoc', () => {
    expect(scanShellAction('grep x <<< "$VAR"').heredocs).toBe(0)
  })
})

describe('payload kind', () => {
  it('calls an inline file rewrite an edit and a command a shell action', () => {
    expect(classifyActionPayload("cat > /app/main.py <<'EOF'\nx = 1\nEOF")).toBe('edit')
    expect(classifyActionPayload('python -m pytest')).toBe('shell')
  })
})

describe('the budget rejects what the scaffold could not have done', () => {
  const shell = (action: string) => checkInterventionBudget(action, 'shell')

  it('admits one command inside the cap', () => {
    const check = shell('python -m pytest tests/test_main.py')
    expect(check.admissible).toBe(true)
    expect(check.measurement).toMatchObject({ statements: 1, heredocs: 0, payload: 'shell' })
  })

  it('rejects two actions dressed as one answer', () => {
    const check = shell('rm /app/wrong.py\npython -m pytest')
    expect(check).toMatchObject({ admissible: false, violation: 'multiple-statements' })
  })

  it('rejects an action over four kilobytes', () => {
    const check = shell(`echo ${'x'.repeat(SCAFFOLD_INTERVENTION_BUDGET.maxBytes)}`)
    expect(check).toMatchObject({ admissible: false, violation: 'over-byte-cap' })
  })

  it('rejects an edit that authors two files at once', () => {
    const action = "cat > /a <<'E1'\nx\nE1\ncat > /b <<'E2'\ny\nE2"
    const check = checkInterventionBudget(action, 'edit')
    expect(check.admissible).toBe(false)
    if (check.admissible) throw new Error('unreachable')
    expect(['multiple-statements', 'multiple-heredocs']).toContain(check.violation)
  })

  it('admits an action that misdescribes itself, and records both kinds', () => {
    // The scaffold runs the text either way, so the label cannot decide
    // admissibility; it is measured so a report can count the mismatch.
    const check = checkInterventionBudget("cat > /app/f <<'EOF'\nx\nEOF", 'shell')
    expect(check).toMatchObject({
      admissible: true,
      measurement: { payload: 'edit', declared: 'shell', heredocs: 1 },
    })
  })

  it('rejects the literal no-ops', () => {
    for (const action of ['true', ':', 'exit 0', ' /bin/true ']) {
      expect(shell(action)).toMatchObject({ admissible: false, violation: 'no-op-action' })
    }
  })

  it('rejects an empty action', () => {
    expect(shell('   \n  ')).toMatchObject({ admissible: false, violation: 'empty' })
  })

  it('rejects an action that submits the run instead of repairing it', () => {
    expect(shell('echo COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT')).toMatchObject({
      admissible: false,
      violation: 'submit-instead-of-repair',
    })
  })

  it('measures a rejected action so the report can count the violation by size', () => {
    const check = shell('rm a\nrm b\nrm c')
    expect(check.measurement.statements).toBe(3)
    expect(check.measurement.bytes).toBe(14)
  })

  it('refuses a budget that is not a positive integer', () => {
    expect(() =>
      checkInterventionBudget('echo x', 'shell', { maxBytes: 0, maxStatements: 1, maxHeredocs: 1 }),
    ).toThrow(/maxBytes/)
  })
})

describe('re-proposal comparison', () => {
  it('ignores trailing whitespace and a trailing blank line', () => {
    expect(normalizeActionForComparison('python -m pytest  \n')).toBe(
      normalizeActionForComparison('python -m pytest'),
    )
    expect(normalizeActionForComparison('a\nb  \n')).toBe(normalizeActionForComparison('a\nb'))
  })

  it('keeps a real difference visible', () => {
    expect(normalizeActionForComparison('python -m pytest -x')).not.toBe(
      normalizeActionForComparison('python -m pytest'),
    )
  })
})
