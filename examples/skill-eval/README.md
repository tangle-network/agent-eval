# Skill eval: does one unit earn its place?

`runSkillEval` runs the same cases with a unit (a skill, a block of instructions, a profile difference) and without it, then a third time with a neutral text of the same length.
A judge sees each pair of answers with no arm label, in an order drawn from the seed.
The report gives one decision (keep, cut or inconclusive), the clause that decided it, and the rule.

```sh
pnpm tsx examples/skill-eval/index.ts
```

The agent and the judge in this example are simulated, so it runs offline and prints the same report every time.
It walks through two suites:

- 24 cases where the baseline passes 10 and the unit reaches 9 more. Judges prefer `with` over `without` and over the control: **keep**.
- 12 cases the baseline already passes. The eval stops after the `without` arm: **inconclusive**, because a suite that passes 100% is not evidence.

In real use, `run` starts your agent on the case with the arm's text applied and returns its answer, whether it passed the case's check, and what the run did; `judge` asks a model which of two answers is better.

Read [skill-eval.md](../../docs/skill-eval.md) for when to use the recipe and what it does not prove.
