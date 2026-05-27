# Hermes self-improvement — corrected audit

**Status:** Active. This corrects an earlier underestimate where I claimed Hermes only had the 7-day curator. Drew pushed back; he was right.
**Source:** github.com/NousResearch/hermes-agent cloned 2026-05-27 at /tmp/hermes-agent.

## The corrected picture

Hermes has **two** self-improvement mechanisms, not one. Per their own source comments: "background self-improvement review fork" (`tools/skill_provenance.py:5`).

### Mechanism 1 — per-turn background review (the actual learning loop I missed)

**File:** `agent/background_review.py` (593 lines)

**Trigger.** `spawn_background_review_thread()` runs after every turn (`AIAgent.run_conversation`). Forks a daemon thread that:
1. Snapshots the conversation history
2. Boots a forked `AIAgent` inheriting the parent's runtime (model, provider, base_url, credentials, cached system prompt — exact same auth for prompt-cache reuse)
3. Feeds the fork one of three review prompts:
   - `_MEMORY_REVIEW_PROMPT` — should we save anything about the user?
   - `_SKILL_REVIEW_PROMPT` — should we update the skill library?
   - `_COMBINED_REVIEW_PROMPT` — both
4. The fork executes with a tool whitelist (memory + skill management only)
5. Writes go straight to `~/.hermes/skills/` and the memory store
6. Provenance tag: `_memory_write_origin = "background_review"`

**Critical signal source.** The skill-review prompt explicitly looks for **user-feedback signal during the conversation**:

> "User corrected your style, tone, format, legibility, or verbosity. **Frustration signals** like 'stop doing X', 'this is too verbose', 'don't format like this', 'why are you explaining', 'just give me the answer', 'you always do Y and I hate it', or an explicit 'remember this' are FIRST-CLASS skill signals, not just memory signals."

> "Be ACTIVE — most sessions produce at least one skill update, even if small. A pass that does nothing is a missed learning opportunity, not a neutral outcome."

This is **qualitative LLM-judges-LLM optimization driven by real user-corrective feedback**. The validation gate is the forked agent's own judgment.

**No held-out validation.** No A/B between skill versions. No regression rejection. No statistical test. The agent decides "save this" or "don't" and writes immediately.

### Mechanism 2 — 7-day curator (housekeeping, not learning)

**File:** `agent/curator.py`. As I described earlier — periodic LLM editorial pass over agent-created skills, pin/archive/consolidate/patch. **Only touches skills that the per-turn loop created.** Doesn't refine via measurement; refines via LLM editorial judgment.

### Storage

- `~/.hermes/skills/<name>/SKILL.md` + `references/` directory per skill (their own documented invariant)
- `~/.hermes/skills/.usage.json` — sidecar telemetry per skill (usage counts, lifecycle states `active → stale → archived → pinned`)
- Lifecycle states drive curator decisions but never the per-turn review

## Corrected competitive matrix

| Component | Hermes | SkillOpt | Tangle |
|---|---|---|---|
| Trigger | **Per-turn fork** + 7-day curator | Per training step | Per `selfImprove()` invocation |
| Signal source | **User corrective feedback during chat** + agent retrospection | Judge scores on held-out batches | Judge scores + held-out + multi-rater |
| Patch granularity | Tool-call level (skill_manage create/edit/patch) | Structured `Edit` ops with `support_count` | Full document rewrite (today) |
| Validation gate | **None** — forked agent's own judgment | Literal `cand_hard > current_score` | **Paired bootstrap + CI + Cohen's d + MDE** |
| Rejection-on-regression | No | Yes (gate returns `reject`) | Yes (gate returns `hold` / `inspect`) |
| Cross-batch aggregation | No | Yes (`merge_patches`) | No |
| Edit ranking under budget | No | Yes (`rank_and_select`) | No |
| Longitudinal memory | Usage telemetry only | Yes (`run_slow_update`, `run_meta_skill`) | No |
| Statistical rigor | None | None | **Highest** |
| User-feedback signal | **Yes — first-class** | No (offline only) | No (offline only) |

## What we beat them on — what they beat us on

**Tangle wins:** the gate. Paired bootstrap CI + Cohen's d + MDE is statistically stricter than both. We refuse to ship on noise; both Hermes and SkillOpt accept improvements that could be noise.

**Hermes wins:** the signal. They use real user-corrective feedback ("you always do Y and I hate it") as a first-class gradient. We use judge scores; they use both judge scores AND user-language feedback. Their loop fires **per turn**, ours fires **per offline campaign**.

**SkillOpt wins:** the pipeline. Structured patches, hierarchical merge, edit ranking under budget, multiple update modes, longitudinal slow-update, meta-skill memory. Our pipeline is full-rewrite-then-validate; theirs is patch-with-multi-trial-evidence.

## The real architectural insight from this audit

Hermes' per-turn loop is **online**. Our `selfImprove()` is **offline batch**. When Hermes runs on top of our sandbox, **the harness will mutate skills underneath us continuously**. By the time our offline eval finishes, the baseline we measured against may be 50 generations behind production.

That's the gap task **#98 — Profile-versioning architecture** exists to close.

## What we should actually do differently

1. **Stop dismissing Hermes' loop.** It's real, it uses signal we don't, and it's been deployed at scale. Their methodology paper would be: "user-corrective-feedback-driven self-improvement with LLM-judges-LLM acceptance and usage-telemetry-driven housekeeping." We should treat this as a real prior, not marketing.

2. **Add user-feedback signal as a substrate primitive.** Today our `RunRecord.outcome` carries judge scores and raw artifact data. It doesn't carry **in-conversation corrective signals** ("user said 'stop doing X' at turn 7"). If we want to fuse our statistical gate with Hermes' signal source, we need a `RunRecord.userFeedback?: UserCorrectionEvent[]` field.

3. **Recognize the offline/online divide is structural.** Hermes is online. Our substrate is offline. The bridge is the profile-versioning architecture (task #98) — let the harness do per-turn online updates, let the substrate do batch offline eval against versioned snapshots, then merge/rebase via a real diff protocol.

4. **Do the per-turn signal extraction NOW (cheap).** Even without versioning, we could parse traces for user-corrective markers (regex on user messages: "stop", "don't", "I hate", "always Y", "just give me", "this is too X") and emit them as a new `RunRecord` field. That captures Hermes' signal source as additive substrate evidence.

## Source pointers (audit trail)

- `agent/background_review.py:1-30` (header docstring naming the loop)
- `agent/background_review.py:_MEMORY_REVIEW_PROMPT`, `_SKILL_REVIEW_PROMPT`, `_COMBINED_REVIEW_PROMPT` (the actual prompts)
- `agent/background_review.py:_run_review_in_thread` (the fork worker)
- `agent/background_review.py:spawn_background_review_thread` (the entry)
- `tools/skill_provenance.py:1-15` (docstring: "background self-improvement review fork" — Hermes' own term for their loop)
- `tools/skill_usage.py:1-25` (telemetry + lifecycle)
- `agent/curator.py` (7-day housekeeping)
- `skills/autonomous-ai-agents/hermes-agent/SKILL.md` (45KB CLI/architecture reference)
