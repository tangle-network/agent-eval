# Examples

Start with the [offline quickstart](./selfimprove-quickstart/).
It defines cases, an agent, a judge, a starting prompt, and a custom candidate generator in one file.

## Evaluation And Improvement

| Goal | Example | Requirements |
|---|---|---|
| Improve with a custom `SurfaceProposer` | [`selfimprove-quickstart`](./selfimprove-quickstart/) | Offline |
| Wrap an existing agent | [`foreign-agent-quickstart`](./foreign-agent-quickstart/) | Offline or an OpenAI-compatible endpoint |
| Compare official GEPA and SkillOpt | [`compare-optimization-methods`](./compare-optimization-methods/) | Python optimizer packages and an LLM endpoint |
| Evaluate several attempts per case | [`multi-shot-optimization`](./multi-shot-optimization/) | Offline |
| Apply a release rule without search | [`held-out-gate`](./held-out-gate/) | Offline |
| Load folder-based cases | [`eval-fixtures-quickstart`](./eval-fixtures-quickstart/) | Offline |

Run an offline example from the repository root:

```sh
pnpm tsx examples/selfimprove-quickstart/index.ts
```

Run one official optimizer:

```sh
OPTIMIZERS=gepa \
LLM_API_KEY="$OPENAI_API_KEY" \
GEPA_PRICE_IN_PER_M=0.4 \
GEPA_PRICE_OUT_PER_M=1.6 \
pnpm tsx examples/compare-optimization-methods/index.ts
```

Replace the example rates with the exact endpoint rates.
Use `OPTIMIZERS=skillopt` for SkillOpt or `OPTIMIZERS=gepa,skillopt` for a shared comparison.
Read the [optimizer install instructions](./compare-optimization-methods/README.md) first.

## Existing Data

| Goal | Example |
|---|---|
| Analyze human approvals and rejections | [`customer-feedback-loop`](./customer-feedback-loop/) |
| Analyze OpenTelemetry spans | [`customer-otel-traces`](./customer-otel-traces/) |
| Record and compare scores over time | [`scorecard`](./scorecard/) |
| Reuse file-based cases and cached results | [`eval-fixtures-quickstart`](./eval-fixtures-quickstart/) |

## Benchmarks And Training

| Goal | Example |
|---|---|
| Run public benchmark adapters | [`benchmarks`](./benchmarks/) |
| Export supervised and preference rows | [`publish-rl-dataset`](./publish-rl-dataset/) |
| Fine-tune through Prime Intellect | [`fine-tune-with-prime-rl`](./fine-tune-with-prime-rl/) |

## Execution

| Goal | Example |
|---|---|
| Coordinate workers across processes | [`distributed-driver`](./distributed-driver/) |
| Evaluate a multi-turn simulated user | [`user-simulation-driver`](./user-simulation-driver/) |
| Run setup, execution, and scoring in one work directory | [`same-sandbox-harness`](./same-sandbox-harness/) |
| Receive optional hosted events | [`hosted-ingest-server`](./hosted-ingest-server/) |

`_shared/` contains fixtures reused by multiple examples.
It is not a standalone example.
