#!/usr/bin/env bash
# RED PROOF for fix/gate-blind-statistics.
#
# Each sabotage below removes ONE part of the fix, runs the tests, and restores
# the file from git before the next one. No environment variables, no state
# carried between steps, nothing set outside this script.
#
#   cd /home/drew/code/agent-eval-gatefix && bash probe/red.sh
#
# Requires: a clean worktree at the commit under test (the script refuses
# otherwise, so it can never silently report on someone else's edits).
set -uo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"

if [ -n "$(git status --porcelain -- src tests)" ]; then
  echo "REFUSING: src/ or tests/ is dirty; this script restores by 'git checkout HEAD --'." >&2
  git status --porcelain -- src tests >&2
  exit 2
fi

GATE=src/held-out-gate.ts
STATS=src/statistics.ts
restore() { git checkout HEAD -- "$GATE" "$STATS"; }
trap restore EXIT

EXPECT=green   # set to "red" before a sabotage; the run asserts it
run() { # run <label> <test-file> [-t filter]
  local label="$1"; shift
  echo
  echo "######## $label ########"
  local out
  out="$(pnpm exec vitest run "$@" 2>&1)"
  echo "$out" | grep -E "FAIL |AssertionError|Tests +[0-9]" | head -30
  local failed=0
  echo "$out" | grep -qE "Tests +[0-9]+ failed" && failed=1
  if [ "$EXPECT" = red ] && [ "$failed" -eq 0 ]; then
    echo "!!! EXPECTED RED, GOT GREEN — the sabotage did not bite. Recipe is stale." >&2
    exit 4
  fi
  if [ "$EXPECT" = green ] && [ "$failed" -eq 1 ]; then
    echo "!!! EXPECTED GREEN, GOT RED." >&2
    exit 5
  fi
}

# A patch whose target string is absent must ABORT, never quietly do nothing.
# Python's str.replace is a no-op on a missing needle, so a sabotage script built
# on it reports GREEN for a sabotage it never applied -- which is how this file
# briefly claimed two reds it was not producing.
patch() {
  python3 - "$@" || { echo "PATCH FAILED TO APPLY — aborting (the recipe is stale)"; exit 3; }
}

echo "baseline commit: $(git rev-parse --short HEAD)"
run "0. UNSABOTAGED — everything green" tests/held-out-gate.test.ts tests/statistics.test.ts

# ---------------------------------------------------------------- SABOTAGE 1
# Route the veto on the VALUES again (one level must be exactly 0) instead of on
# the deltas. This is precisely the round-2 architecture the round-3 adversary
# broke with an additive constant.
patch <<'PY'
import sys
def sub(s, old, new, n=-1):
    if old not in s:
        sys.exit("target not found: " + old[:80])
    return s.replace(old, new) if n < 0 else s.replace(old, new, n)
p = 'src/held-out-gate.ts'
s = open(p).read()
s = sub(s,
  "    const signFlipVetoes = this.pairedDeltaThreshold >= 0 && !(signFlip.pValueUpperBound < alpha)",
  "    const signFlipVetoes =\n"
  "      pairedBinaryScale(beforeHoldout, afterHoldout) !== null &&\n"
  "      this.pairedDeltaThreshold >= 0 &&\n"
  "      !(signFlip.pValueUpperBound < alpha)")
s = sub(s, "  pairedBootstrap,\n", "  pairedBinaryScale,\n  pairedBootstrap,\n", 1)
open(p, 'w').write(s)
PY
EXPECT=red
run "1. VETO ROUTED ON VALUES (needs a zero present) — the round-3 break" tests/held-out-gate.test.ts
restore
EXPECT=green

# ---------------------------------------------------------------- SABOTAGE 2
# Delete the veto entirely: the interval decides alone, as it did in round 2 on
# every shape that was not two-point.
patch <<'PY'
import sys
p = 'src/held-out-gate.ts'
s = open(p).read()
old = "    const signFlipVetoes = this.pairedDeltaThreshold >= 0 && !(signFlip.pValueUpperBound < alpha)"
if old not in s:
    sys.exit("target not found: signFlipVetoes")
s = s.replace(old, "    const signFlipVetoes = false")
open(p, 'w').write(s)
PY
EXPECT=red
run "2. NO SIGN-FLIP VETO — the interval decides alone" tests/held-out-gate.test.ts
restore
EXPECT=green

# ---------------------------------------------------------------- SABOTAGE 3
# Fail closed only at [0,0], the one-field-short rule.
patch <<'PY'
import sys
p = 'src/held-out-gate.ts'
s = open(p).read()
old = ("      !(deltaSpread > PAIRED_DELTA_TIE_EPSILON) ||\n"
       "      !Number.isFinite(low) ||\n"
       "      !Number.isFinite(high) ||\n"
       "      !(high > low)")
if old not in s:
    sys.exit("target not found: fail-closed condition")
s = s.replace(old, "      !Number.isFinite(low) ||\n      !Number.isFinite(high) ||\n      (low === 0 && high === 0)")
open(p, 'w').write(s)
PY
EXPECT=red
run "3. FAIL CLOSED ONLY AT ZERO — degenerate-anywhere walks through" tests/held-out-gate.test.ts
restore
EXPECT=green

# ---------------------------------------------------------------- SABOTAGE 4
# Drop the empirical-likelihood interval, leaving the percentile bootstrap: the
# nonzero-margin calibration is what this buys.
patch <<'PY'
import sys
p = 'src/held-out-gate.ts'
s = open(p).read()
old = "      const el = empiricalLikelihoodMeanInterval(deltas, this.confidence)"
if old not in s:
    sys.exit("target not found: empirical-likelihood call")
s = s.replace(old, "      const el = { low: null as number | null, high: null as number | null }")
open(p, 'w').write(s)
PY
EXPECT=red
run "4. BOOTSTRAP ONLY — nonzero-margin calibration lost" tests/held-out-gate.test.ts
restore
EXPECT=green

# ---------------------------------------------------------------- SABOTAGE 5
# Decide on the exact CONDITIONAL interval at a nonzero margin (the PR #457
# review's finding), by widening the empirical-likelihood interval out of the way.
patch <<'PY'
import sys
p = 'src/statistics.ts'
s = open(p).read()
old = "  return { low: boundary(min), high: boundary(max), confidence }"
if old not in s:
    sys.exit("target not found: empirical-likelihood return")
s = s.replace(old, "  return { low: min, high: max, confidence }")
open(p, 'w').write(s)
PY
EXPECT=red
run "5. EMPIRICAL LIKELIHOOD NEUTERED to the data range" tests/held-out-gate.test.ts tests/statistics.test.ts
restore
EXPECT=green

# ---------------------------------------------------------------- SABOTAGE 6
# The whole gate reverted to origin/main.
git fetch -q origin main
git show origin/main:src/held-out-gate.ts > "$GATE"
EXPECT=red
run "6. GATE REVERTED TO origin/main" tests/held-out-gate.test.ts
restore

echo
echo "######## RESTORED ########"
echo "worktree diff vs HEAD (must be empty):"
git status --porcelain -- src tests || true
EXPECT=green
run "7. RESTORED — green again" tests/held-out-gate.test.ts tests/statistics.test.ts
echo
echo "NOTE: the FULL suite is not run here. 58 of its 304 files reach OTel"
echo "receivers and other local services, so under a stripped environment they"
echo "fail for reasons that have nothing to do with this change. Run"
echo "  pnpm exec vitest run"
echo "in your normal shell for the whole-suite number."
