# See The Grid Before You Pay For It

## When to use this

Use this example when a run costs real money and you must know what it will execute first.
A campaign runs one cell per case per replicate.
`planCampaignRun()` reports the state of every cell without dispatching anything.

Use it also when a run failed partway and you must decide what to rerun.

## How to run it

```sh
pnpm tsx examples/plan-before-you-spend/index.ts
```

No API key is required.
The example writes its cache into a temporary directory.

## What it does

1. `planCampaignRun()` prints the cell schedule before any work starts.
   Every cell reports `run`, because nothing is cached yet.
2. `runCampaign()` executes the same grid and caches each completed cell.
3. `planCampaignRun()` runs again. Every cell now reports `cached`.

A cell reports one of three states:

| Status | Meaning |
|---|---|
| `run` | The cell must execute. It has no valid cached result. |
| `cached` | A valid cached result exists. The cell will not execute again. |
| `blocked` | A cached file exists but is unreadable or has untrustworthy cost data. |

Set `rerunInvalidCachedCells: true` to turn every blocked cell into a `run` cell and keep the valid cached ones.
Set `resumable: false` only when you intend to rerun the whole grid.

## Why it is built this way

`runCampaign()` refuses to start when a cached file is unreadable or lacks trustworthy cost data.
That check covers the whole schedule before concurrent work begins, so one bad cache file cannot waste the paid calls of earlier cells.

`abortOnCellError: true` stops the campaign on the first failed cell.
The failed cell writes `<runDir>/<cell>/failure-receipt.json` first.
That file holds the original error, the cell result, the exact call ids, and the settled agent-plus-judge cost and token totals.
Active sibling cells are cancelled and are allowed to record their own receipts before the campaign rejects.
Leave the option unset to record the error and continue the remaining cases.

Two settings must match between the two calls: `costLedger` and `costTags`.
Both calls read the same receipts, so different values make the plan describe a different run.

## Next

- Run the same grid across models and profiles: [`profile-matrix`](../profile-matrix/).
- Let a candidate generator drive the grid: [`selfimprove-quickstart`](../selfimprove-quickstart/).
