# Examples

Start with [`evaluate-a-change`](./evaluate-a-change/).
It is the smallest complete path: cases in, scores out.

Install and build from the repository root, then run the first offline example:

```sh
pnpm install
pnpm build
pnpm exec tsx examples/evaluate-a-change/index.ts
```

## Measure A Change

| Goal | Example | Requirements |
|---|---|---|
| Score one change on the same cases | [`evaluate-a-change`](./evaluate-a-change/) | Offline |
| See the case grid before you pay for it | [`plan-before-you-spend`](./plan-before-you-spend/) | Offline |
| Wrap an existing agent | [`foreign-agent-quickstart`](./foreign-agent-quickstart/) | Offline |
| Evaluate several attempts per case | [`multi-shot-optimization`](./multi-shot-optimization/) | Offline |
| Apply a release rule without any search | [`held-out-gate`](./held-out-gate/) | Offline |
| Load cases from folders on disk | [`eval-fixtures-quickstart`](./eval-fixtures-quickstart/) | Offline |
| Record and compare scores over time | [`scorecard`](./scorecard/) | Offline |
| Run the same cases across several profiles | [`profile-matrix`](./profile-matrix/) | Offline |

## Improve A Surface

| Goal | Example | Requirements |
|---|---|---|
| Improve with your own candidate generator | [`selfimprove-quickstart`](./selfimprove-quickstart/) | Offline |
| Declare source units, audit a checker, and retain fresh final evidence | [`evaluation-integrity`](./evaluation-integrity/) | Offline; build the package first |
| Improve one prompt with official GEPA in one call | [`self-improve-optimizer`](./self-improve-optimizer/) | Python GEPA package and an LLM endpoint |
| Let a metered coding agent drive the optimization | [`agent-engine-optimizer`](./agent-engine-optimizer/) | Python GEPA package, the `claude` CLI, and an LLM endpoint |
| Let another package own the text search | [`adapt-a-text-optimizer`](./adapt-a-text-optimizer/) | Offline |
| Compare official GEPA and SkillOpt | [`compare-optimization-methods`](./compare-optimization-methods/) | Python optimizer packages and an LLM endpoint |

Use the comparison guide for [installation](./compare-optimization-methods/README.md#install) and [running selected methods](./compare-optimization-methods/README.md#run).
It also documents endpoint settings, rates, execution owners, and GEPA recipes.

## Prove A Result

| Goal | Example | Requirements |
|---|---|---|
| Register the rules before the data arrives | [`sealed-experiment`](./sealed-experiment/) | Offline |
| Certify a result that has no answer key | [`verify-without-an-answer-key`](./verify-without-an-answer-key/) | Offline |
| Track reps, verdicts, and evidence per candidate | [`experiment-evidence`](./experiment-evidence/) | Offline |

## Read Existing Data

| Goal | Example | Requirements |
|---|---|---|
| Get a report from runs you already have | [`analyze-existing-runs`](./analyze-existing-runs/) | Offline |
| Get cited findings out of a failed batch | [`custom-trace-analyst`](./custom-trace-analyst/) | Offline |
| [Analyze human approvals and rejections](../docs/customer-journeys.md#2-analyze-human-ratings) | [`customer-feedback-loop`](./customer-feedback-loop/) | Offline |
| [Analyze OpenTelemetry spans](../docs/customer-journeys.md#1-analyze-existing-traces) | [`customer-otel-traces`](./customer-otel-traces/) | Offline |

## Benchmarks And Training

| Goal | Example |
|---|---|
| Run public benchmark adapters | [`benchmarks`](./benchmarks/) |
| Compare optimizers on AppWorld tasks | [`AppWorld`](./benchmarks/appworld/) |
| Export supervised and preference rows | [`publish-rl-dataset`](./publish-rl-dataset/) |
| Fine-tune through Prime Intellect | [`fine-tune-with-prime-rl`](./fine-tune-with-prime-rl/) |

The AppWorld comparison requires separate AppWorld and optimizer Python environments, plus an LLM endpoint.

The GSM8K comparison reads a local dataset file from `AGENT_EVAL_GSM8K_PATH`.
Produce it from the GSM8K test split with Python and `datasets`:

```sh
mkdir -p ~/.cache/agent-eval
python -c "from datasets import load_dataset; import json; \
  [print(json.dumps({'id': f'gsm8k-test-{i}', 'question': r['question'], 'answer': r['answer']})) \
   for i, r in enumerate(load_dataset('openai/gsm8k', 'main', split='test'))]" \
  > ~/.cache/agent-eval/gsm8k.jsonl
```

or, without Python, from the upstream source of the Hugging Face dataset:

```sh
mkdir -p ~/.cache/agent-eval
curl -L https://raw.githubusercontent.com/openai/grade-school-math/master/grade_school_math/data/test.jsonl \
  | jq -c '{id: ("gsm8k-test-" + (input_line_number | tostring)), question, answer}' \
  > ~/.cache/agent-eval/gsm8k.jsonl
```

Each output line holds `{id, question, answer}` — the exact shape [`benchmarks/gsm8k/index.ts`](./benchmarks/gsm8k/index.ts) loads.

## Execution

| Goal | Example |
|---|---|
| Coordinate workers across processes | [`distributed-driver`](./distributed-driver/) |
| Run setup, execution, and scoring in one work directory | [`same-sandbox-harness`](./same-sandbox-harness/) |
| Receive optional hosted events | [`hosted-ingest-server`](./hosted-ingest-server/) |

`_shared/` holds fixtures reused by several examples.
It is not a standalone example.
