# Examples

Start with the [root quickstart](../README.md#quickstart).
It is the shortest install-to-result path and runs without an API key.

Use this index when you have a specific integration task.

| Goal | Example | Requirements |
|---|---|---|
| Evaluate and improve a prompt | [`selfimprove-quickstart`](./selfimprove-quickstart) | Offline |
| Wrap an existing agent | [`foreign-agent-quickstart`](./foreign-agent-quickstart) | Offline; optional LLM key |
| Load folder-based eval cases | [`eval-fixtures-quickstart`](./eval-fixtures-quickstart) | Offline |
| Analyze human approvals and rejections | [`customer-feedback-loop`](./customer-feedback-loop) | Offline |
| Analyze OpenTelemetry spans | [`customer-otel-traces`](./customer-otel-traces) | Offline |
| Compare candidate-generation methods | [`compare-proposers-canonical`](./compare-proposers-canonical) | LLM endpoint |
| Package runs as training data | [`publish-rl-dataset`](./publish-rl-dataset) | Offline |
| Fine-tune with Prime Intellect | [`fine-tune-with-prime-rl`](./fine-tune-with-prime-rl) | Prime Intellect checkout |

Run an offline example from the repository root:

```sh
pnpm tsx examples/selfimprove-quickstart/index.ts
```

## Evaluation And Improvement

- [`selfimprove-quickstart`](./selfimprove-quickstart) defines one evaluation and calls `.improve()`.
- [`foreign-agent-quickstart`](./foreign-agent-quickstart) adapts an agent that already has its own runtime.
- [`multi-shot-optimization`](./multi-shot-optimization) evaluates several attempts per scenario.
- [`held-out-gate`](./held-out-gate) demonstrates a release rule without a full search loop.
- [`marketing-agent-canonical`](./marketing-agent-canonical) applies the same flow to a product-specific agent.
- [`findings-ablation`](./findings-ablation) compares improvement with and without prior failure findings.

## Existing Data

- [`customer-feedback-loop`](./customer-feedback-loop) converts multiple human ratings into run records and reports disagreement.
- [`customer-otel-traces`](./customer-otel-traces) converts OpenTelemetry spans into run records.
- [`scorecard`](./scorecard) records and compares scores over time.
- [`eval-fixtures-quickstart`](./eval-fixtures-quickstart) loads file-based cases and demonstrates cache reuse.

## Benchmarks And Training

- [`benchmarks`](./benchmarks) contains adapters for public benchmarks.
- [`compare-proposers-canonical`](./compare-proposers-canonical) compares candidate-generation methods on one shared task.
- [`substrate-lift-proof`](./substrate-lift-proof) is a live-provider research run, not a quickstart.
- [`publish-rl-dataset`](./publish-rl-dataset) exports supervised and preference-training rows.
- [`fine-tune-with-prime-rl`](./fine-tune-with-prime-rl) consumes those rows in a separate trainer checkout.

## Execution And Infrastructure

- [`distributed-driver`](./distributed-driver) coordinates work across processes.
- [`user-simulation-driver`](./user-simulation-driver) drives a multi-turn agent with a simulated user.
- [`same-sandbox-harness`](./same-sandbox-harness) runs setup, build, test, and scoring in one work directory.
- [`hosted-ingest-server`](./hosted-ingest-server) is a reference receiver for optional hosted events.

`_shared/` contains fixtures reused by multiple examples.
It is not a standalone example.
