# Research Roadmap — Agent Self-Improvement as a Research Field

**Status:** Living. Separate from the product roadmap. Updated when a thesis formalizes, an experiment runs, or a draft posts.
**Tracking:** task #107.
**Audience:** Dario, Yann, Ilya, Sam, lab researchers, peer reviewers.
**Posture:** Honest about what we have, sharp about what we'd need.

## One-sentence pitch

**Agent self-improvement is missing its statistical foundation, its formal model of two-writer state, and its standard benchmark. We claim all three.**

## The three publishable theses

### Thesis 1 — Branch-benchmark consensus for safe offline+online self-improvement

**Setup.** Two writers concurrently mutate an agent's behavior surface: an in-sandbox harness (per-turn, online) and an offline substrate (batch, statistically-gated). Both produce divergent versions from a common ancestor. Existing literature handles online RL (single writer = policy) and offline RL (no in-runtime writes) — nobody has formalized the *combined* regime where both writers coexist.

**Claim to prove.** Given common ancestor `P_anc`, harness branch `P_h`, substrate branch `P_s`, scenarios `S`, and judge `J`, a branch-benchmark consensus procedure produces a winner `P_w` with regret bounded by `max(R(P_h), R(P_s)) − ε` with probability `≥ 1−δ` under explicit assumptions about judge calibration + scenario coverage.

**Why it's publishable.**
- Genuinely novel regime — the combined offline+online assumption set is uncharted.
- Maps to a real customer pain point (Hermes-on-our-sandbox drift).
- Tractable proof structure: paired-bootstrap + Hoeffding + union bound across surface dimensions.
- Empirical validation: instrument Hermes-on-our-sandbox, measure consensus-vs-naïve-merge regret.

**Estimated effort.** ~3 months focused. Uses canonical `@tangle-network/agent-interface`
profiles plus eval-side `AgentProfileCell` snapshots; do not add another
profile contract in agent-eval.

**Venue.** NeurIPS or ICLR main track. Or workshop at NeurIPS Foundation Models for Decision Making.

---

### Thesis 2 — Natural-language corrective feedback as a learnable gradient

**Setup.** RL provides scalar reward `r ∈ ℝ`. Natural-language feedback ("stop doing X", "you always Y", "this is too verbose") carries strictly more information per bit but no formal model says how to combine it with scalar reward to update policy or skill state. Hermes uses corrective feedback heuristically; GEPA paper claims language is a richer learning medium but doesn't formalize this specific signal. The gap is wide open.

**Claim to prove.**
1. Information-theoretic: corrective utterances carry `H(c) > H(r)` bits of policy-relevant information under realistic distributions of user satisfaction.
2. Algorithmic: an extraction+integration procedure exists that improves sample efficiency over scalar-only RL by `k×` (target k ≥ 5) on the proposed benchmark.
3. Empirical: validation on multi-turn agent tasks with explicit user-corrective channels.

**Why it's publishable.**
- Connects to GEPA paper's central claim, makes it falsifiable for the corrective sub-class.
- Maps to product task #103 (`extractUserCorrections`).
- Distinctive — no observability or RL competitor formalizes corrective feedback as a gradient.

**Estimated effort.** ~4 months. Information-theoretic framing is delicate.

**Venue.** ICLR or main-track NeurIPS. Possibly EMNLP for the NLP angle.

---

### Thesis 3 — Sample-efficient self-improvement under a paired-bootstrap gate

**Setup.** GEPA paper claims ~35× fewer rollouts than GRPO. They use a binary improvement check. Our substrate uses paired-bootstrap CI + Cohen's d + MDE (strictly stricter gate). The trade-off between gate-strictness and rollout efficiency is unmodeled.

**Claim to prove.** Given a paired-bootstrap gate with significance level α and minimum detectable effect δ, `selfImprove` requires `O((σ/δ)² · log(1/α))` rollouts to detect a true ε-improvement with power `1-β`. Tight constants. Compare empirically to GRPO and to GEPA's simple-improvement gate on identical benchmarks.

**Why it's publishable.**
- Closes a gap GEPA left open (their efficiency claim has no power analysis).
- Maps to product task #101 (real GEPA Pareto + sample-size theory).
- Provides a tool — power calculator for the field's self-improvement runs.

**Estimated effort.** ~2 months — the cleanest of the three. Mostly classical sample-size theory + careful experiments.

**Venue.** ICML or AISTATS. The statistical framing fits both.

## The fourth thesis (long-horizon, highest prestige)

### Thesis 4 — A standardized benchmark for self-improvement

**Setup.** No standard benchmark exists for "did self-improvement help, robustly, across distribution shift?" GAIA + SWE-Bench + AgentBench measure agent capability; nothing measures self-improvement quality. The field is publishing self-improvement results on disparate ad-hoc setups; nobody compares.

**Claim to ship.** A benchmark with:
- 100+ scenarios spanning distinct distribution shifts (intra-domain, cross-domain, adversarial corruption)
- Held-out test split with strict contamination guards
- Reference baselines (no-driver / random / scalar-only-RL / GEPA / our substrate)
- Standard scorecard: lift CI, sample efficiency, distribution-shift robustness, cost
- Public leaderboard

**Why it matters.** Whoever owns the benchmark owns the measuring stick. ImageNet for vision, GLUE for NLP, GAIA for agent capability — the gap for *self-improvement quality* is open.

**Estimated effort.** 6 months. Real scenario authoring, contamination engineering, community outreach for leaderboard adoption.

**Venue.** Datasets + Benchmarks track at NeurIPS. Or workshop debut → main-track followup.

## 12 open research questions, ranked by signal-to-noise

Each is a falsifiable claim or unanswered formal question. Each maps to publishable work.

1. **Information content of corrective feedback.** What's the empirical mutual information `I(correction; preferred_policy)` across realistic agent deployments? Is it consistently `> H(scalar_reward)`?

2. **Convergence of branch-benchmark consensus.** Under what assumptions on judge calibration does the symmetric-fork merge protocol converge to a global optimum vs a local one?

3. **The cost of statistical strictness.** How much does a paired-bootstrap gate cost in rollouts vs a literal `>` gate (SkillOpt's choice), as a function of true effect size? Where's the crossover where strictness costs more than it saves?

4. **Cross-surface attribution.** When `compositeProposer` ships a winner where N surfaces changed, which surface's change drove the lift? Shapley estimators on agent-profile surfaces — tractable? Required sample size?

5. **Sample-efficient evaluation under distribution shift.** Given a held-out test slice and a known shift class (intra-domain / cross-domain / adversarial), how few held-out scenarios are needed to detect lift with target power? Is it a function of shift magnitude?

6. **Diminishing returns of recursive self-improvement.** A substrate that optimizes its own SKILL.md against held-out tasks — does it converge or drift? At what point do recursive self-edits become net-negative on a true holdout? Map the loss landscape.

7. **Skill semantic-duplicate detection.** Substrate's `summarize-pr` vs harness's `pr-summarizer`. What's the right embedding + threshold? Is human review for borderline cases unavoidable or can it be automated?

8. **Reward-hacking under self-improvement.** When the optimizer can mutate the judge prompt (the recursive surface), what's the formal condition under which it learns to game the judge instead of solving the task? Connect to Goodhart + AIRP.

9. **Cost-quality Pareto across proposers.** What's the empirical Pareto frontier when you trade off `gepaProposer` (high $/gen) vs `evolutionaryProposer` ($0/gen) vs heuristic mutations? Is it task-dependent or universal?

10. **Online-offline merge regret.** When harness branch and substrate branch are merged, what's the regret of the merged policy vs the better-of-two? Bounded? Worst-case adversarial?

11. **Universal trace ingest tax.** Cross-framework adapter coverage (LangChain / LlamaIndex / Anthropic / OpenAI) — how much signal loss is forced by the lowest-common-denominator RunRecord shape? Quantify in terms of recoverable lift CI.

12. **Foundation-model-as-judge calibration drift.** When the judge LLM updates (Claude → Claude+1), what's the variance in judge scores on a fixed corpus? Is held-out gate validity preserved across judge versions? Empirical study, longitudinal.

## The processes (how we actually do this)

**Cadence.**
- Daily: product work continues (Track A). Research is a separate 30%-time block.
- Weekly: research log + open-questions revision. One paper-quality paragraph per week.
- Monthly: experiment milestone — either proof attempt or empirical-run results.
- Quarterly: paper-draft milestone.

**Artifacts.**
- `docs/research/<thesis>/notes.md` — running research log, hypothesis, current status.
- `docs/research/<thesis>/experiments.md` — every run + numbers + analysis.
- `docs/research/<thesis>/paper-draft.md` — building toward arXiv submission.
- `docs/research/belief-state-agent-eval-roadmap.md` — belief-state / adaptive-control research tracker and 24-month gate plan.
- `.evolve/research/<thesis>/` — code + data + figures, version-controlled.

**Quality bar.**
- Every claim falsifiable. Every number has CI, p, and sample size.
- Every experiment reproducible — script + seed + commit hash + data hash.
- Every figure has an underlying CSV the reviewer can download.
- Every theorem has a proof in the doc, not just a citation.

**Review cadence.**
- Internal critique pass before any external sharing — find every weak spot.
- External review at 80%-draft: one peer in the field, one peer outside.
- ArXiv submission as the gating event for public claim.

## What we explicitly will NOT do

- **Will not pretend product-grade engineering is research.** Architecture docs are not papers. Strategic framing is not contribution.
- **Will not chase trendy directions (RLHF variants, constitutional AI, scaling laws) where we have no edge.** Our edges are specific: two-writer state, corrective feedback as gradient, statistical strictness. Stay in lane.
- **Will not publish empirical results without proper baselines.** "Our substrate produces N% lift on dataset X" is meaningless without no-driver/random/GEPA/SkillOpt baselines on identical infrastructure.
- **Will not optimize for citation count over insight.** One paper that changes how the field thinks > five papers that move a benchmark by 2 points.

## Where we are right now

**Track A (product) status as of 2026-05-27:**
- agent-eval shipped 0.47 → 0.53 in one session
- Six consumers on substrate 0.50+
- Honest spec docs landed
- Product roadmap 0.53 → 1.1 mapped

**Track B (research) status as of 2026-05-27:**
- This doc exists
- Zero experiments run on published benchmarks
- Zero papers drafted
- Three theses identified, none formalized
- Twelve open questions enumerated, none answered

We are at Track-B day 0. Honesty matters.

## Deliverables — 12-month plan

**Q3 2026 — proof of life.**
- Run our drivers against AgentBench / SWE-Bench Verified / GAIA. Report numbers with CI.
- Pick one named partner customer who'd validate Thesis 1 with us on their real deployment.

**Q4 2026 — Thesis 3 paper draft.**
- Sample-efficient self-improvement is the cleanest claim — fastest to publish, sharpens our gate's edge.
- Target: arXiv pre-print + AISTATS submission.

**Q1 2027 — Thesis 1 paper draft.**
- Branch-benchmark consensus — the deepest claim, the one that needs forcing-function data from a Hermes-on-sandbox deployment.
- Target: NeurIPS / ICLR submission.

**Q2 2027 — Thesis 4 benchmark public release.**
- The benchmark + leaderboard is the highest-prestige play.
- Target: Datasets + Benchmarks track at NeurIPS 2027.

**Q3 2027 — Thesis 2 paper draft.**
- Corrective feedback as gradient — slowest to ripen, hardest to formalize.
- Target: ICLR submission.

## How a lab lead would react to this doc

If you printed this and slid it across Dario's desk:

**The good.** Specific named theses with falsifiable claims. Honest about gap from product to research. Three publishable directions in clear scope. Twelve open questions readable as a research-program statement.

**The hostile-reviewer attack.** "Show me one number on one published benchmark from your existing infrastructure. You have a substrate with a paired-bootstrap gate that's never been compared to anything." That is correct. Q3 2026 deliverable is the answer.

**The deepest question they'd ask.** "Why does this matter for AGI / safety / capability? Why work on this instead of pretraining / alignment / interpretability?" Honest answer: agents that self-improve in production are a near-term reality. The work to make that *safe* and *measurable* is path-dependent on whether the field formalizes it or accepts ad-hoc product implementations. Our pitch is "be the lab that formalized it before it became a 1000-org engineering mess." That's a defensible answer if backed by the published work.

## The one-sentence inspirational version per audience

- **For Dario:** "We're building the statistical foundation that turns 'agents that self-improve' from a marketing slogan into a measurable claim with calibrated error bars."
- **For Yann:** "Self-improvement is offline-RL with two writers — and nobody has formalized the consensus regime. We will."
- **For Ilya:** "What's the simplest formalism under which self-improving agents converge to a global optimum vs a local one? Branch-benchmark consensus is our hypothesis."
- **For Sam:** "We are going to ship the substrate that lets every customer's agent self-improve safely, then publish the science that proves it works. The product builds the data; the data writes the papers; the papers create the moat."

## The harshest honest sentence

If we don't run a published benchmark by Q3 2026, this entire doc is fan-fiction. Build the empirical infrastructure first, formalize after, publish last.
