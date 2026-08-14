#!/usr/bin/env bash
set -u
cd /home/drew/code/agent-eval/.worktrees/certify-oracles-scale
LOCK=benchmarks/trace-repair/tb-images.lock.json
OUT=.scratch/slice4b
mkdir -p "$OUT/pull"
for task in "$@"; do
(
  dig=$(python3 -c "import json;print(json.load(open('$LOCK'))['images']['$task']['digest'])")
  ref="alexgshaw/$task@$dig"
  if docker image inspect "alexgshaw/$task:20251031" >/dev/null 2>&1; then
    echo "$task ALREADY_LOCAL"; touch "$OUT/pull/$task.done"; exit 0
  fi
  if docker pull "$ref" >"$OUT/pull/$task.log" 2>&1; then
    docker tag "$ref" "alexgshaw/$task:20251031" && touch "$OUT/pull/$task.done"
    echo "$task PULLED $dig"
  else
    echo "$task PULL_FAILED"; touch "$OUT/pull/$task.failed"
  fi
) &
done
wait
touch "$OUT/pull/ALLDONE"
echo PULL_PHASE_EXIT
