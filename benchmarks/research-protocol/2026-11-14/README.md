# Public research protocol calibration — 2026-11-14

This record qualifies a narrow integration boundary: real public task import, one unchanged scientific artifact verifier, native result/campaign persistence, and the exact Harbor regrade CLI syntax. **No agent rollout, Harbor container run, full benchmark score, private task access or model judge call occurred.**

## Measured outcomes

| Check | Observed result | Scope |
| --- | --- | --- |
| TBS v0.1.0 recursive import | 70 unique task IDs, with native domain/configuration/artifact metadata retained | Public descriptions from a partial source checkout; external task data and environments are not generally hydrated |
| MKA public import | Ten task/rubric packages; RF task has all three real images, with hashes | Other nine packages are metadata-only; no official grader or official 200-task benchmark |
| BixBench pinned metadata | 205 unique question IDs; all rows declare version 1.5; 59 distinct data folders | JSONL inspected; no capsule downloaded or judge run; data folders do not independently verify the README's notebook count |
| ODE author-reference control | 8/8 upstream checks passed; Eval score 1 and passed true | Intentionally constructed from public author references to calibrate grading |
| ODE corrupted control | 5/8 checks passed; Eval score 0 and passed false | Schema remained valid; standard rollout nRMSE 0.570975, stress nRMSE 0.678501, vector-field relative error 0.5 failed native thresholds |
| Campaign persistence | One measured cell per control, preserving raw native evidence, bound artifact/definition identity and pass/fail | Normalized Eval summary only; native suite aggregation explicitly not computed |
| Pinned Harbor regrade CLI | `trial regrade --help` exited 0 and exposed the expected source/path/environment/output flags | No retained trial was regraded and no container was started |

The ODE checks use the author's unmodified `tests/test_outputs.py` and reference assets at `f81afac4f11048e77a15dfc8fb1dbfb897fea0ce`. The positive control copies the reference equations/predictions. The negative control scales both by 0.5, then computes valid schema/complexity metadata using the author's checker. It therefore tests numerical rejection rather than merely a missing-file or schema error. This is not a solution produced by an agent, nor evidence of discovering an unknown ODE.

## Files and identities

- [input-import.json](input-import.json) records the actual TBS roster and MKA counts, input hashes and completeness.
- [bix-metadata.json](bix-metadata.json) records the separately verified pinned JSONL URL, hash and counts.
- [ode-native/receipt.json](ode-native/receipt.json) joins the final native measurements and campaign reports.
- [ode-native/definition.json](ode-native/definition.json) is the exact frozen measurement definition. Its source digest covers only the relevant TBS/ODE pins; unrelated recipe additions do not change its identity.
- [ode-native/author-reference.result.json](ode-native/author-reference.result.json) and [ode-native/corrupted-vector-field.result.json](ode-native/corrupted-vector-field.result.json) contain the bound `BenchmarkResult`s and artifact-content digests.
- `ode-native/native/grade-01` through `grade-04` retain unchanged native stdout, JUnit XML and parsed measurements. Each control runs once through `evaluateResult` and once through the campaign path.
- The two campaign directories retain their actual result/identity/trace files and normalized benchmark reports. These are calibration runs, not benchmark agent scores.
- [harbor-cli-receipt.json](harbor-cli-receipt.json) records the exact source commit, six Git-blob/SHA-256 source checks, imported module path, dependency versions, command, exit code and scope. [harbor-regrade-help.txt](harbor-regrade-help.txt) is the native CLI stdout.
- [source-receipt.json](source-receipt.json) binds the relevant upstream sources and example implementation bytes used for this record.

No bulky upstream tasks, reference solutions, images or dependency directories are vendored into this evidence folder. The immutable URLs and hashes in the [example source manifest](../../../examples/benchmarks/research/sources.json) and receipts identify the public inputs. The example code remains in [examples/benchmarks/research](../../../examples/benchmarks/research/README.md).

## Reproduction

Follow the [example README](../../../examples/benchmarks/research/README.md) to fetch exact public sources, inspect them, install the five direct ODE dependency versions, prepare both controls, and execute the native adapter/campaign demonstration into a new output directory. The receipts preserve the exact local command argument arrays used here. Paths, timestamps, JUnit execution times and campaign IDs are expected to vary; source hashes, artifact hashes and pass/fail outcomes are the substantive checks.

The Harbor syntax probe used exact source `ec6aeab7fe0eb51df52b4e72c524daf5ea9cc5f4` ahead of an isolated `harbor==0.26.0` dependency installation on `PYTHONPATH`, then ran:

```sh
python -c 'from harbor.cli.main import app; app()' trial regrade --help
```

Its recorded source hashes were checked against the pinned Git tree. A successful help command establishes CLI argument compatibility only. To qualify real regrading, a separate run must provide a genuine retained Harbor trial, accessible artifact manifests and complete outputs, the declared target verifier environment, and a valid native result. That operation was not performed here.

## Limits

The ODE direct checker ran with pinned NumPy/SciPy/Pandas/SymPy/pytest versions, outside the author's Docker environment. Python, transitive dependencies, OS and hardware affect exact reproducibility. There was no adversarial containment check. Both controls deliberately had author-reference access, so they cannot be used as model capability or training-contamination evidence. API spend was zero because no model calls occurred; CPU and preparation costs were not monetized. Only one scientific verifier was calibrated, and the other recipes retain their native access, runtime and judging requirements.
