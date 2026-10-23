# Bounded behavioral trace questions

`behavioralAnalyst` on `@tangle-network/agent-eval/analyst` retains its call-free arithmetic
pass. Its optional `traceQuestions` field adds explicitly selected event, turn and agent
windows. Callers supply a model, evaluator, its explicit `ExactExecutionComponentIdentity`, the existing findings ledger and a named,
versioned window extraction policy. The option refuses excess windows or bytes; it never
silently samples or truncates input. The default limits and fixed questions live in
`src/analyst/behavioral-trace-validation.ts` and `behavioral-trace-questions.ts`.

Each window names a source trace in the analyzed store, a subject, source references,
immutable timestamps and capture limitations. The caller owns extracting and sanitizing
the actual source content and resolving the references; membership in the trace store
does not certify that an arbitrary supplied excerpt faithfully represents that trace.
Native capture gaps stay explicit. Root-stream attempt numbers do not establish turns.
Selection policy settings belong in `windowPolicy.config`, so changing extraction changes
calibration identity. Never include labels, rewards, expected outputs or test answers in
`state`; independent gold travels only to the calibration reader.

The fixed battery has nine observations per window, including negative, unsure and
unavailable answers. Eight semantic questions share one native SystemOne request via
`decisionPoint`. Exact tool repetition is computed from tool names and canonical arguments
on distinct physical attempt IDs. Duplicate capture rows are deduplicated; conflicting
payloads for one attempt are refused. An incomplete tool capture can establish observed
repetition, but cannot establish its absence. Repetition alone makes no claim about waste.
The computed observation has no fabricated model identity, probabilities or paid receipt.

Decision intents, native records and question observations share the supplied findings
journal. A repeated analysis with the same run, explicit durable `analysisId`, configuration and windows
replays without another inference. Changing those inputs under the same invocation is a
conflict; use a new `analysisId` for an intentional new analysis. Observation times come from the
source window, so replays do not conflict merely because the wall clock advanced.
A concurrent reader of an unresolved intent cannot finalize observations. Registry logging correlation IDs may change across restarts without spending again.
Cancellation and deadlines suppress delivery while retaining paid work and durable records.
The existing analyst adapter supplies one shared budget and forwards every provider receipt;
missing usage remains unknown. A replay reports zero new physical calls, not a free model
receipt for a previous call.

## Independent calibration and alarms

`calibrateBehavioralTraceQuestions` joins independent `{questionId, windowId, label, source}`
gold rows to the emitted findings. It returns all nine per-question rows with exact n,
source counts, missing/unsure labels, missing predictions, abstentions, confusion counts,
agreement and Cohen's kappa from the existing statistics owner. Gold unsure/null labels
are exclusions, never No; missing predictions remain disagreements. Empty and degenerate
samples have null kappa. A missing prediction or one-class gold set cannot issue a routing
certificate. The minimum kappa is owned by `DECISION_POINT_MIN_KAPPA` on `/systemone`.

The evaluator identity covers transport, normalization, receipt interpretation, pricing and spending policy; it must change when those semantics change. It is captured once and bound in exact execution and calibration identities.

Certificates bind the exact question, option order, implementation version, evaluator identity, layer,
window policy, requested model and served model. Computed certificates bind the extractor
and policy with a null served model. Store their validation evidence in observation metadata;
`method.calibration` remains exclusive to judged findings. A label file is evidence only
for its declared scope: AgentRx root-cause categories are not labels for every question,
turn or agent, and an absent failure category is not a negative label.

Install returned certificates explicitly in `traceQuestions.calibrations` by layer and
question. Uncalibrated, mismatched, uncertain or failed judgments cannot alarm. A qualifying
positive recommends only `coordinator-alarm` for reversible investigation. This surface
has no pass/fail acceptance authority and performs no coordinator action itself.
Integration fixture labels test wiring only; they are never scientific calibration.

Before enabling real alarms, retain independent human/compatible AgentRx labels and the
per-question report. Diagnostic development anchors are not a sealed holdout or prevalence
estimate. Keep unseen calibration evidence for judging a changed rubric or extraction policy.
