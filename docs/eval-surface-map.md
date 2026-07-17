# Eval surface map — which primitive, when

The eval surface is a small set of orthogonal primitives. They compose; they do
not overlap. If two seem interchangeable, read the "use when" — the distinction
is real and load-bearing. **Do not add a new wrapper to bridge two of these; the
composition point already exists (see Produced-state grading below).**

## The run\* primitives

| Primitive | Use when | Returns |
|---|---|---|
| `runCampaign` | The measurement primitive. Run a dispatch over scenarios × seeds × reps, score each with judges, aggregate. Caller owns the dispatch. | `CampaignResult` |
| `runEval` | The simplest preset over `runCampaign` — just score, no loop, no gate. The 80% "I want a scorecard" case. | `CampaignResult` |
| `runProfileMatrix` | Factor the SAME scenarios across N agent **profiles** (models / prompt variants), with RunRecord stamping + a real-backend integrity guard. | `RunRecord[]` |
| `runOptimization` | GENERATE: measured or validated premeasured baseline → N generations of propose → measure → rank → promote. No release gate. | generations + winner |
| `runImprovementLoop` | The release-gate shell around `runOptimization`: adds a held-out re-score + a promotion gate (+ optional auto-PR). | gate decision + winner |
| `runEvalCampaign` | Inversion-of-control variant of `runCampaign` — the runner is handed a pre-wired trace/sink/emitter and integrity gating as a precondition. Use when you need full capture by construction. | `CampaignResult` + records |
| `runAgentMatrix` | The bare N-axis cartesian scheduler with concurrency control. The layer beneath the eval surface — reach for it only when you need raw scheduling, not eval semantics. | cell results |

Mental model: **measure** (`runCampaign`/`runEval`) → **factor** (`runProfileMatrix`) →
**generate** (`runOptimization`) → **gate** (`runImprovementLoop`). `runEvalCampaign`
is `runCampaign` with capture inverted; `runAgentMatrix` is the scheduler underneath.

Merging any two of these conflates distinct mental models (measure ≠ search ≠
release-gate). Keep them separate; pick by the table.

## Produced-state grading — there is NO persona-dispatch wrapper

To grade what an agent actually **produced** (filed the proposal, wrote the
artifact) rather than what it said, the composition point is a **judge that wraps
`verifyCompletion`** — not a dedicated runner. The pipeline:

```
runtime/app-tool events ──► extractProducedState(events) ──► ProducedState
                                                                  │
                            verifyCompletion(taskGold, state, correctnessChecker)
                                                                  │
                            inject as a JudgeConfig into runProfileMatrix / runCampaign
```

`extractProducedState` is a pure function over the produced-event stream; the
judge calls it inline. This is why **`runProducedStatePersonaDispatch` does not
exist and should not be built** — it would be a fourth layer over a composition
that is already one judge. (Archetype: `playback.ts` `scoreUserStory`.)

### The in-band body contract

Produced events carry their **body in-band** — the grader never reaches into a
product database to recover it:

- `artifact` events carry `content` (the persisted file body).
- `proposal_created` events carry `content` (the `submit_proposal` description) —
  same role, same field name. A title-only filing omits it; a content-less
  proposal is graded presence-only (and, by the completion oracle's rule, does
  not count as a completed deliverable).

A consumer that finds itself re-fetching a deliverable's body from its own DB to
grade it is working around a thin event — fix the event (carry `content`), don't
add an enrichment band-aid.
