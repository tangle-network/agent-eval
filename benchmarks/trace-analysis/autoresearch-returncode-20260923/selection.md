# Frozen selection before evaluation

The development cohort contains 32 independent tasks. The registered mean per-row incorrect-step F1 ranked the fixed rules as follows:

| Rule | Mean F1 | Matched / gold steps | Predicted steps | Trusted-negative false positives |
| --- | ---: | ---: | ---: | ---: |
| `all` | 0.1068 | 34 / 76 | 172 | 5 / 6 |
| `last` | 0.0391 | 5 / 76 | 31 | 5 / 6 |
| `first` | 0.0078 | 1 / 76 | 31 | 5 / 6 |

The registered winner is `all`. It is frozen for the primary and transfer cohorts, including its high false-positive rate. The predictor read 32 OTLP files and 1,036 action spans; 993 action spans had a recorded return code and 43 did not.

Selection artifacts: `predictions-selection.json` and `selection-score.json`. The prediction and checker source SHA-256 digests at freeze are `6ebb4a92af0e2bf3bacaaa21c6b949789c3b90d5858bd453115e408b6f599114` and `327c134825cb13f23d73f34e1d7d7c0b2249e72016cc61cf495ab6dbe5d0f272`.
