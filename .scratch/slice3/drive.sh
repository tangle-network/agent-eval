#!/usr/bin/env bash
# Certify the slice-3 tasks, two at a time, each waiting for its pinned image to land.
# Concurrency is held low on purpose: phase C measures a flip on byte-identical state, so
# self-inflicted load on the idle group would read as a property of the suite.
set -uo pipefail
cd /home/drew/code/agent-eval/.worktrees/certify-oracles-scale
S=/home/drew/code/agent-eval/.worktrees/certify-oracles-scale/.scratch/slice3

run_one() {
  local task=$1 waited=0
  cd /home/drew/code/agent-eval/.worktrees/certify-oracles-scale
  local s=/home/drew/code/agent-eval/.worktrees/certify-oracles-scale/.scratch/slice3
  until docker image inspect "alexgshaw/$task:20251031" >/dev/null 2>&1; do
    if [ "$waited" -ge 600 ]; then
      echo "$task IMAGE_NEVER_ARRIVED" >> "$s/status"
      return 1
    fi
    sleep 10
    waited=$((waited + 10))
  done
  benchmarks/trace-repair/tools/certify-task-oracle.sh --out "$HOME/bench-cache/certify-slice3" \
    --determinism 5 --determinism-load 3 "$task" > "$s/$task.log" 2>&1
  echo "$task done rc=$?" >> "$s/status"
}
export -f run_one

awk '{print $1}' "$S/pins.txt" | xargs -P 2 -n 1 bash -c 'run_one "$@"' _
echo ALLDONE >> "$S/status"
