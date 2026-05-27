# Driver Honest Spec — what each driver IS, what each methodology actually is, where we deviate

**Status:** Living document. Updated when we learn the truth from primary sources.
**Date:** 2026-05-27

This document exists because the project shipped two drivers with methodology names attached (`gepaDriver`, `skillOptDriver`) without the methodology specs being precisely encoded anywhere in the repo. That created an integrity gap. This doc closes it.

Every claim in this doc is sourced from a primary reference (paper, code, or directly verifiable from our source). Marketing language is forbidden. If something is not implemented we say so.

---

## Part 1 — GEPA (the paper)

**Source**: Agrawal et al., *"GEPA: Reflective Prompt Evolution Can Outperform Reinforcement Learning"*, arXiv:2507.19457, July 2025.

### What GEPA actually does

Outer loop (verbatim from abstract): "samples trajectories (e.g., reasoning, tool calls, and tool outputs) and reflects on them in natural language to diagnose problems, propose and test prompt updates, and combine complementary lessons from the **Pareto frontier of its own attempts**."

Named primitives in the paper:
- **GEPA** (Genetic-Pareto) — the overall optimizer
- **Pareto frontier** — non-dominated candidate set retained across iterations
- **Prompt updates** — mutations proposed by reflection
- **Rollouts** — trajectory samples

### What gepaDriver in our substrate ACTUALLY does

Source: `src/campaign/drivers/gepa.ts` (132 lines)

- Single LLM call per `propose()` invocation
- Input: prior generation's **single best candidate by composite score** + that candidate's top/bottom scenarios + 3 weakest dimensions (`buildEvidence`)
- Output: N proposals, each a full document rewrite
- Dedup by exact text equality

### Deviations from the GEPA paper

| GEPA paper | Our `gepaDriver` |
|---|---|
| **Pareto frontier** of candidates | **Single "best by composite"** — no Pareto set, no non-dominated tracking |
| **Combine complementary lessons** from frontier | Each generation reflects on ONE prior candidate; no combination |
| Multi-objective optimization | Single-objective (composite score) |
| Genetic operators (mutation, crossover) | Reflection only — no crossover |
| Sample efficiency claim (35× fewer rollouts than GRPO) | Unmeasured against any baseline |

**Honest assessment**: our `gepaDriver` is a **reflective full-rewrite driver**, not GEPA. It captures GEPA's *reflection* primitive but not its *Pareto* mechanism. The name oversells. A faithful renaming would be `reflectiveRewriteDriver`. A faithful implementation would add a Pareto candidate pool + combine step.

---

## Part 2 — SkillOpt (the paper + code)

**Source**:
- README: https://github.com/microsoft/SkillOpt
- Source: `/tmp/SkillOpt/skillopt/` (cloned 2026-05-27)
- Key files: `engine/trainer.py`, `optimizer/clip.py` (rank_and_select), `optimizer/update_modes.py`, `evaluation/gate.py`, `types.py`

### What SkillOpt actually does

**6-stage per-step pipeline** (verbatim from `trainer.py:516` and adjacent):

1. **Rollout** — `adapter.rollout(train_env, current_skill, ...)` collects trajectories on a batch.
2. **Reflect** — `adapter.reflect()` analyses trajectories and emits **structured patches** (NOT full rewrites in patch mode). Failure trials → failure patches; success trials → success patches.
3. **Aggregate** — `merge_patches(current_skill, all_failure_patches, all_success_patches, batch_size=merge_bs)` — hierarchically merges patches across accumulated batches.
4. **Select** — `rank_and_select(current_skill, merged_patch, max_edits=edit_budget)` — if edit pool > budget, calls an optimizer LLM to **rank edits by importance** and keep top-L. Budget is "analogous to gradient clipping" (their words).
5. **Update** — apply patch in one of 3 modes:
   - **`patch`** — deterministic diff apply via `apply_patch_with_report()`; ops are `append | insert_after | replace | delete`
   - **`rewrite_from_suggestions`** — LLM regenerates full skill from suggestions
   - **`full_rewrite_minibatch`** — reflection directly emits complete candidate skills; select picks the best
6. **Evaluate & Gate** — runs candidate on selection set, calls `evaluate_gate(cand_hard, current_score, best_score)`. Returns `accept_new_best | accept | reject` from a **literal `cand_hard > current_score`** comparison (`evaluation/gate.py:38`). No statistical test.

Plus epoch-level stages:
- **Slow update** — `run_slow_update()` builds longitudinal pairs across epochs.
- **Meta skill** — `run_meta_skill()` produces optimizer-side memory of patterns across adjacent epochs.

### Canonical patch shape (from `types.py:22-45`)

```python
EditOp = Literal["append", "insert_after", "replace", "delete"]

@dataclass
class Edit:
    op: EditOp
    content: str
    target: str  # for replace/delete/insert_after
    support_count: int | None  # how many trials voted for this edit
    source_type: Literal["failure", "success"] | None
    merge_level: int | None

@dataclass
class Patch:
    edits: list[Edit]
    reasoning: str
    ranking_details: dict | None
```

### What `skillOptDriver` v0.51.0 in our substrate ACTUALLY does

Source: `src/campaign/drivers/skillopt.ts` (current as of 0.51.0)

- Single LLM call per `propose()` returning N full document rewrites
- Post-parse rejection on: (a) any H2 header dropped, (b) sentence-edit count > editBudget × 2
- Substantively equivalent to `gepaDriver` + 2 validation constraints

### Deviations from SkillOpt

| SkillOpt actual | Our 0.51.0 `skillOptDriver` |
|---|---|
| 6-stage pipeline (rollout → reflect → aggregate → select → update → gate) | Single LLM call → N rewrites |
| **Patch-based edits** (`{op, target, content, support_count, source_type}`) | Full document rewrites only |
| `merge_patches()` hierarchical merge across batches | No aggregation; each `propose()` is independent |
| `rank_and_select(max_edits=edit_budget)` LLM-ranking of edits | All candidates that pass validation are returned |
| 3 update modes (`patch`, `rewrite_from_suggestions`, `full_rewrite_minibatch`) | Only `full_rewrite_minibatch`-equivalent |
| `evaluate_gate()` with `accept_new_best/accept/reject` codes | Substrate's outer gate decides ship/hold/inspect; driver doesn't see fine-grained accept signal |
| Longitudinal `slow_update` across epochs | Not implemented |
| `meta_skill` optimizer-side memory | Not implemented |
| Selection-set cache (`sel_cache`) for repeated candidate hashes | Not implemented |
| Edit-budget LR scheduler (constant / linear / cosine / autonomous) | Single fixed `editBudget` |
| Mini-batch accumulation (`steps_per_epoch`, `merge_batch_size`) | Not implemented |
| `decide_autonomous_learning_rate()` | Not implemented |
| `longitudinal_pair_policy` (mixed / changed / unchanged) | Not implemented |

**Honest assessment**: 13 substantive deviations. `skillOptDriver` 0.51.0 is **not** SkillOpt. It is `gepaDriver` with two post-validation constraints (section preservation, sentence-edit count). The methodology name oversells the implementation.

### One thing where we are STRICTER than SkillOpt

**The gate.** SkillOpt: literal `cand_hard > current_score` (`evaluation/gate.py:38`). Our substrate: paired bootstrap + 95% CI + Cohen's d + MDE + p-value (`defaultProductionGate`). When the lift CI straddles zero, our gate returns `hold` / `inspect`. SkillOpt would accept any improvement at all, even single-sample noise.

This is real differentiation we have not been crediting ourselves for.

---

## Part 3 — Hermes Agent's "self-improvement"

**Source**: `/tmp/hermes-agent/` (cloned 2026-05-27)
- `agent/curator.py` (the actual loop)
- `agent/skill_commands.py`
- `agent/skill_utils.py`

### What Hermes actually does

From `curator.py` line 1: "Curator — background skill maintenance orchestrator. The curator is an auxiliary-model task that periodically reviews agent-created skills and maintains the collection."

Trigger: idle-driven, with default `DEFAULT_INTERVAL_HOURS = 24 * 7` (7 days). When the agent has been idle for `DEFAULT_MIN_IDLE_HOURS = 2` and the last curator run was > 7 days ago, `maybe_run_curator()` spawns a forked AIAgent.

What the curator does:
- "Auto-transition lifecycle states based on derived skill activity timestamps"
- "Spawn a background review agent that can **pin / archive / consolidate / patch** agent-created skills via `skill_manage`"
- "Persist curator state (last_run_at, paused, etc.) in `.curator_state`"

Strict invariants:
- Only touches agent-created skills
- "Never auto-deletes — only archives"
- Pinned skills bypass auto-transitions
- Uses the auxiliary client (separate from main session)

### Hermes' actual gate

**There is none.** The curator is an LLM editor making editorial decisions. There is no:
- Held-out validation
- Performance comparison between old and new skill versions
- Statistical test
- Rejection-on-regression mechanism

Skills are refined by an LLM looking at usage patterns; the refinement is accepted because the LLM proposed it.

### Honest assessment

Hermes has a **skill curation system**, not a self-improvement loop. The README's claim "the only agent with a built-in learning loop" is generous — it's a 7-day-cron LLM librarian. There's no measurable guarantee that today's curated skill collection performs better than yesterday's.

Compare:
| Component | Hermes | SkillOpt | Tangle |
|---|---|---|---|
| Validation gate | None | `>` | Paired bootstrap CI |
| Patch-level edits | No (LLM rewrites whole skill) | Yes | No (full rewrite only) |
| Skill ranking / selection | No | Yes | No |
| Sample efficiency claim | None | 35× vs GRPO | None |
| Frequency | 7-day cron | Per training step | Per `selfImprove()` call |

Where Tangle WINS: the gate. Where SkillOpt WINS: the pipeline sophistication. Where Hermes WINS: the deployment story (multi-platform, multi-tool-backend).

---

## Part 4 — What we should actually do

### Phase A — rename to honest names (0.51.1, this session)

The current `skillOptDriver` and `gepaDriver` names overclaim. Options:

1. **Rename both:**
   - `gepaDriver` → `reflectiveRewriteDriver` (drops the "Pareto" implication)
   - `skillOptDriver` → `constrainedReflectiveDriver` (drops the SkillOpt-methodology implication)
   - Reserve `gepaDriver` + `skillOptDriver` for faithful implementations
2. **Keep `gepaDriver` name** (it's our most-used driver; renaming is disruptive); rename `skillOptDriver`.
3. **Keep both names; add `@experimental` + a "differs from paper" docstring section.** Cheapest. Truthful enough.

Recommendation: **option 3 plus a frontmatter "deviations from paper" section** in each driver source file. Empirically test before renaming.

### Phase B — build the honest empirical harness (0.51.1, this session)

`tests/driver-empirical.bench.ts` — for each driver:
- Same scenarios (5 synthetic + 5 real legal-agent scenarios)
- Same judge
- Same `baselineSurface`
- Same `budget` (1 gen, 3 candidates, holdout 0.3)
- Report: lift mean, lift CI95, p-value, rollouts spent, $$ spent

Drivers in the matrix:
- `gepaDriver` (current full-rewrite reflection)
- `skillOptDriver` (current 0.51.0 full-rewrite + constraints)
- Future: real `skillOptDriverV2` with patch mode

This is the **falsifiable test** of whether our drivers' methodology claims are worth the names.

### Phase C — implement SkillOpt patch mode for real (0.52.0)

Build `skillOptDriverV2` with:
1. **`Edit` type matching SkillOpt's**: `{op: 'append'|'insert_after'|'replace'|'delete', content, target?, support_count?, source_type?}`
2. **Reflect step emits patches**, not full rewrites
3. **`mergePatches()`** — LLM-driven hierarchical merge of failure + success patches
4. **`rankAndSelect()`** — LLM-driven ranking when edit pool > budget
5. **Deterministic `applyPatch()`** — string ops, no LLM
6. **Keep our gate** (paired bootstrap CI). Don't downgrade to SkillOpt's `>` — that's our edge.

Estimated scope: 400-600 lines + tests.

### Phase D — implement GEPA's Pareto frontier (0.53.0)

Build `gepaDriverV2` with:
1. **Candidate pool** retained across generations (non-dominated)
2. **Multi-objective evaluation** (composite + cost + length + diversity)
3. **Combine step** — LLM combines lessons from non-dominated candidates
4. Keep reflection.
5. Sample-efficiency target: match the paper's ~35× claim on a benchmark we choose.

Estimated scope: 500-800 lines + tests.

---

## Source pointers (audit trail)

- GEPA paper: https://arxiv.org/abs/2507.19457
- SkillOpt repo: https://github.com/microsoft/SkillOpt (cloned at `/tmp/SkillOpt/` 2026-05-27)
- Hermes repo: https://github.com/NousResearch/hermes-agent (cloned at `/tmp/hermes-agent/` 2026-05-27)
- Our gepaDriver: `src/campaign/drivers/gepa.ts`
- Our skillOptDriver: `src/campaign/drivers/skillopt.ts`
- Our gate: `src/campaign/gates/default-production-gate.ts`
- Our reflection primitive: `src/reflective-mutation.ts`

Update this doc when:
- We discover new behavior in any of the upstream methods (via reading their code, not their READMEs)
- We ship a driver that closes one of the named gaps
- We run the empirical harness and have real numbers to add
