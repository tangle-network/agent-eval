#!/usr/bin/env bash
# Materialise origin/main's HeldOutGate as probe/gate-main.ts so the measurement
# probes can run published 0.125.0, origin/main and this branch side by side in
# one process. Regenerate whenever main moves; the file is deliberately not
# committed, because a checked-in copy of another branch's source goes stale
# silently and that is the whole failure mode this directory exists to expose.
set -euo pipefail
cd "$(dirname "$0")/.."
git fetch -q origin main
git show origin/main:src/held-out-gate.ts \
  | sed -e "s#from './paired-arms'#from '../src/paired-arms'#" \
        -e "s#from './rollout/reward'#from '../src/rollout/reward'#" \
        -e "s#from './run-record'#from '../src/run-record'#" \
        -e "s#from './statistics'#from '../src/statistics'#" \
  > probe/gate-main.ts
echo "wrote probe/gate-main.ts from $(git rev-parse --short origin/main)"
