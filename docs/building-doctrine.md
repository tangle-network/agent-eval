# Building doctrine

How every fleet agent that consumes `agent-eval` is built. Each rule is mechanical: a primitive or test makes the rule enforceable rather than aspirational. For the mental model and primitives this references, see [`concepts.md`](./concepts.md) and the [`/contract`](../src/contract/index.ts) surface.

## 1. Defaults must be provably reachable

Every hard-coded model id or endpoint default is verifiable against the live router. Membership in `{baseUrl}/models` is the free check; an optional 1-token probe per model confirms the router will actually serve it. A default the router cannot serve is a config bug caught before the run, not a runtime surprise that silently degrades into a stub. Backend ids are namespaced by binding: cli-bridge ids (`claude-code/*`, `kimi-code/*`, `opencode/*`) never appear as defaults in code reachable from production — bridge use is an explicit env opt-in, never an implicit fallback.

Enforced by: `preflightModels` (membership + optional probe) and `assertModelsServed` (gate that names every unreachable id with status + detail).

## 2. Probe the platform before peeling client layers

When a request fails, one direct call against the live endpoint bisects platform-versus-client before any code-level debugging begins. A 401 from the router on a `model_not_found` is the platform telling you the default is dead; a connection refused is the platform being unreachable. Establish which side is at fault with a probe first, then debug only the side that is actually broken.

Enforced by: `preflightModels({ probe: true })` — the probe is the platform-side bisection, carrying the router's own `error.message` back to the caller.

## 3. Agent-produced findings are hypotheses

Enumeration of candidate problems may fan out to agents, but agent output is not evidence. Truth comes from probes against ground truth, not from an agent's assertion. Every classification carries quoted evidence, and nothing unverified is merged or reported as fact. A confident-sounding agent claim with no probe behind it is a hypothesis awaiting falsification.

Enforced by: `assertRealBackend` over the resulting `RunRecord[]` — an agent that claims success while the backend was never called reads as a stub, not a pass.

## 4. Experiment integrity checklist

Any lift or benchmark claim satisfies all of the following before it is reported:

- A frozen, disjoint held-out set, spent exactly once, after candidate selection.
- The propose and selection steps never see held-out data.
- The paired bootstrap confidence interval excludes zero for a "ship" or "match" verdict.
- The same scorer and the same items on both sides of any comparison.
- A leakage check from builder inputs into the evaluation set.
- Cross-family judge panels, with inter-rater reliability reported and gated.
- Missing evidence is never scored as zero — fail loud over fabricate.
- No optional stopping: the stopping rule is fixed before the run.

Enforced by: `pairedBootstrap` (CI), `assertCrossFamily` (panel diversity), `interRaterReliability` (agreement), and `assertRealBackend` (no stub run masquerading as a result).

## 5. Fix the class, not the instance

A drifted default is the symptom of a missing convention. The fix ships the convention and its guard alongside the one-line correction, so the same drift cannot recur silently. Patching the single dead id without adding the preflight gate leaves the class open; the next default rots the same way.

Enforced by: `assertModelsServed` wired into the campaign preflight — the guard that turns "this one model was dead" into "no campaign spends tokens against an unreachable default."
