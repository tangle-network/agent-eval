# Knowledge Readiness

`agent-eval` owns the contract for deciding whether an agent had enough
task-world context to run. It does not own web crawling, connector storage, wiki
pages, credentials, or product policy. Those live in
`@tangle-network/agent-knowledge` and product repos.

The core loop is:

```txt
Know -> Act -> Evaluate -> Learn -> Optimize
```

Use `KnowledgeRequirement` to declare required context, `scoreKnowledgeReadiness`
to produce a `KnowledgeReadinessReport`, and `blockingKnowledgeEval` to make the
report a normal control-runtime validator.

```ts
import {
  blockingKnowledgeEval,
  runAgentControlLoop,
  scoreKnowledgeReadiness,
} from '@tangle-network/agent-eval'

await runAgentControlLoop({
  intent: 'Implement the SDK migration',
  async observe() {
    const knowledge = scoreKnowledgeReadiness({
      taskId: 'sdk-migration',
      requirements: [{
        id: 'repo-build-command',
        description: 'Repository build and typecheck command',
        requiredFor: ['coding'],
        category: 'codebase_specific',
        acquisitionMode: 'inspect_repo',
        importance: 'blocking',
        freshness: 'weekly',
        sensitivity: 'public',
        confidenceNeeded: 0.9,
        currentConfidence: 0.2,
        evidenceIds: [],
        fallbackPolicy: 'block',
      }],
    })
    return { knowledge }
  },
  async validate({ state }) {
    return [blockingKnowledgeEval(state.knowledge)]
  },
  async decide({ evals, state }) {
    if (!evals.find((e) => e.id === 'knowledge-ready')?.passed) {
      return {
        type: 'stop',
        pass: false,
        reason: `Collect knowledge first: ${state.knowledge.recommendedAction}`,
      }
    }
    return { type: 'stop', pass: true, reason: 'ready' }
  },
  act() {
    return null
  },
})
```

Knowledge-related failures use the normal failure taxonomy:

- `knowledge_readiness_blocked`
- `missing_user_data`
- `missing_domain_data`
- `missing_codebase_context`
- `missing_runtime_context`
- `missing_credentials`
- `stale_external_data`
- `bad_retrieval`
- `insufficient_evidence`
- `contradictory_evidence`
- `ambiguous_user_intent`

For optimization, scorers should use responsible surfaces such as
`knowledge-requirements`, `data-acquisition`, `retrieval-policy`, and
`user-question-policy` in actionable side information. That lets GEPA-style
loops improve data acquisition and retrieval policy instead of blaming every
failure on the prompt.
