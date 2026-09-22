# 0.184.0: installed product adoption

The new version publishes the merged typed evaluator and Jev APIs that were not in the
previously published 0.183.0 artifact. JS and Python distribution versions remain in lockstep.

`@tangle-network/agent-eval/jev/protocol` is a leaf export of the existing protocol implementation.
Products can validate native requests/responses without importing analyst/campaign execution.
Native extension metadata is preserved, not projected away; lossy non-JSON metadata is rejected
before consumers persist an apparently valid but changed observation. Already-paid receipts remain
recorded when answer validation fails.

`examples/jev-decision-benchmark.ts` compares caller-defined classifier configurations with the
existing matrix runner. It separates independent expected labels from model input, retains
abstention, records complete observations and paid failures, and groups results by configuration.
It is a recipe, not another optimizer or universal scoring policy.

Release this version through the existing verify-and-publish workflow before merging consumers
pinned to 0.184.0. A source manifest version is not evidence that the npm artifact is available.
