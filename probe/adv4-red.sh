#!/usr/bin/env bash
# ROUND-4 ADVERSARY REPRO. Read-only: generates probe/gate-main.ts (the file
# probe/setup-main-gate.sh already owns) and runs five probes. Touches no
# tracked file, sabotages nothing, restores nothing.
#
#   cd /home/drew/code/agent-eval-gatefix && bash probe/adv4-red.sh
#
# Every step must print output. A step that prints nothing is a broken run,
# not a pass — which is the failure mode probe/red.sh has (see step 0 below).
set -uo pipefail
cd "$(dirname "$0")/.."

fail=0
step() {
  echo
  echo "======== $1 ========"
  shift
  local out
  out="$("$@" 2>&1)"
  if [ -z "$out" ]; then
    echo "!!! STEP PRODUCED NO OUTPUT — treat as FAILED, not as passed" >&2
    fail=1
    return
  fi
  echo "$out"
}

echo "worktree: $PWD"
echo "HEAD:     $(git rev-parse HEAD)"
echo "dirty tracked files (must be empty):"
git status --porcelain -- src tests

bash probe/setup-main-gate.sh

step "0. probe/red.sh cannot fail in a stripped shell" bash -c '
  env -i bash -c "cd $PWD && bash probe/red.sh" > /tmp/adv4-redsh-envi.log 2>&1
  echo "env -i bash probe/red.sh  EXIT=$?   (the report claims 0)"
  head -6 /tmp/adv4-redsh-envi.log
  echo "-- why: the runner decides red/green by grepping vitest stdout --"
  env -i bash -c "cd $PWD && pnpm exec vitest run tests/held-out-gate.test.ts" 2>&1 | head -2
'

step "1. unanimous improvement refused; ONE tied pair flips it" pnpm exec tsx probe/adv4-unanimous.mts
step "2. the shipped tie-padding invariant, on bases its test omits" pnpm exec tsx probe/adv4-tie-padding.mts
step "3. items the candidate never answered are dropped" pnpm exec tsx probe/adv4-dropped-pairs.mts
step "4. deltaStatistic:'median' is blinder, not stricter" pnpm exec tsx probe/adv4-median-hatch.mts
step "5. malformed config is accepted, not refused" pnpm exec tsx probe/adv4-malformed-config.mts
step "6. n=3 non-inferiority boundary, exact enumeration" pnpm exec tsx probe/adv4-n3-boundary.mts
# slow (~12 min): searches for a dataset whose binding bound is the UNSEEDED
# percentile bootstrap, then evaluates it 500x on the shipped default config.
step "7. the default config is not deterministic" pnpm exec tsx probe/adv4-nondeterminism.mts

echo
echo "======== dirty tracked files after (must be empty) ========"
git status --porcelain -- src tests
echo "ADV4 EXIT=$fail"
exit $fail
