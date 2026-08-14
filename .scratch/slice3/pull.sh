#!/usr/bin/env bash
# Pull each slice-3 task image by its pinned manifest digest, then apply the published tag
# the certifier resolves. Never build: a local build drifts from the published bits.
set -uo pipefail
S=/home/drew/code/agent-eval/.worktrees/certify-oracles-scale/.scratch/slice3

pull_one() {
  local task=$1 repo=$2 digest=$3 tag=$4
  local s=/home/drew/code/agent-eval/.worktrees/certify-oracles-scale/.scratch/slice3
  if docker image inspect "$repo:$tag" >/dev/null 2>&1; then
    echo "$task present" >> "$s/pulls"
    return 0
  fi
  if docker pull -q "$repo@$digest" >/dev/null 2>&1; then
    docker tag "$repo@$digest" "$repo:$tag" && echo "$task pulled" >> "$s/pulls"
  else
    echo "$task PULL_FAILED" >> "$s/pulls"
  fi
}
export -f pull_one

xargs -a "$S/pins.txt" -P 3 -n 4 bash -c 'pull_one "$@"' _
echo PULLS_DONE >> "$S/pulls"
