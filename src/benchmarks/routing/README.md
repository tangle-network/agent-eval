# Routing benchmark

Synthetic, dependency-free, ships in the package. 16 items across four
intent categories: `file`, `math`, `search`, `chat`. Used as a smoke
test for any router that maps a natural-language request onto a fixed
route label.

## Item format

Every item in `dataset.ts` has six fields:

| Field | Type | Notes |
|---|---|---|
| `id` | string | Stable per-task ID. Used for deterministic split assignment. |
| `category` | `'file' \| 'math' \| 'search' \| 'chat'` | Coarse intent. |
| `prompt` | string | The user-facing request the router must classify. |
| `route` | string | Canonical correct route label, format `category.action`. |
| `synonyms` | string[] | Alternate route labels that count as correct. |
| `hardNegatives` | string[] | Wrong-but-tempting labels (analysis only). |

## Splits

`assignSplit(itemId)` is deterministic: 60% search / 20% dev / 20% holdout
via FNV-1a hash with seed `agent-eval-v1`. The split breakdown is fixed
across processes and platforms; bumping the seed is a breaking change.

## Grading

`evaluate` does case-insensitive exact match between the first
`category.action`-shaped token in the response and the canonical
route + synonyms. Hard negatives are reported in `raw` for analysis
but do NOT change the score: the grader is binary by design.

## Why ship a synthetic dataset

Routing is the only one of the three reference benchmarks where we
ship the data. GSM8K and SWE-Bench Lite require external sources by
license; the routing tasks here exist to make the other paper
machinery (split assignment, RunRecord shape, HeldOutGate) testable
end-to-end without configuring external state.
