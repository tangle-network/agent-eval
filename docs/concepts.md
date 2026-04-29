# Concepts

Read this once and the rest of agent-eval makes sense.

## What is agent-eval?

A library for **deciding whether a code generator or content generator did its job.** You give it a thing the generator produced (a scaffold, a patch, a tweet, a JSON config), and you get back a structured verdict: pass/fail, dimension scores, a reason in plain English.

It exists because LLMs lie about whether they succeeded. A model will say "Done!" and ship code that doesn't compile. agent-eval is the layer between the model's output and your decision to ship.

## The three things you'll touch most

| Thing | What it is | One-line example |
|---|---|---|
| **Judge** | A function that scores one piece of output. | "Did this scaffold implement async fetching?" |
| **Rubric** | The recipe a judge uses — what to score on, with what weights. | "Score on buyer_quality (0.5), voice (0.3), signal (0.2)." |
| **Verifier** | A pipeline of judges run in order, with dependencies. | "install → typecheck → build → semantic" |
| **Feedback trajectory** | A multi-shot record of attempts, approvals, rejections, edits, metrics, and policy outcomes. | "draft → user rejects → revised draft → approved → measured" |

That's the whole framework. Everything else (sessions, traces, layers) is plumbing around those three.

When the thing being evaluated is an agent that should keep working, use
[`runAgentControlLoop`](./control-runtime.md). It turns validators into a
runtime loop: observe typed state, validate it, decide the next action, act,
and repeat until the task passes, blocks, times out, spends too much, or stops
making progress.

When normal agent usage should become reusable training/eval signal, use
[`FeedbackTrajectory`](./feedback-trajectories.md). It captures approvals,
rejections, edits, option choices, metrics, and policy blocks as portable data
that can seed memory, replay scenarios, and optimization.

## Vocabulary, plain English

| Term | Plain English |
|---|---|
| **Artifact** | The thing being judged. Often a workdir of files, sometimes a string of text. |
| **Snapshot** | A frozen view of an artifact (every file path → content). What the judge actually reads. |
| **Harness** | A description of *how to run* the artifact: setup command, test command, working dir, timeout. |
| **Sandbox driver** | The thing that actually executes commands inside the harness. Local subprocess, or remote container. |
| **Layer** | One stage of a verifier pipeline (install, typecheck, build, semantic, …). |
| **Finding** | A specific issue a judge found — file, line, severity, message. |
| **Trace store** | The append-only log of every span/event during a run. Replay = read this back. |
| **Composite score** | A 0..1 number combining all dimensions. The single number you gate on. |
| **Rubric version** | A stable hash of the rubric. Scores from different rubric versions are not comparable. |
| **Muffled gate** | A check that should fail loud but silently passes (e.g. `command || true`). The most expensive bug class in this codebase — see SKILL.md. |

## The feedback trajectory loop

For agentic systems, the highest-quality labels often come from normal review
workflow, not a separate labeling UI:

```text
agent proposes -> user approves/rejects/edits/selects -> agent revises -> outcome is measured
```

`FeedbackTrajectory` is the portable record of that loop. Browser agents can
store task outcomes, coding agents can store patch review plus test results,
and research agents can store reviewer corrections. The domain changes; the
shape stays the same.

Those trajectories can be converted into preference memory, `DatasetScenario`
rows, optimizer rows, and held-out examples for overfit checks.

## The three-layer eval (for code generators)

When the artifact is generated code, agent-eval scores it at three independent layers. Each layer fails differently, and you want to know which one broke:

```
L0  builder        Did the agent's session itself work?
                   (Did it produce an artifact at all?)
                              │
                              ▼
L1  app-build      Does the artifact build / typecheck / test?
                   (Static signal, ground-truth gate.)
                              │
                              ▼
L2  app-runtime    Does the artifact actually run end-to-end?
                   (Dynamic signal — only worth checking if L1 passed.)
```

`BuilderSession` orchestrates this. It opens at `startChat`, runs the build at `ship`, runs the runtime check at `runAppScenario`. Each layer emits a trace span. Composite score aggregates them with `scoreProject`.

Why three? Because each catches a different failure mode:
- L0 misses — agent crashed mid-generation, you have a half-written file.
- L1 misses — files exist but typecheck fails. LLM judges can't reliably catch this.
- L2 misses — code compiles but does the wrong thing at runtime.

If you only check one layer, you ship the bugs that the other two layers would have caught.

## How rubrics work

A rubric describes:
1. **Dimensions** — the axes you score on (e.g. `buyer_quality`, `voice`, `signal`).
2. **Weights** — how to combine dimensions into a composite (`0.5 * buyer_quality + 0.3 * voice + 0.2 * signal`).
3. **Failure modes** — named patterns the judge looks for ("ai-cadence", "vague-claim").
4. **Wins** — named positive patterns ("specific-component", "earned-detail").
5. **System prompt** — what to tell the judging LLM about the persona and the task.

Built-in rubrics ship in `src/wire/rubrics.ts` (e.g. `anti-slop` for technical-buyer voice). You can also pass a rubric inline — the same shape, just defined at the call site.

A rubric is plain data. The hash of that data is the `rubricVersion`. Two scores are only comparable if they used the same `rubricVersion` — change the rubric and you start a new comparison series.

## How verifiers work

When you have a multi-step pipeline (install → typecheck → build → lint → semantic), use `MultiLayerVerifier`:

```ts
const verifier = new MultiLayerVerifier([
  installLayer,      // runs `pnpm install`
  typecheckLayer,    // runs `tsc --noEmit`, depends on install
  buildLayer,        // runs `pnpm build`, depends on typecheck
  semanticLayer,     // LLM judge, weight 3, depends on build
])

const report = await verifier.run({ env: { runner, workdir, ... } })
report.allPass        // boolean — every layer passed
report.blendedScore   // 0..1 — weighted aggregate
report.layers         // per-layer status, findings, duration
```

Two rules that will save you bugs (paid for in real incidents — see SKILL.md):

1. **Run both gates.** Build gates catch code that doesn't compile; structural assertions catch missing files. Run both unconditionally — they catch orthogonal failures.

2. **Pair LLM judges with build outcomes.** An LLM judge will rate non-compiling code as "looks right" (0.8). Always short-circuit on `buildOutcome.passed === false` before any LLM judging.

## The trace model (skip on first read)

Every operation emits structured spans into a `TraceStore`. A run is a tree:

```
builder-session                 [span]
├── chat-turn                   [span]
├── ship                        [span]
│   ├── harness.install         [span]
│   ├── harness.typecheck       [span]
│   └── harness.build           [span]
└── app-runtime                 [span]
    └── scenario.run            [span]
```

Spans are append-only and have stable ids — replay is reading the same store back. OTLP export ships them out for distributed tracing.

You don't need to build the trace tree by hand. `BuilderSession` does it for you. Look at the trace store when you're debugging a flaky run; ignore it otherwise.

## Where to go next

- **Need the layman feature map?** → [feature-guide.md](./feature-guide.md) — what each primitive does, when to use it, integration patterns, and guardrails.
- **Just want to score a string against a rubric?** → [wire-protocol.md](./wire-protocol.md) — HTTP/RPC interface, pluggable from any language.
- **Need a reusable driver/worker/evaluator loop?** → [control-runtime.md](./control-runtime.md) — generic runtime plus coding, browser, computer-use, and research integration patterns.
- **Want review feedback to become eval/optimization data?** → [feedback-trajectories.md](./feedback-trajectories.md) — turn feedback into datasets, optimizer rows, and preference memory.
- **Building a code-generator eval?** → SKILL.md §Minimal working path — the `BuilderSession` recipe.
- **Multi-layer verifier?** → SKILL.md §Verification pipeline.
- **Adding a new judge or rubric?** → `src/wire/rubrics.ts` for the cross-language path; `src/anti-slop.ts` and `src/judges.ts` for the in-process path.
