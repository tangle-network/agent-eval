# Bounded behavioral trace questions

`behavioralAnalyst` on `@tangle-network/agent-eval/analyst` retains its call-free arithmetic
pass. Its optional `traceQuestions` field adds explicitly selected event, turn and agent
windows. Callers supply a model, evaluator, its explicit `ExactExecutionComponentIdentity`, the existing findings ledger and a named,
versioned window extraction policy. The option refuses excess windows or bytes; it never
silently samples or truncates input. The default limits and fixed questions live in
`src/analyst/behavioral-trace-validation.ts` and `behavioral-trace-questions.ts`.

Each window includes a nonempty bounded `events` list of `{ id, content, evidenceRefs }`.
IDs are unique within the window; `unresolved` is reserved. `content` is the sanitized event
text or JSON actually available to the judge. References must resolve retained immutable
source artifacts; the caller owns their retention and faithful extraction. The stored content
digest binds the supplied sanitized event, but does not certify an external artifact's availability.
The window byte cap covers these events as well as the rest of the window. `maxRequestBytes`
also bounds the canonical native body, including all questions and retained mapping, before
any dispatch. Neither cap truncates input.

Each window names a source trace in the analyzed store, a subject, source references,
immutable timestamps and capture limitations. The caller owns extracting and sanitizing
the actual source content and resolving the references; membership in the trace store
does not certify that an arbitrary supplied excerpt faithfully represents that trace.
Native capture gaps stay explicit. Root-stream attempt numbers do not establish turns.
Selection policy settings belong in `windowPolicy.config`, so changing extraction changes
calibration identity. Never include labels, rewards, expected outputs or test answers in
`state`; independent gold travels only to the calibration reader.

The fixed battery has nine observations per window, including negative, unsure and
unavailable answers. Eight semantic questions and eight ancillary supporting-event choices share one native
SystemOne request via `decisionPoint`, following DomainMatch's finite source-choice pattern.
Each support choice has the supplied event IDs plus an explicit `unresolved` option. It is
an independent classification of relevant evidence, not a generated rationale, causal grounding,
or a guarantee that another answer is justified. Unresolved support does not relabel a semantic
Yes/No or change its existing alarm eligibility. Ancillary policies are explicitly record-only;
they have no independent routing authority or calibration certificate.

The exact ordered `sourceMap` (window and trace IDs, event IDs, sanitized-content digests and
references) and its digest live in the persisted decision definition's support-question
instructions of `evidence.unverified-completion`; other support questions reference that
map owner and digest rather than copying the map. Replay reconstructs that map from the durable record and returns it in each
observation's `metadata.behavioral_trace_question.support`, including selected IDs, unresolved,
unavailable and probabilities. Source event content remains in the supplied state, so retain
the referenced artifacts to inspect the selected source. State/input digests alone are not
source retention. Changing IDs, content, references or map order under the same invocation
conflicts before dispatch. The versioned request contract invalidates old calibration certificates.

Exact tool repetition is computed from tool names and canonical arguments
on distinct physical attempt IDs. Each attempt also requires an explicit `eventId` in the
window. Computed positive support returns the matching attempts' source event IDs; a computed
absence or incomplete capture has unresolved support rather than an invented event. Duplicate capture rows are deduplicated; conflicting
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
agreement and Cohen's kappa from the existing statistics owner. Its `disagreements` list
shows every wrong, unsure or missing prediction with the selected event IDs/unresolved and
complete scoped map; historical findings without captured support return null. It never
invents pointers for old decisions. Semantic question digests stay independent of the event-ID
set, so this reader aggregates multiple windows/maps. Generic decision-point `reliability()`
instead groups the exact definition, which includes the map and can yield one-map samples;
that output is not a cross-map probability calibration or threshold-tuning claim. Gold unsure/null labels
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
