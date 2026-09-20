# Ten useful integrations, one evaluator

Jev evaluates bounded questions. Applications supply state, questions and the policy interpreting
answers. jevEvaluator handles the native model; createEvaluator supports other classifiers.
asJudge and asAnalyst adapt the same operation to existing consumers.

| Use | Outcome | Existing execution path |
| --- | --- | --- |
| Completion evidence | Verify a deliverable against requirements and independent artifacts | Native questions plus deterministic checks; unresolved stays unresolved. |
| Recommendation triage | Prioritize evidence-linked Intelligence recommendations | Product triage selects existing engine findings and preserves their identities. |
| Trace diagnosis | Narrow likely failures before deeper investigation | AnalystRegistry, scoped evidence, and the existing deep analyst. |
| Behavioral review | Flag observable policy concerns, not hidden intent | Optional behavior-review recipe plus deterministic reward/control checks. |
| Rubric judging | Compare product or agent outputs | jevJudge/asJudge with caller mappings and independent final assessment. |
| Context selection | Select useful retrieved evidence | Native assessments, then deterministic packing with mandatory context protected. |
| Skill selection | Select from authorized capabilities | Caller alternatives, including no-selection; existing runtime executes actions. |
| Next verification | Choose a test, retrieval or review that resolves uncertainty | Existing graph checkpoints and awaited boundaries, not new permissions. |
| Candidate selection | Choose among generated plans or artifacts | Existing matrix/graph, exact checks first, semantic assessment second. |
| Configuration experiments | Compare questions, context, models and thresholds | examples/jev-decision-benchmark.ts using runAgentMatrix and cost receipts. |

These are compositions, not ten new frameworks. Product triage and the benchmark recipe are concrete
adoption work; other rows reuse existing APIs or identify application policies to configure. An API
or recipe is not proof that every domain policy has been validated or deployed.

## People, agents and evidence

Developers need typed decisions and attributable spend. Operators need evidence, uncertainty and
an actionable next check. Programmatic agents need stable JSON, explicit failure, a shared budget
and retained results. Benchmark authors need independent labels that never enter model requests.

Before execution, freeze inputs, independent source-unit splits, expected outcomes and configuration
versions. During execution, retain the native request/answer, served model, receipt, timings and
selected action. Afterwards, join independent outcomes, corrections and missing evidence. A model
explanation is not an independent outcome.

## Compare policies with the existing matrix

The compareDecisions recipe accepts cases, configurations and an ordinary evaluator. Each case
separates input from expected decision (or reviewed unresolved label) and sourceUnit. Question
builders receive only input. Mapping and recording failures remain failed cells with paid costs;
unknown spend is not measured free. Concurrency, repetitions and budget authority are caller-owned.

Report accuracy and automation coverage separately: always abstaining does not make a useful agent.
Reuse existing audit/calibration functions and independent source units rather than inventing another
statistics layer. The recipe chooses no default model, universal threshold or live request.

Changing only a mapping can re-score saved probabilities. Changing context, questions or actions
requires execution of the affected path. Compare verified outcomes and total spend, not report
length, finding count or how confidently a model declares success.
