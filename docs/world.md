# Simulated worlds with a clock

`@tangle-network/agent-eval/world` runs an agent through many sessions of a simulated world whose clock the test controls.
What the agent does in one session pays off, or costs, days later, and the episode is scored on how the world ends and on the log of what the agent did.

Use it when the behavior you care about only shows over time: waiting for evidence, planning to a deadline, not repeating an action that looks good this week and hurts next month.
A single-turn case or a multi-turn conversation cannot show these, because nothing in them arrives late.

## The pieces

| Piece | What it is | Source |
|---|---|---|
| Scenario | Data. A public half (brief, budget, horizon, levers with stated guidelines) and a hidden `key` (what each lever really returns, when, and how noisily). | [`types.ts`](../src/world/types.ts) |
| World | The clock, the budget and the levers. `advance(days)` is the only thing that moves time. | [`world.ts`](../src/world/world.ts) |
| Tools | `status`, `results`, `set_rate`, `spend_once`, `request_approval`, `save_note`. Built from the public half only. | [`tools.ts`](../src/world/tools.ts) |
| Driver | `runWorldEpisode()` opens one session per `sessionEveryDays` and advances the clock between them. | [`episode.ts`](../src/world/episode.ts) |
| Score | End value, refused calls, premature decisions, and each action's cost by replay. | [`score.ts`](../src/world/score.ts) |
| Scripted policies | Do-nothing, random, set-and-hold, impulsive, patient and a key-reading reference. | [`policies.ts`](../src/world/policies.ts) |
| Model-backed agent | `chatWorldAgent()` plays each session as a tool loop on a `ChatClient`. | [`chat-agent.ts`](../src/world/chat-agent.ts) |

## How a lever behaves

A lever takes a daily spend and returns outcomes later. The key sets five things about it:

- **Delay.** Each outcome lands some days after the spend that caused it. `results` counts an outcome in the period it landed in.
- **Noise.** A lever's yield is multiplied by a mean-one lognormal shock each week, and daily counts are Poisson draws.
- **Ramp.** A lever reaches full yield after a run of consecutive spend days; a day without spend starts the run over.
- **Saturation.** Spend above a daily rate earns a fraction of the yield.
- **Wear.** Spend above a weekly load lowers the lever's health, which multiplies every later outcome and recovers slowly.

A lever marked `requiresApproval` refuses spend that no granted approval covers. An approval is requested through a tool and decided `approvalDelayDays` later, so an agent has to ask before it needs the answer.

Every random draw comes from a stream named by seed, lever and day. A day of spend returns the same outcomes however often the agent reads the state, and two agents on one seed meet the same luck.

## What crosses between sessions

A session receives the brief, the date, the tools and the notes the agent saved with `save_note` in earlier sessions.
The driver carries nothing else: no transcript, no tool results, no summary.
An agent that keeps its own store outside the world, such as a product's workspace files, is carrying that itself; say so when you report its result.

## Scoring

The end value is the budget left plus the value of every outcome landed before the horizon. Doing nothing scores the starting budget exactly, which makes it the zero every policy is read against.

The decision log adds:

- `refused`: calls the world refused, by reason. `approval_missing` is an attempted spend with no recorded approval.
- `prematureDecisions`: kills and scale-ups made before the scenario's evidence rule was met. The rule is in the key: a decision is supported once enough outcomes have landed, or once the lever's matured spend is large enough that a break-even lever would have landed that many.
- `overdriveDays` and `lateValue`: days spent above a wear threshold, and the value of outcomes paid for that landed after the horizon.

An episode re-derives from its log: `replayWorld(scenario, seed, worldActions(episode.log))` returns the recorded end state, so a stored result can be checked without the agent.

`worldDecisionCosts()` prices each accepted action by replaying the episode without it and every other action held fixed. `realizedCost` is that difference on the episode's own seed, so it includes luck. `expectedCost` averages it over fresh noise seeds; read that one.

## Check a scenario before you pay for a model

A scenario claims to reward some behavior. Prove it with scripted policies first: `compareWorldPolicies()` runs every policy on every seed and tests each contrast on the per-seed differences.
A contrast is `beyondNoise` when the better policy ended higher on every seed and its mean lead is more than twice the larger of the two policies' standard deviations across seeds.

If the patient policy does not beat the impulsive one beyond noise, the scenario is wrong. Change the scenario; never tune the baseline until it loses.
Include a policy that starts and never changes anything. A scenario where patience cannot beat that one only rewards sitting still.
Then remove one habit at a time from the winning policy with `evidencePolicy()`; a habit whose removal costs nothing is one the scenario does not test.

## The launch-quarter scenario

[`launchQuarterScenario`](../src/world/launch-quarter.ts) is a 91-day product launch reviewed weekly, with a budget and five channels.
Its file states what it is built to punish. On seeds 1 to 10 the patient policy ends well above the impulsive one on every seed; run [the example](../examples/world-launch-quarter/) for the current table.

An ablation of the patient policy shows what this scenario rewards and what it does not. Reading results against the spend old enough to have landed, staying inside the stated guidelines and stopping spend that cannot land in time carry almost all of the gap. Requiring statistical confidence before acting, and moving in small steps, add little here.

## Running a model

```ts
import { createChatClient } from '@tangle-network/agent-eval'
import {
  chatWorldAgent,
  launchQuarterScenario,
  runWorldEpisode,
  worldDecisionCosts,
} from '@tangle-network/agent-eval/world'

const agent = chatWorldAgent({
  client: createChatClient({ transport: 'openai-compatible', baseUrl, apiKey, defaultModel }),
  systemPrompt, // the agent under test's own prompt
})
const episode = await runWorldEpisode({ scenario: launchQuarterScenario, seed: 1, agent })
const costs = worldDecisionCosts(launchQuarterScenario, episode)
```

To bind a product's own tools instead, write a `WorldAgent` that runs the product's turn and routes the tools that touch the outside, such as sends, posts, analytics reads and the calendar, to `session.call()`.
`worldSessionPrompt(session)` is the message `chatWorldAgent` opens each session with; pass `sessionPrompt` to wrap it in a product's own per-turn context.

A chat model sometimes returns neither words nor a tool call; a reasoning model does it whenever `maxTokens` is smaller than its thinking, so leave the cap unset or give it room. `chatWorldAgent` asks again rather than ending the review, and the transcript's `responses` and `ended: 'empty'` keep every such completion visible, so a provider hiccup is not scored as the agent choosing to do nothing.
A product turn that runs in another process takes `World.snapshot()` and `World.restore()`.

One episode is one draw. Read a model's end value against the scripted rows on the same seed, and repeat seeds before claiming a difference between two models; `passHatK` in `/statistics` reports success in all k repeats.

## What other benchmarks measure that this does not

- [Vending-Bench 2](https://andonlabs.com/evals/vending-bench-2) runs a vending business for a simulated year and scores the bank balance. Its suppliers are other language models that negotiate and can be adversarial, the agent searches the open web, a run produces tens of millions of output tokens under a trimmed context, and the agent's own token cost is charged against its score. This package's counterparties are equations, its action space is a fixed tool list, and a 13-session episode is short.
- [τ-bench](https://arxiv.org/abs/2406.12045) checks the final database state of a single tool-using conversation with a model-simulated user, and reports pass^k: the chance that all k trials of a task succeed. It measures policy adherence in dialogue and reliability across repeats. This package has no simulated user; τ-bench has no clock and no delayed consequence.

What this package adds to both: a seeded, replayable world, scripted policies that must rank before a model runs, floors and a key-reading reference on every table, and a per-decision cost.
