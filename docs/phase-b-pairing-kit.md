# Phase-B partner pairing kit

Everything we hand a design partner — the pitch, the discovery doc,
the judge worksheet, the 4-hour pairing agenda, the success criteria.

> This file is **partner-facing**. The internal driving runbook is in
> [`phase-b-runbook.md`](./phase-b-runbook.md).

---

## The pitch (one-pager)

You have a working agent. You don't have evals. You don't have a
self-improvement loop. You don't know which prompt change actually
made the agent better last week.

We have all of that on a shelf — same engine our six internal product
agents use in production. It's open source, free at the LAND tier, and
sandbox-free if you don't want our sandbox.

**The Phase-B offer:** in one 4-hour pairing, we wrap your agent
behind our `Dispatch`, author your domain-specific judge with you,
and run one real campaign + improvement loop on **your actual use
case**. You walk away with:

- A reproducible eval harness against scenarios you control.
- A judge that scores your outputs on dimensions you defined.
- One measurable lift on your real product, with a held-out gate.
- Trace artifacts you own (locally on disk; nothing leaves your
  network unless you point at our hosted tier).

What we get: design-partner evidence the substrate works on a foreign
agent we did not build. That validates the wedge for us. Nothing else
changes hands.

**Cost to you:** 4 hours of pairing + your LLM bill for the campaign
run (typically $5-$50 depending on model + scenario count). No
commitment, no contract, no exclusivity. We don't take your code, your
data, or your secrets.

---

## Discovery questions (15 min, before the pairing)

Send these to the partner ahead of the pairing so they walk in with
their answers.

### About the agent

1. What does your agent **do** — one paragraph, end-user perspective?
2. What's the **input** it accepts and the **output** it produces?
   (Schemas help; English is fine.)
3. What framework / stack? (LangChain / Mastra / OpenAI Agents SDK /
   bespoke / something else.)
4. Where does it run? (Local node / serverless / your sandbox /
   browser / mobile / other.)
5. What model(s) does it use today? Any model-routing layer
   (OpenRouter, Portkey, your own)?

### About quality

6. How do you currently know your agent is good? (Eyeballing /
   user feedback / metrics / nothing yet — all fine answers.)
7. What does a **bad** output look like for you? Give 2-3 concrete
   examples. Be specific.
8. What does a **good** output look like? Same.
9. Are there outputs that are *technically correct but feel wrong*?
   What's the signal?
10. How would a senior person on your team **score** an output, if
    they had to give it a 1-10? Walk us through the rubric they'd
    use, even informally.

### About the loop

11. If we could improve one thing about the agent in 4 hours, what
    would move the needle the most for you?
12. Are there *prompt* changes you've wanted to try but haven't had
    the loop to validate?
13. Anything you've explicitly tried that **didn't** work? (Saves us
    suggesting it.)

---

## Judge-design worksheet (45 min into the pairing)

The judge is the most under-discussed piece of an eval system. Most
projects fail at the judge, not the agent.

We start with a **strawman** — the 6 dimensions in our canonical
marketing-quality judge:

| Dim | What it measures |
|---|---|
| hook_strength | Opens with concrete user outcome, not category |
| voice_match | Reads human-written; no AI slop |
| cta_clarity | Next step unambiguous for the audience |
| factual_grounding | Only claims things the brief supports |
| surface_fit | Length + register correct for medium |
| audience_specificity | Vocabulary the audience actually responds to |

**Your job in this 45 min:** rip this apart. We expect:

- **2-3 of these are wrong for you.** Replace them.
- **2-3 dimensions are missing.** Add them. (E.g., "tone matches our
  brand book" or "safety-critical claim has a citation" or "answer is
  decisive — no hedging when the user wants a recommendation".)
- **Weights are wrong.** For your use case some dims matter 5x more.

The deliverable: a judge with 4-8 dimensions, each scored 0.0 - 1.0,
each unambiguous enough that two independent humans would score the
same artifact within 0.1.

If a dimension is squishy, throw it out. A noisy judge poisons the
loop.

---

## The 4-hour pairing agenda

### Hour 1 — Discovery + Dispatch wiring

| Time | What | Deliverable |
|---|---|---|
| 0:00 - 0:15 | Review discovery answers, align on scope | Shared doc with goals + constraints |
| 0:15 - 0:45 | Wire `Dispatch` around their agent — typically 1 function | Working `Dispatch<TScenario, TArtifact>` |
| 0:45 - 1:00 | Run 1-2 scenarios through `Dispatch` manually; see real artifacts | Confirmed wire shape |

### Hour 2 — Judge calibration

| Time | What | Deliverable |
|---|---|---|
| 1:00 - 1:45 | Walk through the strawman judge; redesign dimensions with the partner | Final `JudgeConfig` for their domain |
| 1:45 - 2:00 | Calibrate judge against the 2 manual outputs from Hour 1 | Confirmed judge gives same scores a human would |

### Hour 3 — First campaign + tuning

| Time | What | Deliverable |
|---|---|---|
| 2:00 - 2:30 | Define 8-15 scenarios with the partner (or use ours as a template) | Scenario set with train + holdout split |
| 2:30 - 3:00 | Run `runEval` for baseline; review per-scenario scores | Baseline score + identified failure modes |

### Hour 4 — Improvement loop + go/no-go

| Time | What | Deliverable |
|---|---|---|
| 3:00 - 3:30 | Configure `runImprovementLoop` with `gepaDriver` (3 generations, population 2) + `defaultProductionGate` | Improvement run completes |
| 3:30 - 3:50 | Walk the partner through the gate decision + lift per scenario | Report artifact |
| 3:50 - 4:00 | Capture: was the lift real? Would they ship the winner? Will they keep using the lib? | **Go/no-go signal for Phase D** |

If we're tracking ahead at any hour, use the slack to deepen — add a
red-team battery, swap the judge model, run more generations. If we're
behind, cut the scenario set to 6 and ship.

---

## Success criteria — what counts as Phase B passed

For us to greenlight Phase D (hosted orchestrator + metered billing),
we need ALL of:

1. **Real lift.** Held-out winner score > baseline by ≥ 0.05 composite
   points (or the partner's chosen threshold). Not just train; held-out.
2. **Partner-validated lift.** The partner reads the winner output on
   3+ held-out scenarios and confirms it's actually better.
3. **Integration time ≤ 1 day.** Discovery + wiring + judge took ≤ 4
   hours for the pairing; partner could reach the same point solo in
   ≤ 1 day from the quickstart doc.
4. **Public commitment.** Partner agrees to a public reference (case
   study / quote / logo) OR commits to running the LAND tier in their
   own product within 2 weeks.

3-of-4 = soft pass (revisit Phase D scope but proceed). 4-of-4 = hard
pass (build Phase D). ≤ 2 = fail (back to substrate iteration).

---

## What we don't ask for

- Your code. Wire `Dispatch` around your existing API; we never see the
  source.
- Your customer data. Use synthetic scenarios or anonymized real ones —
  whichever you prefer.
- Your model keys. You bring your own; if you want, route through Tangle
  Router and we never see the prompts either.
- Exclusivity, commitment, or contract. Walk away whenever.

The point is to learn if the substrate works for someone we didn't
build it for. That's it.
