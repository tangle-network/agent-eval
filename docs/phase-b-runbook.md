# Phase-B runbook (internal)

How we drive a design-partner pairing. Goes alongside
[`phase-b-pairing-kit.md`](./phase-b-pairing-kit.md) (the partner-facing
materials) — this file is for us.

---

## Before the pairing

- **24-48h prior:** send discovery questions from
  [`phase-b-pairing-kit.md`](./phase-b-pairing-kit.md). Don't run the
  pairing without answers in hand. The pairing fails when we discover
  the partner's quality bar live; we don't have time to interview AND
  build in 4 hours.
- **48h prior:** run the canonical demo (`pnpm tsx
  examples/marketing-agent-canonical/index.ts`) end-to-end against the
  partner's preferred model. Confirms the substrate + their LLM tier
  compose. If it errors, fix the substrate before the pairing.
- **24h prior:** mirror the partner's stack locally. If they're on
  Cloudflare Workers, run a Worker. On LangChain, install `@langchain/*`.
  Don't debug their tooling on the call.
- **1h prior:** open the pairing kit, the agent-eval repo, the partner's
  agent code/endpoint, a shared doc, and a screenshare ready.

## During the pairing

### Driving principles

- **Talk less, ship more.** The partner is paying with their time and
  attention; every minute we talk we aren't shipping their lift.
- **They write the judge.** We start with our strawman so they have
  something to react to, but the judge that ends up running is theirs.
  This is the most-discussed seam — they should own it.
- **No invented features.** Don't promise capabilities that don't exist
  ("we have a hosted ingest for this") unless they actually exist.
  Phase B is honesty's purest test.
- **Capture verbatim.** Write down their exact words on what's broken /
  what would change their mind. The wedge-gate evidence is qualitative
  too.

### When to escalate to Drew

- Partner wants something Phase D would have (hosted dashboard, multi-
  tenant, billing). **Escalate same day** — this is the GTM signal we're
  hunting for; Drew should hear it directly.
- Partner is the wrong fit (technical or business) and the pairing
  would burn both sides' time. **Pause the pairing**, debrief with Drew,
  reschedule with a better-fit partner.
- Substrate breaks in a way that requires a published bump. **Pause
  the pairing**, ship the fix in a focused PR, resume.

### What to capture for the wedge gate

Per [`docs/design/external-agent-wedge.md`](./design/external-agent-wedge.md),
the gate decision hinges on Phase B evidence. We capture:

1. **Quantitative lift** — held-out winner composite vs baseline, per
   scenario + overall. Auto-generated in the report artifact by the
   canonical demo (`.phase-b-runs/<ts>/phase-b-report.md`).
2. **Qualitative partner-validation** — partner read 3+ winner outputs
   and confirmed they're better. Capture as a 1-paragraph quote.
3. **Integration friction** — minutes spent on each pairing phase. Were
   any > 2x estimated? What broke?
4. **Judge-design surprise** — which dimensions the partner added or
   killed vs our strawman. Strong signal about what the substrate's
   default judge templates are missing for adjacent domains.
5. **Soft commitments** — would they reference us? Would they
   self-serve from the quickstart doc? Would they pay for hosted?

Capture into a single `phase-b-debrief.md` per partner. We don't
publish these; they feed the next substrate iteration + the wedge
go/no-go.

---

## Failure modes — what we do NOT do

### "We'll just optimize on the train set"

Hard no. The held-out gate is the entire point. A win that doesn't
generalize is worse than no win — it's evidence that the substrate
overfits, which is the failure mode the wedge tier rewards.

If the holdout lift is < threshold but train looks great:

1. Show the partner the gap. Explain what overfitting means here.
2. Try raising `maxGenerations` to 5 (gives gepa more search budget).
3. Try widening `populationSize` to 3 (more diverse mutations per gen).
4. If still no lift on holdout: **report the result honestly**. A
   negative finding is real evidence for us too — tells us this surface
   isn't amenable to prompt-only mutation, and the partner needs Phase
   C (code-tier optimization) or a different approach.

### "The judge is too noisy"

A judge whose two-run variance > 0.1 on the same artifact is broken.
Fixes, in order:

1. Lower temperature to 0.0 (the canonical judge uses 0.2, which is
   already low).
2. Use a stronger model than the agent (default: same model. Bump the
   judge to GPT-5.5 / Claude Opus.)
3. Add anchors to each dimension ("0.0 = X, 0.5 = Y, 1.0 = Z").
4. If still noisy: collapse to fewer, simpler dimensions. 3 unambiguous
   dimensions beat 6 squishy ones.

### "We can't decide what the partner's judge should be"

Then we don't have Phase B. The judge IS the partner's quality bar.
If they can't articulate it in 45 minutes of pairing, we're in the
wrong pairing — they need to do the interview-themselves work first.

**Pause the pairing, send the discovery doc again, regroup in a week.**

### "Their agent is slow / expensive"

`maxConcurrency: 1` and reduce scenarios to 6. Cost scales linearly;
time scales as `(scenarios × reps × generations × population) /
concurrency`. Tune until the loop completes in ≤ 30 min.

If the per-call cost is > $1, talk to Drew before the pairing — we
might want to subsidize the partner's first run.

### "They want to share their secrets through Tangle Router"

Fine — `OPENAI_BASE_URL=https://router.tangle.tools/v1` works. Make
sure they understand: every call routes through us; the prompts and
responses are visible to whatever observability we have on the router.
If they want zero data leaving their network, point at their own
endpoint, not Tangle Router.

---

## After the pairing

### Same day

- Save the `phase-b-report.md` artifact + the partner's debrief notes
  to `~/company/design-partners/<partner>/<date>/`.
- Send the partner a thank-you with the winner artifact + the next-
  steps doc. Whether or not we proceed to Phase D, leave them with
  something concrete they can ship in their product.
- Slack Drew the verdict against the [success criteria](./phase-b-pairing-kit.md#success-criteria--what-counts-as-phase-b-passed).

### Within a week

- If Phase B passed: open the Phase D RFC. Reuse the partner-validated
  judge dimensions + scenarios as the spec for what the hosted tier
  needs to support out of the box.
- If Phase B failed: substrate iteration ticket(s). Specific gaps the
  pairing surfaced (judge dim defaults, doc clarity, missing helper).
- Either way: update the wedge doc (`docs/design/external-agent-wedge.md`)
  with the partner-name redacted + the qualitative signal.

### Within a month (regardless of go/no-go)

- Followup with the partner. If they're still using the lib, capture a
  metric. If they stopped, find out why. Both data points feed product.

---

## The canonical demo as a forcing function

`examples/marketing-agent-canonical/` is the demo we open the pairing
with. It does three things at once:

1. **Proves the substrate works** — they see a real lift on a real-
   feeling agent before we touch their code.
2. **Sets the bar for the judge conversation** — they react to concrete
   dimensions, not abstract questions.
3. **Trains us** — running the canonical demo before the pairing
   surfaces substrate bugs on the partner's preferred model BEFORE the
   partner is watching. We hit those bugs first.

Run the canonical demo before every Phase-B pairing. It's not optional.
