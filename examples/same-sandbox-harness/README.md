# same-sandbox-harness

Wrap a real build/test pipeline as a single eval run that produces both
structured spans (build exit code, test output) and judge evidence — all
inside one workspace so later checks can inspect the artifacts.

## What it shows

- `SandboxHarness` + `SubprocessSandboxDriver` running `pnpm install / build /
  test` in a single `cwd`.
- `TraceEmitter` recording `startRun`, `recordJudge`, `endRun` events into a
  trace store.
- The "same sandbox" invariant: every phase writes to the same `workdir`, so
  later judges can read the artifacts that earlier phases produced (build
  outputs, test reports, screenshots, generated code).

## Run

```sh
pnpm install
pnpm exec tsx -e "
  import { runSameSandboxExample } from './examples/same-sandbox-harness/index.ts'
  const r = await runSameSandboxExample('/tmp/sandbox-demo')
  console.log(r.result.passed, r.result.score)
"
```

Or import `runSameSandboxExample(workdir)` from your own runner.

Runtime: depends on what's in `workdir`. With an empty dir the install/build
commands will error — the example is meant to be wrapped around a real
generated app, browser-checkout, or remote computer-use workspace.

## Expected output

```
true 1
```

…if the sandbox passes build + test. `false 0` otherwise.

## Adapt this to your agent

Swap `SubprocessSandboxDriver` for `DockerSandboxDriver` to get isolation,
network policy, and resource caps. Add `composeParsers(vitestTestParser,
jestTestParser, pytestTestParser)` to surface per-test pass/fail counts in
the run trace.
