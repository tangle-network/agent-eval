# App Grade

`@tangle-network/agent-eval/app-grade` grades a submitted app by operating its running production build.
A product adapts to it by writing a declarative task (`AppGradeTask`) or a hand-written `GradeLeaf`, and by passing a judge.

## A grading run

`gradeTask` grades a declarative task:

1. Start the task's product fresh. Either:
   - `ProductSpec` with `image`: the official image pinned by digest, on the Docker that `DOCKER_HOST` names;
   - `hosted`: a vendor's test mode with a fresh tenant per run, such as a Stripe connected account.
2. Run the spec's admin setup with a random admin secret.
3. Put a recording proxy between the app and the product. The app receives only the proxy URL and a scoped key the setup minted.
4. Serve the build (`serveApp`) and attest that the listener is the process this run spawned.
5. Drive the spec's browser journeys in Chromium (`EvidenceBrowser`), each in a fresh context. A goal step asks the judge which visible control serves a named purpose (`targetPicker`), then acts on that control itself.
6. Run deterministic checks on evidence the app cannot write: the product's own answers to admin reads, and the proxy's record of every app request.
7. Ask SystemOne only the questions that can still move the tier (`decidedWithoutReviews`).

The run directory holds the evidence:
- `server.log`, `network.jsonl`, `console.jsonl`, and per-journey steps, accessibility snapshots, screenshots and Playwright traces;
- `checks.json`, `integrity.json`, `jev/<review>.json`, `cost.json`, `manifest.json` and `verdict.json`.

`grade` runs the same steps for a hand-written `GradeLeaf`.

## Tier

`deriveVerdict` derives F, U, C, B, A or S from gates, never from a weighted blend.

| Condition | Tier |
| --- | --- |
| A floor check failed, or the app did not serve | F |
| A floor check is unmeasured and none failed | U (unable to measure; not a pass) |
| A journey check failed, or a core question was refuted | C |
| An engineering question is unresolved or refuted, or a build gate failed | B at most |
| A flow is unmeasured (the leaf's `unmeasured`) | A at most |
| Every gate holds | S |

A supported integrity question, or a failed integrity check, marks the cell `invalid` without moving its tier.

A consumer that ranks contestants must count a U cell as unmeasured and keep it in the denominator.

## Trust boundary

The app runs arbitrary JavaScript in its own realm, so the grader decides nothing on what that realm can write.

- DOM reads (control lists, control state, page text) run in a CDP isolated world. Patched prototypes and getters cannot change what the grader reads.
- The grader offers the picker only controls a buyer can see (`PAINTED`):
  - a box of at least 8 x 8 px;
  - cumulative opacity of at least 0.1;
  - no clipping;
  - something drawn in the box.

  An invisible decoy is never pressed. A press checks actionability first; a control that fails it fails its check without throwing.
- A vendor window (`walletOrigin`) is recorded inside its own realm. Records reach Node through a binding that accepts calls only from that origin's main frame. A call from anywhere else is page code: it is kept in `forgery-attempts.jsonl`.
- `integrity.noAutomationProbe` fails app source that probes for an automated browser, because such an app can show the grader a different app than its buyers get.
- The integrity question reads source, every captured screen, console lines and app-origin payloads. It replaces the browser's own user agent with a marker first. Vendor telemetry about the grader's browser is not app text.

## Judge

The picker and the reviews ask an `AppGradeJudge`: a `ChatClient` plus the reference every receipt names, and the rates the cost ledger uses.
Any transport serves: `createChatClient({ transport: 'openai-compatible', baseUrl, apiKey })` for the Router or cli-bridge, `sandbox-sdk` for a Tangle Sandbox box, or `custom` for the caller's own.
This package reads no credential.

SystemOne questions read raw evidence only: screens, the grader's actions, source, console lines and network payloads.
No check status, build gate or derived tier reaches a model.
`chatSystemOneTransport` asks a chat model for SystemOne's native answer shape, a distribution over each question's alternatives, because the native route is not served. The probabilities are the model's stated distribution.

## Install

Playwright is an optional peer dependency.
Everything except `EvidenceBrowser.launch` runs without it, so specs, verdicts and calibration records load in a process with no browser.
A grading process installs `playwright` and its Chromium (`npx playwright install --with-deps chromium`).

## Limits

- Painted-text checks do not detect text covered by another element, or text drawn in the background color.
- An automation probe that neither `automationProbes` nor the integrity question recognizes, such as an obfuscated one, still shows the grader a different app.
- Put submission workdirs outside any tree with a `node_modules` ancestor: TypeScript loads ancestor `@types` packages, and they change the typecheck gate.
