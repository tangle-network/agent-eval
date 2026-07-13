# Campaign Proposers, ELI5

A campaign proposer is the part of an improvement loop that says: "try this
candidate next."

It does not run your agent. It does not score anything. It only proposes a new
surface to measure. A surface is the thing you are changing: a prompt string, a
serialized config string, or a code/worktree surface.

Use **proposer** for this role. Older optimizer APIs used "driver"; that word is
now reserved for execution, sandbox, and router agents that actually drive
workers.

## The Loop

```text
current surface
  -> proposer suggests candidate surfaces
  -> runCampaign runs each candidate on scenarios
  -> judges score the artifacts
  -> runOptimization picks the best candidate
  -> runImprovementLoop re-scores on holdout and gates release
```

## Proposer Input

Every `SurfaceProposer.propose(ctx)` receives:

| Field | Plain meaning |
|---|---|
| `currentSurface` | The prompt/config/code surface currently being improved. |
| `history` | What candidates were tried before and how they scored. |
| `findings` | Failure analysis or analyst findings from traces/eval runs. |
| `populationSize` | How many candidates the loop asks for this generation. |
| `generation` | Which generation number this is. |
| `signal` | Abort signal for cancellation. |
| `report` | Optional larger analysis report. |
| `dataset` | Optional labeled scenario store. |
| `paretoParents` | Optional non-dominated surfaces from prior generations. |

## Proposer Output

A proposer returns candidates:

```ts
{
  surface: 'the full new prompt or config',
  label: 'short name',
  rationale: 'why this change should help'
}
```

Bare surfaces are still accepted, but `label` and `rationale` make results
auditable, so new proposers should return `ProposedCandidate`.

## Which Proposer To Use

| Proposer factory | Best when | Output surface |
|---|---|---|
| `gepaProposer` | You want a strong prompt rewrite driven by prior scores and findings. | prompt string |
| `skillOptProposer` | You are editing a structured skill/runbook and want anchored small patches. | prompt/skill string |
| `aceProposer` | You want append-only lessons from findings, preserving every distinct lesson. | prompt/playbook string |
| `memoryCurationProposer` | You want compact deduped lessons from findings. | prompt/playbook string |
| `parameterSweepProposer` | You want FAPO-style config/parameter edits from a JSON config surface. | JSON string |
| `fapoProposer` | You want the FAPO policy: prompt first, then parameter, then structural only when evidence supports escalation. | whatever its level proposer returns |

## FAPO Proposer

FAPO is not "another prompt mutator." The paper describes a reviewed escalation
policy:

1. evaluate the current workflow,
2. attribute failures to prompt, parameter/config, or structure,
3. propose one scoped change,
4. review the change for scope/leakage/compatibility,
5. measure it,
6. keep moving or escalate only when the cheaper level is exhausted.

The simplest useful setup is prompt plus JSON config. Structural/code edits are
optional and should be injected by the app or runtime layer.

```ts
import {
  fapoProposer,
  gepaProposer,
  parameterSweepProposer,
  runImprovementLoop,
} from '@tangle-network/agent-eval/campaign'

const proposer = fapoProposer({
  scope: { allowedLevels: ['prompt', 'parameter'] },
  promptProposer: gepaProposer({ llm, model, target: 'agent prompt' }),
  parameterProposer: parameterSweepProposer({
    candidates: [
      {
        label: 'raise-retrieval-k',
        rationale: 'retrieval misses indicate the search budget may be too low',
        changes: [{ path: 'retrieval.k', value: 10 }],
      },
    ],
  }),
})

await runImprovementLoop({
  scenarios: trainScenarios,
  holdoutScenarios,
  baselineSurface: JSON.stringify(currentConfig),
  dispatchWithSurface,
  judges,
  proposer,
  gate,
  autoOnPromote: 'none',
  runDir,
  populationSize: 1,
  maxGenerations: 10,
})
```

If you do have a real code/worktree proposer, pass it as `structuralProposer`.
`agent-eval` intentionally does not provide that proposer because this package
measures candidates; the runtime or app owns code generation.

For side-by-side experiments with existing proposers, use the compare entry:

```ts
import {
  compareProposers,
  fapoEscalationEntry,
  gepaParetoEntry,
} from '@tangle-network/agent-eval/campaign'

await compareProposers({
  proposers: [
    gepaParetoEntry(config),
    fapoEscalationEntry({
      ...config,
      parameterCandidates: [
        {
          label: 'raise-retrieval-k',
          rationale: 'retrieval misses indicate the search budget may be too low',
          changes: [{ path: 'retrieval.k', value: 10 }],
        },
      ],
    }),
  ],
  baselineSurface,
  trainScenarios,
  selectionScenarios,
  testScenarios,
  dispatchWithSurface,
  judges,
  runDir,
})
```

`compareProposers` owns all three partitions.
It passes only train and selection to each entry, where selection may drive acceptance or early stopping.
It keeps test unreachable until every optimizer has returned a winner, then uses only test for lift intervals and final ranking.
All three partitions must be non-empty and pairwise disjoint by scenario ID.

## Common Mistakes

- Do not put eval logic inside a proposer. Put it in `dispatch` and `judges`.
- Do not let a proposer read untouched test rows or scores.
  `compareProposers` omits them from `ProposerOptimizationData` by construction.
- Do not call FAPO a prompt-only optimizer. Its main value is evidence-based
  escalation beyond prompt edits.
- Do not put Claude Code or sandbox-specific code in `agent-eval`. Structural
  code generation should be supplied as an injected `SurfaceProposer` from the
  runtime/app layer.

## Simpler Mental Model

Use this sentence when wiring a loop:

> The proposer chooses candidates; the campaign measures them; the gate decides
> whether the measured winner is safe to promote.
