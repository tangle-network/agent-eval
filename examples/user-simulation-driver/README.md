# User-simulation driver

`decideNextUserTurn`: the reactive turn-generator behind `AgentDriver`,
exposed standalone so any harness can drive a simulated multi-turn
conversation against an in-process agent.

The driver is the **user side** of an agent eval: an LLM persona that
interrogates the product agent until either its `completionCriteria` are
met or `maxTurns` is reached. It signals completion with the literal
`DONE` token.

This example wires it offline with `createChatClient({ transport: 'mock' })`.
Use the `router`, `cli-bridge`, `direct-provider`, or `sandbox-sdk` transport
for a real model.

In a real eval harness:

- The "agent reply" comes from your product (a `runAgentTaskStream`
  call, a `DurableChatTurnEngine.runTurn` call, an HTTP `ProductClient`).
- `DriverState` is kept up to date from product side effects
  (`tasks`, `events`, `proposals`, `vaultFiles`, …).
- `persona.completionCriteria` is what the driver checks before issuing
  `DONE`.

```bash
pnpm tsx examples/user-simulation-driver/index.ts
```
