# Pre-onboarding checklist — what to have ready

Send this to the customer 48h before the onboarding call. If they show up to the call having done this, the 90-minute slot ends with a working pilot.

## What we need from you before the call

### Credentials

- [ ] **LLM provider API key** — tcloud key, OpenRouter key, OpenAI key, Anthropic key, or any OpenAI-compat router endpoint
- [ ] **GitHub token** with PR-write access to your agent repo (optional — required only if you want auto-PR promotion on green gate decisions)
- [ ] **Sandbox session access** (Tangle stack customers only) — read access to the session IDs we'll analyze

### Data

- [ ] **Trace data** — ONE of:
  - Tangle sandbox session IDs (we use `fromTangleSandbox`)
  - OTel spans dumped as JSONL (we use `fromOtelSpans`)
  - Multi-rater feedback table (CSV with runId / rater / score, we use `fromFeedbackTable`)
  - LangChain / LlamaIndex / OpenAI Assistants trace export (we use the corresponding adapter)
  - Custom trace format (we map it together on the call — usually 20 lines of glue)
- [ ] **Scenarios** — 20-50 representative inputs your agent handles. Even YAML / JSON / TS array is fine; we'll convert to canonical `DatasetScenario[]` shape together
- [ ] **The system prompt addendum** your agent uses today (or whichever text surface you want to optimize) — the closed loop edits this

### Judge

- [ ] **A judge function or rubric** — either:
  - An existing function `(artifact) → { composite, dimensions }`
  - A rubric describing what "good output" means (1-2 paragraphs is enough — we'll build the judge on the call)
  - A set of "good" / "bad" labeled examples (we use these as anchors)

### Constraints

- [ ] **LLM cost budget for the closed loop** — default $25 per campaign. Tell us if you want a different ceiling
- [ ] **Cadence** — how often should the loop run? Default: weekly. Some customers want daily; others want on-demand only
- [ ] **Deployment gate preference** — do you want:
  - Auto-PR on `ship-substrate` (we open the PR, your team reviews)
  - Manual review only (we report; you decide)
  - Auto-deploy on `ship-substrate` (only with explicit ack; not default)

## Call agenda — 90 minutes

| Time | Topic |
|---|---|
| 0:00 — 0:10 | Walk through your existing setup — what runs where, what scenarios exist, what success looks like for you |
| 0:10 — 0:30 | Pick the right intake adapter; pull traces; run `analyzeRuns()` against last week's data — first decision packet rendered live |
| 0:30 — 0:50 | Build the judge — either wrap your existing one or scaffold a new one from your rubric |
| 0:50 — 1:10 | Fire one `selfImprove` cycle with a small budget ($5, single generation, 2 candidates) — watch the loop run end-to-end |
| 1:10 — 1:25 | Wire the cron + auto-PR target; schedule first weekly run |
| 1:25 — 1:30 | Confirm what we hand back to you between runs and what reaches you when |

If something on the checklist isn't ready, we adapt — just send what you have. Worst case, we spend the first 30 minutes getting unblocked.

## What you'll have at the end of the call

- A working `analyzeRuns()` call against YOUR live trace data, returning a real `InsightReport`
- A judge function (yours or scaffolded) wired to your agent's output shape
- One completed `selfImprove` cycle with a real `gateDecision` + lift CI
- A scheduled cron / GitHub Action that runs the loop weekly
- Optional: an auto-PR target if you want green-gate proposals to land as draft PRs

## After the call

- Day 1-7: first weekly run fires; we monitor + jump in if anything breaks
- Day 7: we send you a `selfImprove`-result summary + the corresponding `InsightReport`
- Day 14-28: 3 more cycles complete; you have enough data to evaluate the pilot
- Day 30: pilot review — what we found, what shipped, what's next

## What we send back to you between runs

- The full `InsightReport` JSON (you render it however you want, or use our hosted dashboard if it's available for your tier)
- Slack / email digest of `regressedMetrics` + critical recommendations (opt-in)
- Cost tally per campaign
- Auto-PR links if green gate verdicts opened any

## Common pre-call questions

**Q: How small a corpus can we start with?**
A: 15 scenarios works for the deterministic packet. 25+ is recommended for `selfImprove`'s held-out gate (the default `holdoutFraction: 0.3` reserves ~30% of scenarios for the gate).

**Q: What if our judge isn't reliable yet?**
A: Start with multi-rater intake — `fromFeedbackTable` produces inter-rater agreement (κ) so you can see exactly which scenarios humans disagree on. Iterate the judge until κ > 0.7, then go to closed loop.

**Q: We don't use Tangle's sandbox — can we still pilot?**
A: Yes. We have intake adapters for OTel, LangChain, LlamaIndex, Anthropic SDK, OpenAI Assistants, OpenRouter, multi-rater feedback tables, and custom trace formats. See `integration-foreign-stack.md`.

**Q: We use OpenRouter — does the closed-loop driver work with our routing setup?**
A: Yes. `gepaDriver` accepts any OpenAI-compatible endpoint via its `llm.baseUrl` option. Most customers run their selfImprove campaigns through OpenRouter or their existing provider — no migration required.

**Q: What if the pilot fails — what do we get?**
A: You get the deterministic `InsightReport` weekly regardless. Even if no `selfImprove` cycle ever ships a green gate verdict, you get the failure-cluster analysis, regressed-metric detection, and worst-runs surfacing. Those alone replace what most teams currently get from LangSmith / Braintrust / Phoenix scorecards.
