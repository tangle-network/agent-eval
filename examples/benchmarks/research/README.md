# Research benchmark protocols

These examples connect public research benchmarks to AgentEval's existing measurement and campaign contracts. They do not replace the benchmarks' runners, hide their access requirements, or define one universal research score. `sources.json` records the exact public revisions inspected on 2026-11-14. `definitions.ts` constructs a frozen measurement definition only after the caller supplies an exact task roster, metric, normalization, checker, and protocol pins. Constructing a definition is not an execution receipt.

## What has actually been checked

The retained [2026-11-14 receipts](../../../benchmarks/research-protocol/2026-11-14/README.md) distinguish three observations:

- The recursive Harbor importer loaded all **70 Terminal-Bench-Science v0.1.0 task descriptions**, retaining nested task IDs, domain metadata, raw configuration, and complete artifact mappings.
- The MKA example loaded **ten public tasks and their keyed rubrics**. One RF engineering task had all three real image inputs downloaded and hashed. Nine tasks remained metadata-only in this deliberately partial input package.
- The unchanged public ODE discovery verifier accepted an author-reference control (**eight checks passed**) and rejected a structurally valid control with a corrupted vector field and predictions (**five passed, three numerical checks failed**). Both outcomes passed through `createNativeBenchmarkAdapter.evaluateResult` and the campaign-backed `runBenchmarkAdapter`, with artifact-content hashes, raw native evidence and distinct pass/fail results.

The ODE demonstration executes the upstream Python checker directly with its pinned numerical dependencies. It does **not** start an agent, execute Harbor containers, qualify isolation, or report a benchmark solve rate. The reference control deliberately uses the author's public hidden-reference files. A separate exact-source Harbor `trial regrade --help` probe verifies the CLI invocation, not container execution.

## Availability and native boundaries

| Suite | Native input and execution | What this integration provides | What remains external |
| --- | --- | --- | --- |
| Terminal-Bench-Science v0.1.0 | Nested Harbor task directories; per-task native verifier | Actual recursive task import; direct ODE good/bad checker calibration; retained-trial regrade bridge | Full task data, images, container execution and any agent rollout |
| ALE-Bench | Sakana's Python session API, Docker compiler/judge, separately pinned problem archives | Pinned native protocol definition and session/measurement recipe | Native session execution, problem archive hydration and contest score projection |
| BixBench v1.5 | Original Jupyter/Aviary runner, or Harbor's maintained conversion | Explicit original/adapted protocol recipe and mandatory data/judge pins | Pinned data snapshot, environment, model/judge calls and parity qualification |
| PaperBench | Native `nanoeval`/Alcatraz rollout, reproduction and rubric judge | Pinned full/Code-Dev protocol recipe and weighted-rubric measurement contract | Git LFS data, reproduction compute, judge access and native execution |
| Agents' Last Exam v1.1 | `ale_run`/`cua_bench`, Python task load/setup/evaluate functions | Pinned release/assets/native-run recipe and explicit reference access boundary | Authorized gated references, applications, environment and native task execution |
| MKA public showcase | Ten metadata/rubric/input packages; no public official grader | Actual schema-preserving loader, input hashes and completeness flags | Any explicitly custom judge; the private official 200-task benchmark is unavailable here |

Only Terminal-Bench-Science is a native Harbor dataset among these six. Harbor maintains a BixBench converter; using it creates an adapted protocol. The other four keep their native execution boundaries. ALE-Bench and Agents' Last Exam are unrelated suites despite the shared abbreviation.

## Reproduce the public input and ODE checks

Run from the repository root. The input fetcher downloads approximately 8 MB of public source and sample data into a new directory. It executes no downloaded code. It verifies Git blob hashes, rejects unhydrated LFS pointers, and writes immutable source URLs and SHA-256 hashes. It intentionally does not hydrate external scientific datasets or Docker environments.

```sh
python3 examples/benchmarks/research/fetch-inputs.py /tmp/research-inputs
node --import tsx examples/benchmarks/research/inspect-inputs.ts \
  /tmp/research-inputs/terminal-bench-science-v0.1.0 \
  /tmp/research-inputs/mka-showcase /tmp/research-inputs/import-receipt.json

python3 -m venv /tmp/ode-verifier-env
/tmp/ode-verifier-env/bin/python -m pip install \
  numpy==1.26.4 scipy==1.13.0 pandas==2.2.2 sympy==1.13.1 pytest==8.4.1
/tmp/ode-verifier-env/bin/python examples/benchmarks/research/ode-control.py prepare \
  --task /tmp/research-inputs/terminal-bench-science-v0.1.0/tasks/mathematical-sciences/applied-mathematics/ode-law-discovery \
  --output /tmp/ode-controls
PYTHON=/tmp/ode-verifier-env/bin/python node --import tsx \
  examples/benchmarks/research/ode-verifier.ts \
  /tmp/research-inputs/terminal-bench-science-v0.1.0 \
  /tmp/ode-controls /tmp/ode-native-proof
```

Use new output directories. The checker validates upstream source/reference hashes and the five direct dependency versions before running all eight unchanged tests. An assertion rejection is a measured zero; missing dependencies, timeouts, skipped tests, collection errors or an incomplete result are errors. The adapter hashes artifact file contents before and after verification. The example also pins its responder via `dispatchRef` and checks that campaign persistence retains both measured outcomes. API spend is zero because no model runs; that does not measure CPU or preparation cost. Hardware, OS, Python and transitive dependency differences remain relevant to reproduction and are not a container parity claim.

## Terminal-Bench-Science and real Harbor trial regrading

Use the v0.1.0 commit in `sources.json`, not the moving default branch. The importer consumes `tasks/<domain>/<discipline>/<task>/task.toml` and `instruction.md`; it preserves `artifacts[].source`, `destination`, `service`, exclusions, metadata, and raw configuration. Agents and verifiers can have different network and environment settings. Importing metadata does not validate those environments.

For an **actual retained Harbor trial**, `gradeHarborTrial` delegates to the native command:

```sh
mkdir -p /tmp/regraded-trials
harbor trial regrade /path/to/existing/trial \
  -p /path/to/pinned/task -e docker \
  --trial-name regraded-trial --trials-dir /tmp/regraded-trials
```

The input must contain the real original `result.json`, artifact manifest and declared artifacts. Do not fabricate a trial from a loose solution directory. The output parent must exist outside the source trial. The helper preserves the original result and artifact provenance, binds source preconditions separately from the target verifier, checks `reward_valid`, and requires a chosen reward key when multiple metrics exist. Regrading may intentionally use a new verifier, so original and target task checksums need separate identities rather than forced equality. Multi-step sources require the corresponding completed sequence and separate verifier environments. Keep native exception policy and step results: a present reward alone does not establish validity, and not every recorded exception invalidates a reward. Regrading copies historical agent information; do not count its original model usage as new verification spend.

The pinned CLI source is [Harbor `trials.py`](https://github.com/harbor-framework/harbor/blob/ec6aeab7fe0eb51df52b4e72c524daf5ea9cc5f4/src/harbor/cli/trials.py); [result.py](https://github.com/harbor-framework/harbor/blob/ec6aeab7fe0eb51df52b4e72c524daf5ea9cc5f4/src/harbor/models/trial/result.py) defines the computed validity field.

## ALE-Bench: preserve the contest protocol

The [pinned native README](https://github.com/SakanaAI/ALE-Bench/blob/8ba16e6baf743aa8736516c45d1c52afdbd4de99/README.md) defines session creation and public/private evaluation. Code and data have separate revisions and licenses: Apache-2.0 code, CC-BY-ND-4.0 dataset. Set `ALE_BENCH_DATA` to the pinned Hugging Face snapshot before creating sessions; pin the compiler toolchain and Docker image digest as well. A small native binding uses these existing calls:

```python
import ale_bench

session = ale_bench.start(problem_id="ahc001", lite_version=False)
try:
    problem = session.problem  # statement, images and constraints for the candidate
    # The caller owns generation and the registered public-evaluation budget.
    # public_result = session.public_eval(code, code_language=language)
    # result, rank, performance = session.private_eval(final_code, code_language=language)
finally:
    session.close()
```

Use native `ProblemSerializable`/`ResultSerializable` when exchanging JSON with a TypeScript caller, preserving statement images and per-case results. Supply those task records through `createNativeBenchmarkAdapter.load`, and bind a caller-owned `StrategyChecker` that executes the official session API. Its `raw` measurement should retain per-case status/score/time/memory, native average/relative scores, rank, interpolated performance, and resource counters. The code above is a reference recipe, not an executed run here.

Native contest scores may be unbounded, and individual problems differ in minimization/maximization. Define a justified bounded Eval projection explicitly; never clamp raw scores or treat any positive contest score as “passed.” Preserve public/private seed separation, best-of/median selection, attempt count and final private evaluation. Native resource counters do not include all compilation/evaluation execution time. Machine load and time-limit behavior are part of the protocol; internal judge errors remain unmeasured.

## BixBench: choose the protocol before loading

The [original v1.5 repository](https://github.com/Future-House/BixBench/tree/49311180bdacb324c596f2e07596c126f2004008) describes 205 questions across 60 notebooks. Its native entry points are `bixbench/generate_trajectories.py --config_file ...` and `bixbench/postprocessing.py --config_file ...`. Retain notebooks, trajectories, question IDs, capsule/data identity, answer mode, judge model/prompt and replica IDs. Multiple-choice exact matching and open-answer semantic judging are different measurements. Majority voting across five replicas is not a single attempt or pass@5.

The [maintained Harbor adapter](https://github.com/harbor-framework/harbor/tree/ec6aeab7fe0eb51df52b4e72c524daf5ea9cc5f4/adapters/bixbench) provides conversion rather than requiring a duplicate runner. From that adapter directory:

```sh
uv run bixbench --question-id bix-37-q4 --commit ec6aeab7fe0eb51df52b4e72c524daf5ea9cc5f4
# A separately named terminal variant:
uv run bixbench --cli --question-id bix-37-q4 --commit ec6aeab7fe0eb51df52b4e72c524daf5ea9cc5f4
```

The converter reads native `question_id`, `data_folder`, `question`, `ideal`, and `eval_mode` fields; its internal `BixBenchRecord` calls `ideal` `ideal_answer`. Keep ideal answers exclusively in verifier data. It writes Harbor task/environment/solution/tests assets, expects the final XML-tagged answer at `/workspace/answer.txt`, and uses a model judge. A binary reward does not make that judge deterministic. Its notebook/CLI adaptations and judge prompt are not identical to the original runner.

**The adapter's `--commit` pins helper source URLs, not the Hugging Face dataset download.** At the inspected source, `load_dataset(..., split="train")` has no revision argument. The independently inspected dataset snapshot `f8cc3bdcc6357c88b8c3648306522b9c422dc95a` contains 205 JSONL rows and 59 distinct `data_folder` values; these are data packages, not a verification of the README's 60-notebook count. `sources.json` records that snapshot and metadata hash. Explicitly use and record the fixed snapshot when converting; `researchDefinition` requires its pin. Check the upstream image architecture and data credentials before attempting execution. No BixBench agent or judge was run here.

## PaperBench: preserve reproduction and weighted grading

The canonical [native code](https://github.com/openai/frontier-evals/tree/b78dab1da774a6456b1ed9c48c9ff194ee3ff36d/project/paperbench) is now under `openai/frontier-evals/project/paperbench`. Hydrate the intended Git LFS data rather than treating pointer text as a paper or rubric:

```sh
git lfs fetch --include 'project/paperbench/data/**' --exclude ''
git lfs checkout project/paperbench/data
```

Use native `PaperRegistry` for paper IDs and its resolved `config.yaml`, paper, addendum, assets, rubric and blacklist paths. Select the official 20-paper roster explicitly; the source also includes development/debug directories. The native entry point is `uv run python -m paperbench.nano.entrypoint` with the upstream run configuration. A caller-owned loader can export registry records with content hashes; the checker should ingest native `grade.json`, metadata/status and reproduction evidence, bound to the actual submission bytes and run identity.

Full PaperBench has separate rollout, clean reproduction, and rubric-judging stages. **Code-Dev**, selected with `paperbench.judge.code_only=True`, omits reproduction/result matching and must have a different definition. The rubric is a recursive tree of weighted requirements, not a flat mean over leaves. Preserve native leaf categories and recursive aggregation rather than applying AgentEval's mean score as the official PaperBench aggregate. Missing reproduction or unavailable grading is not a successful result. Native execution, model judging, LFS hydration and paper/data redistribution conditions remain outside this example's checked scope.

## Agents' Last Exam: release manifest and gated references

The [v1.1 asset manifest](https://github.com/rdi-berkeley/agents-last-exam/blob/2e91edd3cd26baa35a38127c90c8e5241dfbe62f/releases/v1.1/assets.json) pins public data, metadata, references, task lists and the Docker image. The release has 122 active tasks, including 119 CPU tasks; its 78-task Docker list is a subset, not the full suite. `sources.json` retains these distinct identities.

The task unit is a Python `main.py` with native load/setup/evaluate functions and a task card. Instructions can depend on runtime paths. Import through the native runner rather than extracting strings from Python source. The entry point is:

```sh
uv run python -m ale_run run my_experiment.yaml --dry-run
uv run python -m ale_run run my_experiment.yaml
```

The reference package is manual-gated; public input access does not establish reference access. Stage references after candidate execution as specified by the native setup. Keep the task scores, scorecards, application/environment state, trajectory and telemetry. Preflight reference availability: some native tasks return zero when reading a reference fails, which must not be mistaken for a meaningful agent failure. A native adapter must retain enough logs/status to distinguish that failure. The code/data licenses do not provide licenses for commercial applications. No native task execution or gated reference access was established here.

## MKA: public data is not the official evaluation service

`mka.ts` reads the actual uppercase metadata fields and the **object of keyed criteria** in `rubrics.json`. It preserves criterion weights, dependencies, grading targets and unrecognized native fields. `inputPolicy:'require'` refuses missing assets; `'metadata-only'` marks incomplete tasks and is suitable only for inspection. The source manifest binds all read bytes to recorded hashes; it is provenance from the public fetcher, not a signature authenticating an arbitrary third-party manifest.

The returned `items` contain the prompt, input references and provenance hashes. Raw native metadata, including rubric references, and the rubric itself are kept in a separate `gradingReferences` map; bind that map inside the checker's closure rather than supplying it to the responder. The generic API passes whole items to responders and does not enforce access isolation. The host must also keep grader files outside the candidate's filesystem/tools. These public samples are development controls, not fresh held-out tasks. Do not infer success from rubric schema validity or the presence of an answer file.

To evaluate a submitted artifact, supply an explicitly **custom** checker through `createNativeBenchmarkAdapter`, pin its model/tool identity and scoring rules, and record the per-criterion observations and artifact hashes. `researchDefinition` requires the protocol name to begin `custom-` and requires custom judge/aggregation pins. No official executable grader or previously judged solution is present in the public package. These ten examples therefore support a public-showcase study, not a score on the private 200-task official MKA benchmark.

## Adding another domain

Use the existing boundary: preserve the upstream task unit and source revisions in a loader; preserve its native execution in an injected `StrategyChecker`; define the exact roster, metric, normalization and checker with `defineBenchmark`; bind artifact contents with `artifactDigest`; execute through `createNativeBenchmarkAdapter` and `runBenchmarkAdapter`. Keep human/model judgments, objective checks, access restrictions and aggregation rules explicit. The campaign report summarizes normalized Eval scores; its `nativeAggregation: 'not-computed'` prevents that summary from impersonating an upstream leaderboard calculation.
