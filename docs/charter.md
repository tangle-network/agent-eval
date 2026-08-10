# Charter: what agent-eval is for

This document states what this package is, derived from the four end-states the stack must reach.
It was written on 2026-08-10 from a measured inventory of this repo, agent-runtime, discovery, discovery-lab, braid, traces, and supervisor-lab.
Every claim about current code cites the module that carries it.
When behavior moves, move this document in the same change.

## One sentence

agent-eval is the honesty layer of the agent stack: instruments that make it structurally hard to fool ourselves at machine speed, and that never choose a research method.

The anchor is discovery's covenant (discovery `docs/01-vision.md`): shared code enforces evidence integrity and immutable observations; it never chooses roles, methods, or winners.
Everything above this package — runtime, discovery, braid, verticals — gets its freedom because honesty is enforced below.

## The four end-states, and what each demands from this package

1. **Build complex software rapidly, end to end, without issues.**
   The gate is not generation.
   The gate is knowing what is true about the work while it runs.
   Measured on our own corpus: 87% of failed long runs end on a clean exit with the agent claiming success.
   Demand: executable verification wired into the runtime loop, not beside it.

2. **Do novel research: physics, quantum computing, math, unsolved problems.**
   An unsolved problem has no held-out test suite by definition.
   Every grader this package shipped before 2026-08 assumes an answer key.
   Demand: verification strategies that certify without one — proof kernels, invariant checks, independent derivation agreement, replication — plus the statistics of a careful experimentalist.
   This demand is measured, not speculative: discovery-lab holds 99 pursuit directories and 71 blind-graded oracle files on frontier problems, all verified today by hand-rolled run tools outside this package.

3. **Build self-improving agents easily, and explain them easily.**
   Improvement requires an ungameable signal; the grader, not the edit, decides improve-versus-game.
   Explanation requires a portable artifact: the receipt that proves B beat A, verifiable by a third party who does not trust us.

4. **Build new interfaces (braid-class): detached sessions, forking, analysts on tap.**
   An interface can only expose what the layer below makes addressable.
   Demand: sessions, traces, experiments, and verdicts as durable, forkable, queryable objects.

## What already exists (the 2026-08-10 inventory, corrected)

The fragmentation story is smaller than it feels.
The audit refuted "built four times": traces imports this package's whole analyst suite; agent-runtime's live detectors import the detection kernel verbatim; supervisor-lab's judges are AgentProfiles dispatched through this package's judge primitives.

- **Ask any question over any trace: exists.**
  `TraceAnalysisEngine` (`src/analyst/engine.ts`) takes a free-text question.
  A new custom question costs zero library files: `defineTraceAnalyst` + `runTraceAnalyst` on the `./analyst` subpath, with the DSPy RLM engine, seven byte-budgeted trace tools, and a metered model proxy behind it.
- **Default failure analysts: exist.**
  `buildDefaultAnalystRegistry` ships failure-mode, intent-divergence, knowledge-gap, knowledge-poisoning, improvement, control-integrity, and skill-usage kinds, engine-agnostic and versionable.
- **Statistics: most of an A-plus toolkit, publicly exported.**
  Paired bootstrap, clustered paired binary, exact and score risk differences, McNemar with power and required-n, MDE, multiplicity (Holm, Benjamini-Hochberg), e-process sequential gates, corpus inter-rater agreement, pre-registration manifests with content hashes.
- **Executable process verification: proven this week.**
  The trace-repair grader scores a proposed fix by executing it and running the task's own held-out suite from outside the container.
  Oracle-fix separates from inert-probe (+0.353 vs 0.000 on milestone 1) with the floor pinned at zero.
- **Integrity instruments hardened by this week's burns:**
  served-model assertions (a gateway can answer one id with another model), oracle determinism certification (a wall-clock grader flipped 8 of 16 units on identical bytes), control-policy declaration (a zero-step control screened two milestones and could never fire), and equal-terms refusal between comparison arms (`repairArmAsymmetries`).

## What is missing (the honest, short list)

1. **Cluster-aware power with design-time refusal.**
   "Four task clusters cannot certify any effect size, including 1.0" was learned by running the experiment.
   A `clusteredPower` simulator must refuse the design before a dollar is spent.
2. **Pre-registration as code, bound everywhere.**
   The manifest binds exactly one statistic family today.
   The registered decision rule must be the object the runner executes; drift between registered and ran must be unrepresentable.
3. **A general prime query surface.**
   The prime engine is benchmark-bound; there is no `runPrimeAnalyst` symmetric to `runTraceAnalyst`.
4. **The funnel as a first-class object.**
   Denominator chains are assembled by hand every run.
5. **The unified analyst definition.**
   One declarative unit — AgentProfile + evidence projection + reply contract + budget declaration — compiled to any engine, guarded by a byte-identity kill test against the bespoke arms.
6. **Verification without an answer key.**
   A strategy family where the held-out suite is one member: proof kernels, invariant and metamorphic checks, independent derivation agreement, replication.
   The reward-source union is closed today; nothing grades the formalization gap.
7. **Session forking as one primitive.**
   Both halves exist unjoined: agent-runtime's `SandboxLineage.fork` (live checkpoint) and this package's trajectory replay (recorded prefix).
   Braid branches are metadata pointers; the provider session is always new.
8. **The improvement receipt.**
   Digests, attestations, and sealed manifests exist; the single portable, third-party-verifiable file does not.
   Five gaming attacks on the receipt are named; each refusal must live inside the receipt.

## Build order

Wave 1 — in flight now.
The analyst definition contract with its byte-identity CI kill test; prime as a HarnessType in agent-interface; the three-arm review fixes.

Wave 2 — the experiment subpath.
`./experiment`: compose the exported statistics into `defineExperiment` / `sealExperiment` with cluster-aware power refusal, pre-registration as executable decision rules, the funnel object, and matched-budget verification.
Kill test first: re-derive this week's three hand-written PREREG.md files as decision-rule objects; any rule that needs an opaque escape hatch kills or extends the design.

Wave 3 — runtime wiring (blocked until agent-runtime's supervision merge resolves).
The executable checker bound as a validator at the live-sandbox seam; a stop policy that consumes executable verdicts; then the supervisor budget-allocation experiment at equal compute.
The published negative result to beat: StateSeal, −3.0pp, CI [−8.5, 1.1], n=540.
Our measured headroom: blind continuation rescues 4.7% of rollouts; the done-signal has 62.5% precision.

Wave 4 — the joins.
`fork(session, step, modification)` joining lineage-fork and trajectory replay, consumed by braid; the improvement receipt v1 serializing evidence vector, pre-registration hash, grader calibration, and refusal outcomes into one attested file.

Wave 5 — science.
The verification-strategy family, proof kernels first.
Its pilot is live: two independent Lean formalizations of the BCWW (4.6) inequality — one from the paper, one from the campaign's artifacts — with a kernel-checked equivalence verdict and the campaign's counterexample checked against both.
A statement mismatch is a successful outcome; it is the formalization gap made visible.

## Standing principles (each earned by a measured burn)

- **Instruments, never methods.** This package refuses to choose roles, prompts, models, or winners; it makes whatever runs honest.
- **No upward dependencies.** Consumers import this package; never the reverse.
- **A check that cannot run must never render as green.** (505 of 5,459 automated reviews published verdicts no evidence supported.)
- **Certification is task-scoped.** A prompt certified on one task carries nothing onto another; re-authoring voids it.
- **Access to the world beats loop sophistication.** Measured twice in one week: the analyst that could execute beat the one that could only read; framing carried more than the agent loop.
- **Controls must be able to fire.** A screening control that cannot in principle produce the outcome it screens for is uncalibrated, not conservative.
- **The refusal lives inside the artifact.** An adequacy check, an equal-terms check, a determinism check that runs beside the result can be skipped; one that the artifact carries cannot.
