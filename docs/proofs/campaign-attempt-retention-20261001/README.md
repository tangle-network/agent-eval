# Campaign attempt retention

The published Eval 0.203.0 consumer overwrote earlier artifacts and traces during both retry and resume.
The candidate keeps every executed attempt in its own directory.
Native scheduling, success caching, and cumulative retry accounting retain their existing behavior.

## Observed behavior

| Public consumer action | Published baseline | Candidate |
| --- | --- | --- |
| Retry after capture | First artifact and trace overwritten | Both artifacts and traces retained |
| Resume after failure | First artifact and trace overwritten | Both artifacts and traces retained |
| Reuse a successful cache | Existing behavior | No new callback; original attempt identity retained |
| Continue beside historical files | Existing root captures | Four historical cell files remain byte-identical |
| Write outside the artifact directory | Outside this qualification | Parent path refused; identity hash unchanged |
| Reopen interrupted optimization | Outside this qualification | Original failed candidate recovered from its native ledger |

Each candidate attempt retains identity, artifact files, trace files, result, and its failure receipt.
Retry attempts share a run ID and use distinct attempt numbers.
Resume creates a new run ID.
The cell's latest-attempt pointer selects the current record without scanning history.
Agent receipts and judge inputs carry the exact run ID and attempt number.

The retry and resume qualification emitted four filesystem meter receipts.
Their zero estimates describe these operational file reads.
They do not represent provider billing.
Retry totals still include both attempts.
Judge attribution was also checked through the public callback.

## Execution and limits

Execution target: drew-gtr-pro, for SDK filesystem operations only.
No provider request, model inference, Sandbox research, or independent research unit occurred.
These results qualify capture retention; they make no coding, routing, or economic claim.
Discovery Lab #1115 retains its original held-out acceptance.

The maintained public entrypoints were Eval's `/campaign` `runEval` and `runOptimization`.
The candidate was built from the source identities in [source-and-build.json](artifacts/current/source-and-build.json).
That file includes every built module's digest and size.
The baseline used the installed, published 0.203.0 campaign export.

Run [reproduce.mjs](artifacts/current/reproduce.mjs) with `PROOF_ROOT` and `EVAL_MODULE` to reproduce the baseline overwrite.
Run [qualify.mjs](artifacts/current/qualify.mjs) with these environment variables:

- `PROOF_ROOT`: a new output directory.
- `BASELINE_ROOT`: the preserved predecessor evidence directory containing `before-resume`.
- `EVAL_MODULE`: the candidate's built `dist/campaign/index.js`.
- `EVAL_COST_MODULE`: the candidate's built `dist/index.js`.

Build, typecheck, and package verification completed successfully.
No unit tests were added or run.
The package check's normal CJS and node10 exclusions remain visible in its log.

## Evidence

[manifest.json](manifest.json) seals 160 operational evidence files, totaling 512,603 bytes.
The evidence contains no credentials or personal billing fields.
It preserves the original overwrite records and both failed instruments.

The first instrument used the root export instead of the campaign export and failed before dispatch.
The next instrument omitted an optimization judge and could not produce a quality score.
The final qualification uses the campaign export and an explicit operational judge.
The failed records remain under `artifacts/predecessor`.

- [Baseline reproduction](artifacts/current/reproduction-summary.json)
- [Complete candidate qualification](artifacts/current/after-summary.json)
- [Judge attribution](artifacts/current/judge-attribution.json)
- [Qualification receipt](artifacts/current/qualification.log)
- [Typecheck receipt](artifacts/current/typecheck.log)
- [Package receipt](artifacts/current/verify-package.log)
