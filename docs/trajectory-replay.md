# Trajectory replay

`@tangle-network/agent-eval/trajectory-replay` re-executes a recorded shell trajectory and produces a verdict about what really happened.

The primitive is one question: replay steps `1..k-1` of a recording inside the image it ran in, execute step `k`, and does the recorded failure come back?
That question needs a recording, an image, and a way to run a command.
It does not need a running agent loop, so it is substrate, not runtime.

## The one thing you must supply

The package never depends on a sandbox client, a container runtime, or a model provider.
Every entry point takes the execution boundary as an argument.

```ts
import {
  type ReplayExecBackend,
  replayVerify,
} from '@tangle-network/agent-eval/trajectory-replay'

const backend: ReplayExecBackend = {
  async open() {
    const box = await myPlatform.create({ image })
    return {
      async exec(command, timeoutMs) {
        const r = await box.exec(command, { timeoutMs })
        return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr }
      },
      async close() {
        await box.delete()
      },
    }
  },
}

const verdict = await replayVerify({
  stepsPath: 'normalized/<traj>/steps.json',
  image: 'example/img:tag',
  at: 37,
  cwd: '/repo',
  out: 'out/proof',
  backend,
})
```

`open()` must return a FRESH environment every call.
Each arm replays the prefix in its own session, so a reused session would prove the corrected step against debris from the previous arm.

Entry points that resolve images themselves take a `ReplayExecBackendFactory` instead: `(image) => ReplayExecBackend`.
Those are `runReplayBatch`, `replayVerifyFinding`, and `verifyFindings`.

## Verdict shape

`replayVerify` runs up to two arms and writes `replay-verdict.json` plus `report.md` into `out`.

| Field | Meaning |
|---|---|
| `armA.failureSignatureMatch` | The recorded returncode came back, and the recorded error substring appeared. |
| `armB.failureVanished` | A corrected command exited 0 and the error substring was gone. |
| `prefixDivergences` | Prefix steps that did not confirm the recording, each with its `kind`. |
| `prefixDivergencePct` | Divergent steps over executed steps. This is the number an admission pre-pass gates on. |
| `prefixWithinTolerance` | `prefixDivergencePct` is at most `PREFIX_DIVERGENCE_TOLERANCE_PCT` (10). |
| `signatureBasis` | `returncode+output-substring`, or `returncode-only` when the recording carries no error line. |

## Prefix fidelity

A verdict is only as good as the state the prefix rebuilt.
Agreement therefore requires positive evidence: a prefix step counts as confirmed only when the recording carries a returncode AND the replayed exit equals it.

Every other step is a divergence of one of two kinds.

| Kind | Meaning |
|---|---|
| `returncode-mismatch` | The recording carries a returncode and the replayed exit differs. |
| `unknown-expectation` | The recording carries no returncode, so the replay was never checked. |

An `unknown-expectation` step is never agreement.
Counting it as agreement lets a replay that fails on every step report a perfect prefix, which makes every verdict built on that prefix meaningless.

`runReplayBatch` reports the same split per case and across the corpus, under `headline.prefixFidelity`.
Prefix divergence is reported, never hidden.
A high divergence rate is a finding about replay fidelity, not a harness error.

## Layers

| Module | Role |
|---|---|
| `steps` | The recorded step and its `<returncode>` / `<output>` grammar. |
| `exec` | The execution boundary and mini-SWE `/bin/sh` command wrapping. |
| `verify` | One case: prefix replay, arm A, optional arm B, `ReplayVerdict`. |
| `corpus` | Labeled corpora to replayable cases, with a reason for every exclusion. |
| `image-preparer` | Derive a replay-ready image from a recorded one. |
| `fix` / `fix-loop` | Generate and iterate arm-B corrections through an injected chat caller. |
| `batch` | Every replayable case to replayability and fix-flip rates. |
| `wire` / `findings` | One analyst finding to an executed, receipted proof. |

## Honest limits

Only trajectories that record their image are replayable.
A task whose environment needs external compose peers cannot be replayed this way.

A gold label on the submit step is never a replay target.
A submit decision has no executable failure to reproduce, so those cases are excluded and counted.

`dockerImagePreparer` shells out to `docker`.
Pass `preparer: null` on a corpus source when the images are already replay-ready.

Verified batch verdicts become RL rows through `src/rl/verified-findings-dataset.ts`; see [verified-labels-flywheel](./verified-labels-flywheel.md).
