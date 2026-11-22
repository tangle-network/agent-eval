# Optimize A Multi-Turn Agent

A conversation between a simulated user and an agent is an optimization and comparison target like any other surface.
`multishotRollout()` from `/multishot` runs one conversation per campaign cell on the existing conversation engine, so `selfImprove()` and `compareOptimizationMethods()` search and gate the agent side over multi-turn rollouts.
The simulated user is part of the measurement: it is held fixed across candidates, and it can be measured against real users.
Runnable version: [`examples/multi-turn-optimization`](../examples/multi-turn-optimization/).

## Run a conversation as the dispatch

```ts
import {
  conversationGate,
  conversationJudge,
  describeConversation,
  multishotRollout,
} from '@tangle-network/agent-eval/multishot'
import { selfImprove } from '@tangle-network/agent-eval/contract'

const conversation = multishotRollout<RefundScenario>({
  agent: { model: AGENT_MODEL, transport: agentTransport },
  user: { model: USER_MODEL, transport: userTransport, rigor: 'demanding' },
  maxTurns: 6,
  outcome: (record, scenario) => refundOutcome(record.transcript, scenario.persona),
})

const result = await selfImprove({
  agent: conversation.agent,
  dispatchRef: conversation.dispatchRef,
  scenarios,
  judge: conversationJudge(),
  gate: conversationGate(),
  describeArtifact: describeConversation,
  baselineSurface: 'You are the support desk.',
  method: gepa,
  budget: { holdoutScenarios },
})
```

| Piece | What it does |
|---|---|
| `agent` | The candidate surface becomes the agent's profile (a text surface is its system prompt; pass `profile` for other surfaces). Every leg is a paid call through the cell's `ctx.cost`: the agent on the `agent` channel, the simulated user on `driver`, and each call carries the cell seed. |
| `outcome` | Code decides whether the conversation reached its goal. It is the objective part of the score. |
| Ending | The simulated user ends with `[[signed-off]]` or `[[gave-up]]` (`DEFAULT_USER_ENDING`), or the conversation reaches `maxTurns`. The marker is removed from the transcript. |
| `ConversationArtifact` | Transcript, tool artifacts, ending, outcome, the first pushback turn, the simulated-user identity and the seed. |
| `conversationJudge()` | Composite 0 when the outcome failed, else 1, or a semantic judge's [0, 1] composite. |
| `describeConversation` | The one evidence object both the native proposer and GEPA receive: outcome, ending, agent turns, first pushback turn, and the transcript's head and tail. Its JSON stays within the evidence bound, so neither path cuts it. |

## Compare under the same simulated user

Agent success moves with the user model as well as the agent, so a comparison holds the user fixed.

- The simulated user is built from the scenario and the rollout's fixed options only. The candidate surface never reaches its prompt, opener or description of the agent.
- `SimulatedUserIdentity` digests the user model, fallbacks, rigor, persona, prompt, opener and ending protocol. `dispatchRef` hashes the same options, so caches and premeasured baselines never cross users.
- `conversationGate()` refuses with `SimulatedUserMismatchError` when any paired held-out conversation met a different user, ran on a different seed, or carries no identity. Outside the gate, call `assertSameSimulatedUser(baselineCells, candidateCells)`.

## Report reliability across repeats

Mean success hides a conversation that resolves the user's problem on some seeds only.
Run the scenarios with `reps: k` and read `repeatReliability(cells, { k, success })` from `/campaign`: per scenario and overall, pass^k (success in all k repeats, `passHatK` from `/statistics`) beside mean success, with each independent unit weighted equally.
A dispatch or judge failure is counted in `failedCells`, never as an agent failure.

## Measure the simulated user against real users

`measureSimulatorRealism()` asks how often a judge tells the simulator's message from a real user's at the same point of a real conversation.

1. `recordedUserTurns(trajectory, run)` reads each real user turn and the visible context before it from a recorded trace. A run whose scenario id names its task gets a `contextDigest` over the task and context; one without a task identity gets none.
2. The driver writes the next message from that context. `simulatedUserDriver()` runs the exact prompt, point of view and model rotation a rollout uses.
3. `simulatorRealismJudge()` is a System One decision point at the turn layer. It sees the context and both messages, in both orders, and picks the one the real user wrote. Its calibration must reach `DECISION_POINT_MIN_KAPPA` and carry the `questionDigest` of this exact question and served model; otherwise every judgment is recorded as uncalibrated. Build that digest with `decisionQuestionDigest` from `/systemone` over `SIMULATOR_REALISM_QUESTIONS.real`, the text the judge asks, so a calibration set labelled under other wording cannot certify it.

Accuracy is reported per independent conversation with a cluster bootstrap interval. 50% means the judge cannot tell the simulator from real users.
A row without a context digest, or with a digest its context does not match, is refused with `SharedContextIdentityError` before any driver call.

## Optimize the user side

`improveAdversarialUser()` searches for a simulated-user plan that makes a fixed agent fail.

- Its objective is the agent's failure rate. It builds that judge itself and refuses a caller `judge` or `gate`; `conversationJudge()` refuses every conversation whose user side was the candidate, both with `UserSideObjectiveError`.
- A plan is admitted only when a calibrated realism judge's accuracy, at the upper end of its interval, stays at or below `realism.maxJudgeAccuracy`.
- An admitted plan's failing held-out conversations become `trainScenarios` with the plan as `userPlan` and `origin.kind: 'adversarial-user'`. `conversationGate()` refuses them in a held-out split with `AdversarialScenarioInHeldOutError`; for other comparisons call `assertHeldOutExcludesAdversarial()`.
- Scenarios that share an id or persona with the agent's held-out split are refused with `AdversarialSplitError`.
