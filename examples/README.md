# Examples

Every directory holds one runnable file and a README that answers three questions: when to use it, how to run it, and why it is built that way.
Every expected output printed in a README is the output that file produces.

Start with [`evaluate-a-change`](./evaluate-a-change/).
It is the smallest complete path: cases in, scores out.

Run any offline example from the repository root:

```sh
pnpm tsx examples/evaluate-a-change/index.ts
```

## Measure A Change

| Goal | Example | Requirements |
|---|---|---|
| Score one change on the same cases | [`evaluate-a-change`](./evaluate-a-change/) | Offline |
| See the case grid before you pay for it | [`plan-before-you-spend`](./plan-before-you-spend/) | Offline |
| Wrap an existing agent | [`foreign-agent-quickstart`](./foreign-agent-quickstart/) | Offline, or an OpenAI-compatible endpoint |
| Evaluate several attempts per case | [`multi-shot-optimization`](./multi-shot-optimization/) | Offline |
| Apply a release rule without any search | [`held-out-gate`](./held-out-gate/) | Offline |
| Load cases from folders on disk | [`eval-fixtures-quickstart`](./eval-fixtures-quickstart/) | Offline |
| Record and compare scores over time | [`scorecard`](./scorecard/) | Offline |
| Run the same cases across several profiles | [`profile-matrix`](./profile-matrix/) | Offline |

## Improve A Surface

| Goal | Example | Requirements |
|---|---|---|
| Improve with your own candidate generator | [`selfimprove-quickstart`](./selfimprove-quickstart/) | Offline |
| Improve one prompt with official GEPA in one call | [`self-improve-optimizer`](./self-improve-optimizer/) | Python GEPA package and an LLM endpoint |
| Let another package own the text search | [`adapt-a-text-optimizer`](./adapt-a-text-optimizer/) | Offline |
| Compare official GEPA and SkillOpt | [`compare-optimization-methods`](./compare-optimization-methods/) | Python optimizer packages and an LLM endpoint |

Run one official optimizer:

```sh
OPTIMIZERS=gepa \
LLM_BASE_URL=https://api.openai.com/v1 \
LLM_API_KEY="$OPENAI_API_KEY" \
GEPA_PRICE_IN_PER_M=0.4 \
GEPA_PRICE_OUT_PER_M=1.6 \
pnpm tsx examples/compare-optimization-methods/index.ts
```

The optimizer's reflection calls run through a default execution owner built from `LLM_BASE_URL` and `LLM_API_KEY` (`createOpenAiCompatibleExecutionOwner` from `/campaign`).
Set `OPTIMIZER_EXECUTION_OWNER_MODULE` to route them through your own execution package instead.
Replace the example rates with the exact rates for your endpoint.
Use `OPTIMIZERS=skillopt` for SkillOpt, or `OPTIMIZERS=gepa,skillopt` for a shared comparison.
Set `GEPA_RECIPE` to run a composed GEPA recipe — `sequential`, `adaptive-sequential`, `best-of`, `vote`, or `omni` — instead of one engine run.
Read the [optimizer install instructions](./compare-optimization-methods/README.md) first.

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
| Analyze human approvals and rejections | [`customer-feedback-loop`](./customer-feedback-loop/) | Offline |
| Analyze OpenTelemetry spans | [`customer-otel-traces`](./customer-otel-traces/) | Offline |

## Benchmarks And Training

| Goal | Example |
|---|---|
| Run public benchmark adapters | [`benchmarks`](./benchmarks/) |
| Export supervised and preference rows | [`publish-rl-dataset`](./publish-rl-dataset/) |
| Fine-tune through Prime Intellect | [`fine-tune-with-prime-rl`](./fine-tune-with-prime-rl/) |

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
